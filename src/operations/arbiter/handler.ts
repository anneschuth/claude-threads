/**
 * Arbiter — session completion watchdog.
 *
 * Hooks (wired in events/handler.ts and session/lifecycle.ts):
 * - extractObligations(): fire-and-forget on every user message; keeps the
 *   session's delivery-obligation ledger up to date via a Haiku quick query
 *   (new obligations get added, cancelled ones dropped).
 * - noteEvent(): synchronous bookkeeping on the event stream — records
 *   delivery tool calls (fulfills matching obligations) and remembers the
 *   turn's final assistant text for the stall check.
 * - onTurnComplete(): fire-and-forget on each `result` event — reminds the
 *   agent about unmet delivery obligations (deterministic), otherwise runs
 *   the stall check and nudges the agent to continue when it merely asked
 *   for permission to keep going.
 *
 * All LLM checks are out-of-band Haiku calls (same mechanism as title/tag
 * suggestions) and every intervention is capped to avoid ping loops.
 */

import { quickQuery } from '../../claude/quick-query.js';
import { createLogger } from '../../utils/logger.js';
import { createSessionLog } from '../../utils/session-log.js';
import { post } from '../post-helpers/index.js';
import type { Session } from '../../session/types.js';
import type { SessionContext } from '../session-context/index.js';
import type { ClaudeEvent } from '../../claude/cli.js';
import { noteWaiting } from './waiting.js';
import { findReturnAddressUrl } from '../return-address/parser.js';
import {
  createArbiterState,
  type ArbiterObligation,
  type ArbiterSessionState,
  type DeliveryKind,
  type StallVerdict,
} from './types.js';

const log = createLogger('arbiter');
const sessionLog = createSessionLog(log);

/** Max reminders per delivery obligation before giving up and telling the humans */
export const MAX_DELIVERY_REMINDERS = 2;

/** Max continuation nudges per session before leaving the agent alone */
export const MAX_CONTINUATION_NUDGES = 3;

/** Timeout for arbiter quick queries (ms) */
const ARBITER_QUERY_TIMEOUT = 15000;

/** Tail of the final assistant message fed to the stall check */
const MAX_LAST_TEXT_LENGTH = 1500;

/** Max user-message length fed to the extraction prompt */
const MAX_MESSAGE_LENGTH = 2000;

/**
 * Tool-name patterns that count as an external delivery, matched against the
 * SHORT tool name of any MCP server (mcp__<server>__<tool>) or a bare tool
 * name. Deployments wire different chat MCPs (claude-threads send_dm,
 * a Mattermost server's post_message, ...) — a delivery through ANY of
 * them must count, otherwise the arbiter nags about work that is already done.
 */
/**
 * `send_to_teammate` is first on purpose: it is the ONLY cross-bot delivery the
 * prompts sanction, and leaving it out meant the arbiter could not see the very
 * deliveries it demands. Observed overnight on 2026-07-29: krang delivered to
 * rocksteady through it, the ledger stayed open, the arbiter reminded him, he
 * delivered again — the same post every three minutes for half an hour. The
 * agent was obeying both the prompt and the arbiter, and they disagreed.
 */
const MESSAGE_DELIVERY_PATTERN = /^(send_to_teammate|send_dm|send_message|post_message|post_in_thread|reply_in_thread|post_reply|create_post|post_to_channel|send_channel_message|send_direct_message)$/;
const FILE_DELIVERY_PATTERN = /^(send_file|upload_file|attach_file|share_file)$/;

/** Classify a tool_use name as a delivery kind. Exported for tests. */
export function classifyDeliveryTool(toolName: string): DeliveryKind | undefined {
  const shortName = toolName.startsWith('mcp__')
    ? toolName.split('__').slice(2).join('__')
    : toolName;
  if (MESSAGE_DELIVERY_PATTERN.test(shortName)) return 'message';
  if (FILE_DELIVERY_PATTERN.test(shortName)) return 'file';
  return undefined;
}

/** Get (lazily creating) the arbiter state for a session */
export function getArbiterState(session: Session): ArbiterSessionState {
  if (!session.arbiter) {
    session.arbiter = createArbiterState();
  }
  return session.arbiter;
}

function openObligations(state: ArbiterSessionState): ArbiterObligation[] {
  return state.obligations.filter((o) => o.status === 'open');
}

// ---------------------------------------------------------------------------
// Obligation extraction (on user messages)
// ---------------------------------------------------------------------------

function buildExtractionPrompt(message: string, current: ArbiterObligation[]): string {
  const currentJson = JSON.stringify(
    current.map((o) => ({ description: o.description, tool: o.tool }))
  );

  return `You maintain a ledger of EXTERNAL DELIVERY obligations for a coding agent working in a chat thread.

A delivery obligation exists ONLY when the user explicitly asks the agent to deliver something OUTSIDE the current thread when the work is done:
- post a reply/summary to another channel, another thread, or to a person (tool: "message")
- send/upload a file to someone or somewhere (tool: "file")

IMPORTANT — "reply to me in the thread" is almost always an obligation, not an exemption. Agents are messaged BY OTHER AGENTS from a different thread, and the request carries a permalink to THAT thread ("reply to me in the thread: <url>", "отвечай мне в тред: <ссылка>"). That target thread is somewhere else, so delivering to it needs an explicit tool call and IS an obligation. Only a reply with no target — no permalink, no channel, no person named — is exempt as "just answer here".

NOT obligations: the work itself, plain conversation in this thread with no delivery target, committing/pushing code, opening PRs, or anything the user merely mentions without asking for delivery.

Current open obligations (JSON): ${currentJson}

New user message:
"""
${message.substring(0, MAX_MESSAGE_LENGTH)}
"""

Return the UPDATED list of open obligations after this message:
- keep current obligations that still stand
- add new ones the message introduces
- drop any the message cancels or completes

Respond with ONLY a JSON object, no other text:
{"obligations": [{"description": "<short imperative description with the target, in the user's language>", "tool": "message" | "file"}]}`;
}

/**
 * Parse the extraction response. Exported for tests.
 * Returns null when the response is unusable (keep the current ledger).
 */
export function parseObligationsResponse(response: string): Array<{ description: string; tool: DeliveryKind }> | null {
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { obligations?: Array<{ description?: unknown; tool?: unknown }> };
    if (!Array.isArray(parsed.obligations)) return null;

    const result: Array<{ description: string; tool: DeliveryKind }> = [];
    for (const item of parsed.obligations) {
      if (typeof item.description !== 'string' || !item.description.trim()) continue;
      // Accept kinds plus legacy tool names (older prompts/persisted data)
      const kind: DeliveryKind | undefined =
        item.tool === 'message' || item.tool === 'send_dm' ? 'message'
          : item.tool === 'file' || item.tool === 'send_file' ? 'file'
            : undefined;
      if (!kind) continue;
      result.push({ description: item.description.trim().substring(0, 300), tool: kind });
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Update the session's delivery-obligation ledger from a new user message.
 * Fire-and-forget: never blocks message handling, failures are silent.
 */
export function extractObligations(
  session: Session,
  message: string,
  ctx: SessionContext
): Promise<void> {
  if (ctx.config.arbiterEnabled === false) return Promise.resolve();
  // Delivery tools (send_dm/send_file) are provided by the claude-threads MCP
  // server, which only Claude sessions get — an obligation a Codex session
  // can't possibly fulfill would just produce reminder noise.
  if (session.agentType !== 'claude') return Promise.resolve();
  if (!message.trim()) return Promise.resolve();

  const state = getArbiterState(session);

  // Serialize per session: extractions snapshot the ledger and write it back
  // after an LLM round trip; two concurrent follow-ups would race and the
  // last writer would silently drop the other's obligations. The chain also
  // means the ledger snapshot below always reflects prior messages.
  const run = async (): Promise<void> => {
    try {
      // Cheap pre-filter: only spend a Haiku call when there's something to
      // update — either the ledger is non-empty (message may cancel/modify)
      // or the message plausibly asks for an external delivery.
      const open = openObligations(state);
      if (open.length === 0 && !mightContainDeliveryRequest(message)) return;
      // Nothing to deliver when the only ask is "answer me here" (shared channel).
      if (open.length === 0 && asksOnlyForSelfThreadReply(message, session.threadId)) {
        log.debug('Skipping extraction: message only asks for a reply in this thread');
        return;
      }

      const result = await quickQuery({
        prompt: buildExtractionPrompt(message, open),
        model: 'haiku',
        timeout: ARBITER_QUERY_TIMEOUT,
      });
      if (!result.success || !result.response) return;

      const updated = parseObligationsResponse(result.response);
      if (updated === null) return;

      // Replace open obligations with the updated list; keep fulfilled/failed history
      const settled = state.obligations.filter((o) => o.status !== 'open');
      state.obligations = [
        ...settled,
        ...updated.map((o): ArbiterObligation => ({ ...o, status: 'open', remindCount: 0 })),
      ];

      if (updated.length > 0) {
        sessionLog(session).info(
          `⚖️ Tracking ${updated.length} delivery obligation(s): ${updated.map((o) => o.description).join('; ')}`
        );
      }
      persistIfActive(session, ctx);
    } catch (err) {
      log.debug(`Obligation extraction failed: ${err}`);
    }
  };

  // Returned promise is ignored by production callers (fire-and-forget)
  // but awaited by tests. run() never rejects, so the chain never breaks.
  const chained = (state.extractionChain ?? Promise.resolve()).then(run);
  state.extractionChain = chained;
  return chained;
}

/**
 * Persist the session only while it is still registered. The arbiter's
 * async continuations can outlive the session (e.g. !stop during a Haiku
 * round trip); a late persist would overwrite the store record and wipe the
 * soft-delete marker, resurrecting a session the user explicitly killed.
 */
function persistIfActive(session: Session, ctx: SessionContext): void {
  if (!ctx.state.sessions.has(session.sessionId)) {
    log.debug(`Skipping persist for unregistered session ${session.sessionId}`);
    return;
  }
  ctx.ops.persistSession(session);
}

/**
 * Pull the bare post id out of a chat permalink (Mattermost .../pl/<id>).
 * Sync and allocation-cheap — used on the hot path before deciding whether
 * an extraction is worth an LLM call.
 */
function permalinkPostId(url: string): string | undefined {
  return /\/pl\/([A-Za-z0-9]+)/.exec(url)?.[1];
}

/**
 * Does this message only ask to be answered in THIS very thread?
 *
 * On a shared multi-bot channel teammates hold their sessions in the same
 * thread, so "отвечай мне в тред: <link to this thread>" asks for nothing: the
 * session already writes there, and its ordinary reply IS the delivery. Left
 * unfiltered the arbiter books an obligation no tool call can ever satisfy,
 * reminds about work already done, and pushes the agent into a pointless
 * post_in_thread into the thread it is sitting in — observed in #ai-work.
 *
 * "Only" matters: a message can ask for a reply here AND a file sent to
 * someone else. So we strip the self-directive and re-test the remainder for
 * any other delivery intent. Exported for tests.
 */
export function asksOnlyForSelfThreadReply(message: string, ownThreadId: string): boolean {
  const url = findReturnAddressUrl(message);
  if (!url) return false;
  if (permalinkPostId(url) !== ownThreadId) return false;

  // Strip the directive, its link, and bare @mentions, then see if anything
  // delivery-ish is left. Mentions have to go: in a shared thread naming a
  // teammate is ordinary conversation, not an instruction to deliver anywhere.
  // Real deliveries keep their own cues (напиши/отправь/канал/~channel/file).
  const remainder = message
    .split(url).join(' ')
    .replace(/(отвеч\S*|ответ\S*|отпиш\S*)[^.\n]{0,40}?в\s+тред/gi, ' ')
    .replace(/(reply|respond|answer|report|post)\b[^\n]{0,40}?\bthread/gi, ' ')
    .replace(/@[\w.-]+/g, ' ');
  return !mightContainDeliveryRequest(remainder);
}

/**
 * Heuristic pre-filter for the extraction call. Deliberately broad — false
 * positives just cost one Haiku call; false negatives lose the feature for
 * that message. Exported for tests.
 */
export function mightContainDeliveryRequest(message: string): boolean {
  // NB: `отвеч` — NOT `ответ`: the most common cross-agent phrasing is
  // "отвечай мне в тред", which the `ответ` stem does not match.
  // `/pl/` catches Mattermost permalinks even when the wording is odd.
  return /(send|dm|message|post|reply|thread|notify|ping|forward|отправ|напиш|сообщи|ответ|отвеч|отпиш|перешли|скинь|пингани|тред|канал|channel|\/pl\/|@[\w.-]+|~[\w-]+)/i.test(message);
}

// ---------------------------------------------------------------------------
// Event bookkeeping (synchronous, called from handleEventPostProcessing)
// ---------------------------------------------------------------------------

/**
 * Observe the normalized event stream: track delivery tool calls (an
 * obligation is fulfilled only when the tool RESULT comes back without
 * error) and remember the turn's final assistant text.
 */
/**
 * Mark message-delivery obligations met by a delivery the BOT made itself.
 *
 * The ledger is filled from the agent's tool calls, so once delivery moved into
 * code the arbiter stopped seeing it: the bot posted the answer, and the arbiter
 * then nagged the agent for exactly that — costing a whole turn to explain
 * itself and getting waived. Anything that delivers on the agent's behalf must
 * tell the ledger.
 */
export function noteBotDelivery(session: Session, what: string): void {
  const state = getArbiterState(session);
  state.deliveryToolCalls.push('message');
  for (const obligation of state.obligations) {
    if (obligation.status === 'open' && obligation.tool === 'message') {
      obligation.status = 'fulfilled';
      sessionLog(session).info(
        `⚖️ Obligation fulfilled by the bot itself (${what}): ${obligation.description}`
      );
    }
  }
}

export function noteEvent(session: Session, event: ClaudeEvent): void {
  const state = getArbiterState(session);

  if (event.type === 'tool_use') {
    const tool = event.tool_use as { id?: string; name?: string } | undefined;
    const delivery = tool?.name ? classifyDeliveryTool(tool.name) : undefined;
    if (delivery && tool?.id) {
      // Attempt only — fulfillment waits for a non-error tool_result.
      // A send_dm the MCP server rejects must not count as delivered.
      state.pendingDeliveryCalls.set(tool.id, delivery);
    }
    return;
  }

  if (event.type === 'tool_result') {
    const result = event.tool_result as { tool_use_id?: string; is_error?: boolean } | undefined;
    if (!result?.tool_use_id) return;
    const delivery = state.pendingDeliveryCalls.get(result.tool_use_id);
    if (!delivery) return;
    state.pendingDeliveryCalls.delete(result.tool_use_id);

    if (result.is_error) {
      sessionLog(session).info(`⚖️ Delivery attempt failed (${delivery}) — obligation stays open`);
      return;
    }

    state.deliveryToolCalls.push(delivery);
    for (const obligation of state.obligations) {
      if (obligation.status === 'open' && obligation.tool === delivery) {
        obligation.status = 'fulfilled';
        sessionLog(session).info(`⚖️ Obligation fulfilled (${delivery}): ${obligation.description}`);
      }
    }
    return;
  }

  if (event.type === 'assistant') {
    const message = event.message as { content?: Array<{ type: string; text?: string }> } | undefined;
    for (const block of message?.content ?? []) {
      if (block.type === 'text' && block.text?.trim()) {
        state.lastAssistantText = block.text.slice(-MAX_LAST_TEXT_LENGTH);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Turn-complete check (on result events)
// ---------------------------------------------------------------------------

/** Verdict for a delivery dispute: did the agent credibly resolve it? */
export type DisputeVerdict = 'resolved' | 'not_done';

function buildDisputePrompt(obligations: ArbiterObligation[], lastText: string): string {
  const list = obligations.map((o) => `- ${o.description}`).join('\n');
  return `A coding agent was asked to make these external deliveries and was reminded about them, but no successful delivery tool call was observed:
${list}

The agent's reply to the reminder:
"""
${lastText}
"""

Classify the reply:
- "resolved": the agent states it ALREADY delivered this through some other concrete mechanism (names a tool/channel/post it used), or that delivery is impossible or forbidden in this environment.
- "not_done": anything else — the delivery still has to happen (promises, questions, unrelated text).

Respond with ONLY a JSON object, no other text:
{"verdict": "resolved" | "not_done"}`;
}

/** Parse the dispute verdict response. Exported for tests. */
export function parseDisputeVerdict(response: string): DisputeVerdict | null {
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as { verdict?: unknown };
    if (parsed.verdict === 'resolved' || parsed.verdict === 'not_done') return parsed.verdict;
    return null;
  } catch {
    return null;
  }
}

function buildStallPrompt(lastText: string, originalTask: string | undefined): string {
  return `An autonomous coding agent working in a chat thread just ENDED its turn. Nobody may be watching the thread, so if the agent stopped to ask permission to continue, the task silently stalls.

Original task (may be truncated):
"""
${(originalTask ?? '(unknown)').substring(0, 800)}
"""

The agent's final message of this turn:
"""
${lastText}
"""

Classify the final message:
- "continue": the agent is asking permission to proceed, proposing next steps it could simply do, or checking in ("should I continue?", "want me to look further?", "I can also do X - proceed?"). Nothing actually blocks it.
- "wait_for_human": the agent needs a genuine human decision it cannot make itself - a choice between meaningfully different options, missing credentials/access/info, or approval for something destructive or irreversible.
- "done": the task is complete (or failed terminally) and the message is a final report; no continuation is expected.

Respond with ONLY a JSON object, no other text:
{"verdict": "continue" | "wait_for_human" | "done"}`;
}

/** Parse the stall verdict response. Exported for tests. */
export function parseStallVerdict(response: string): StallVerdict | null {
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as { verdict?: unknown };
    if (parsed.verdict === 'continue' || parsed.verdict === 'wait_for_human' || parsed.verdict === 'done') {
      return parsed.verdict;
    }
    return null;
  } catch {
    return null;
  }
}

/** Can the arbiter safely inject a message right now? Exported for tests. */
export function canIntervene(session: Session): boolean {
  if (!session.claude.isRunning()) return false;
  // Agent is already processing something new
  if (session.isProcessing) return false;
  // Session is ending/restarting/cancelled — leave it alone
  const state = session.lifecycle.state;
  if (state !== 'active' && state !== 'processing') return false;
  // A genuine interactive prompt is pending (plan approval, AskUserQuestion,
  // context prompt, worktree branch prompt, message approval, bug report) —
  // waiting for a human is correct
  if (session.messageManager?.getPendingApproval()) return false;
  if (session.messageManager?.hasPendingQuestions()) return false;
  if (session.messageManager?.getPendingContextPrompt()) return false;
  if (session.messageManager?.getPendingMessageApproval()) return false;
  if (session.messageManager?.getPendingBugReport()) return false;
  if (session.pendingWorktreePrompt) return false;
  return true;
}

/**
 * Deterministic delivery check. Returns obligations that are open and whose
 * tool was never called this session. Exported for tests.
 */
export function unmetObligations(state: ArbiterSessionState): ArbiterObligation[] {
  return openObligations(state).filter((o) => !state.deliveryToolCalls.includes(o.tool));
}

/**
 * Run the arbiter at turn completion (a `result` event arrived).
 * Fire-and-forget: returns immediately, all work happens out-of-band.
 */
export function onTurnComplete(session: Session, ctx: SessionContext): Promise<void> {
  if (ctx.config.arbiterEnabled === false) return Promise.resolve();

  const state = getArbiterState(session);

  // Human-wait watchdog. This MUST run before the canIntervene() gate below:
  // a pending question/approval is exactly what that gate refuses to touch,
  // and exactly the case that parks a task forever in an unwatched channel.
  // Passing no stalled text arms only the interactive kinds — a prose stall
  // is armed later, once the stall check has judged it wait_for_human.
  noteWaiting(session, ctx, undefined);

  if (state.checking) return Promise.resolve();

  const hasOpenObligations = openObligations(state).length > 0;
  const stallCheckAvailable =
    state.continuationNudges < MAX_CONTINUATION_NUDGES && !!state.lastAssistantText;
  if (!hasOpenObligations && !stallCheckAvailable) return Promise.resolve();
  if (!canIntervene(session)) return Promise.resolve();

  state.checking = true;
  // Returned promise is ignored by production callers (fire-and-forget)
  // but awaited by tests.
  return runTurnCompleteCheck(session, ctx, state)
    .catch((err) => log.debug(`Arbiter turn-complete check failed: ${err}`))
    .finally(() => {
      state.checking = false;
    });
}

async function runTurnCompleteCheck(
  session: Session,
  ctx: SessionContext,
  state: ArbiterSessionState
): Promise<void> {
  // The agent process this turn belongs to. If a !cd/!permissions restart
  // replaces session.claude while we're doing async work below, our message
  // would land in a fresh conversation that never heard about the task —
  // every send re-checks identity first.
  const claudeAtStart = session.claude;

  // Consume this turn's final text NOW: a later text-less turn (interrupt,
  // error, pure tool-use) must not reuse it for a stale stall verdict.
  const lastText = state.lastAssistantText;
  state.lastAssistantText = undefined;

  const stillSafe = (): boolean =>
    session.claude === claudeAtStart && canIntervene(session);

  // 1. Delivery obligations — deterministic, checked first
  const unmet = unmetObligations(state);
  if (unmet.length > 0) {
    const remindable = unmet.filter((o) => o.remindCount < MAX_DELIVERY_REMINDERS);

    if (remindable.length > 0) {
      // If we've already reminded and the agent replied with text instead of
      // a delivery call, it may be disputing ("already delivered another
      // way" / "forbidden here") — judge that reply before nagging again.
      // This is what breaks the loop of the arbiter bullying the agent into
      // a delivery tool that is disabled in this deployment.
      const alreadyReminded = remindable.some((o) => o.remindCount > 0);
      if (alreadyReminded && lastText) {
        const dispute = await quickQuery({
          prompt: buildDisputePrompt(unmet, lastText),
          model: 'haiku',
          timeout: ARBITER_QUERY_TIMEOUT,
        });
        const disputeVerdict = dispute.success && dispute.response
          ? parseDisputeVerdict(dispute.response)
          : null;
        if (disputeVerdict === 'resolved') {
          for (const o of unmet) o.status = 'waived';
          persistIfActive(session, ctx);
          const fmt = session.platform.getFormatter();
          await post(
            session,
            'info',
            `⚖️ ${fmt.formatItalic('Arbiter: the agent reports the delivery was handled another way (or is not possible here) — accepting.')}`
          );
          sessionLog(session).info(`⚖️ Waived ${unmet.length} obligation(s) after the agent's explanation`);
          return;
        }
      }

      sessionLog(session).info(
        `⚖️ Reminding agent about ${remindable.length} unmet delivery obligation(s)`
      );
      const formatter = session.platform.getFormatter();
      await post(
        session,
        'info',
        `⚖️ ${formatter.formatItalic(`Arbiter: reminding the agent about ${remindable.length === 1 ? 'an unfinished delivery' : 'unfinished deliveries'}`)}`
      );

      // Re-check after the network round trip; count the reminder only if
      // it is actually sent
      if (!stillSafe()) return;
      for (const o of remindable) o.remindCount++;
      persistIfActive(session, ctx);

      const list = remindable.map((o) => `- ${o.description} (${o.tool} delivery)`).join('\n');
      sendToAgent(
        session,
        ctx,
        `[Arbiter] You finished your turn, but the user asked for the following and no successful delivery was observed:\n${list}\nDeliver it now using whatever tool is appropriate in this environment (a channel/DM posting tool for messages, a file upload tool for files). If you have ALREADY delivered it another way, or delivery is impossible or forbidden here, say so plainly in one sentence — I will accept that and stop reminding.`
      );
    } else {
      // Out of reminders — surface to the humans once and stop tracking
      for (const o of unmet) o.status = 'failed';
      persistIfActive(session, ctx);
      const formatter = session.platform.getFormatter();
      await post(
        session,
        'warning',
        `⚖️ ${formatter.formatBold('Arbiter:')} the agent finished without completing ${unmet.length === 1 ? 'a requested delivery' : `${unmet.length} requested deliveries`} despite reminders:\n` +
        unmet.map((o) => `• ${o.description}`).join('\n')
      );
      sessionLog(session).warn(`⚖️ Gave up on ${unmet.length} delivery obligation(s) after ${MAX_DELIVERY_REMINDERS} reminders`);
    }
    return; // the reminder starts a new turn; stall check will run on ITS result
  }

  // 2. Stall check — only when deliveries are in order
  if (state.continuationNudges >= MAX_CONTINUATION_NUDGES) return;
  if (!lastText) return;

  // Quick lexical gate: a final message with no question mark and no
  // proposal phrasing is almost never a permission-stall — skip the LLM call
  if (!/[?？]|продолж|continue|proceed|shall i|should i|want me/i.test(lastText)) return;

  const messageCountBefore = session.messageCount;
  const result = await quickQuery({
    prompt: buildStallPrompt(lastText, session.firstPrompt),
    model: 'haiku',
    timeout: ARBITER_QUERY_TIMEOUT,
  });
  if (!result.success || !result.response) return;

  const verdict = parseStallVerdict(result.response);
  if (verdict === 'wait_for_human') {
    // A real blocking question asked in prose — there's no prompt to answer,
    // but the humans still need to learn about it if nobody replies.
    noteWaiting(session, ctx, lastText);
    return;
  }
  if (verdict !== 'continue') return;

  // Re-check: a human may have replied (or the session may have moved on)
  // while we were judging
  if (session.messageCount !== messageCountBefore) return;
  if (!stillSafe()) return;

  state.continuationNudges++;
  persistIfActive(session, ctx);
  sessionLog(session).info(
    `⚖️ Stall detected — nudging agent to continue (${state.continuationNudges}/${MAX_CONTINUATION_NUDGES})`
  );

  const formatter = session.platform.getFormatter();
  await post(
    session,
    'info',
    `⚖️ ${formatter.formatItalic(`Arbiter: the agent paused to ask permission — nudging it to continue (${state.continuationNudges}/${MAX_CONTINUATION_NUDGES})`)}`
  );

  if (!stillSafe()) return;
  sendToAgent(
    session,
    ctx,
    '[Arbiter] Nobody is watching this thread right now. You ended your turn asking whether to continue — do not wait for permission: continue working on the task autonomously until it is complete. Only stop to ask when you genuinely cannot decide yourself (missing access, destructive action, or a real choice the user must make).'
  );
}

/** Inject a message into the agent's conversation and restore typing state */
function sendToAgent(session: Session, ctx: SessionContext, message: string): void {
  try {
    session.claude.sendMessage(message);
    session.isProcessing = true;
    session.lastActivityAt = new Date();
    ctx.ops.startTyping(session);
  } catch (err) {
    log.debug(`Arbiter sendMessage failed: ${err}`);
  }
}
