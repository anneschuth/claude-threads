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
import {
  createArbiterState,
  type ArbiterObligation,
  type ArbiterSessionState,
  type DeliveryTool,
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
 * MCP delivery tools → short obligation tool names.
 * Codex sessions don't get these MCP tools, so delivery obligations are
 * Claude-only (see extractObligations gate).
 */
const DELIVERY_TOOL_NAMES: Record<string, DeliveryTool> = {
  'mcp__claude-threads-mcp__send_dm': 'send_dm',
  'mcp__claude-threads-mcp__send_file': 'send_file',
};

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
- post a reply/summary to another channel or to a person (tool: send_dm)
- send/upload a file to someone or somewhere (tool: send_file)

NOT obligations: the work itself, replying in the current thread, committing/pushing code, opening PRs, or anything the user merely mentions without asking for delivery.

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
{"obligations": [{"description": "<short imperative description with the target, in the user's language>", "tool": "send_dm" | "send_file"}]}`;
}

/**
 * Parse the extraction response. Exported for tests.
 * Returns null when the response is unusable (keep the current ledger).
 */
export function parseObligationsResponse(response: string): Array<{ description: string; tool: DeliveryTool }> | null {
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { obligations?: Array<{ description?: unknown; tool?: unknown }> };
    if (!Array.isArray(parsed.obligations)) return null;

    const result: Array<{ description: string; tool: DeliveryTool }> = [];
    for (const item of parsed.obligations) {
      if (typeof item.description !== 'string' || !item.description.trim()) continue;
      if (item.tool !== 'send_dm' && item.tool !== 'send_file') continue;
      result.push({ description: item.description.trim().substring(0, 300), tool: item.tool });
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

  // Cheap pre-filter: only spend a Haiku call when there's something to
  // update — either the ledger is non-empty (message may cancel/modify) or
  // the message plausibly asks for an external delivery.
  const open = openObligations(state);
  if (open.length === 0 && !mightContainDeliveryRequest(message)) return Promise.resolve();

  // Returned promise is ignored by production callers (fire-and-forget)
  // but awaited by tests.
  return (async () => {
    try {
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
      ctx.ops.persistSession(session);
    } catch (err) {
      log.debug(`Obligation extraction failed: ${err}`);
    }
  })();
}

/**
 * Heuristic pre-filter for the extraction call. Deliberately broad — false
 * positives just cost one Haiku call; false negatives lose the feature for
 * that message. Exported for tests.
 */
export function mightContainDeliveryRequest(message: string): boolean {
  return /(send|dm|message|post|reply|notify|ping|forward|отправ|напиш|сообщи|ответ|отпиш|перешли|скинь|пингани|канал|channel|@[\w.-]+|~[\w-]+)/i.test(message);
}

// ---------------------------------------------------------------------------
// Event bookkeeping (synchronous, called from handleEventPostProcessing)
// ---------------------------------------------------------------------------

/**
 * Observe the normalized event stream: record delivery tool calls (fulfilling
 * matching obligations) and remember the turn's final assistant text.
 */
export function noteEvent(session: Session, event: ClaudeEvent): void {
  const state = getArbiterState(session);

  if (event.type === 'tool_use') {
    const tool = event.tool_use as { name?: string } | undefined;
    const delivery = tool?.name ? DELIVERY_TOOL_NAMES[tool.name] : undefined;
    if (delivery) {
      state.deliveryToolCalls.push(delivery);
      for (const obligation of state.obligations) {
        if (obligation.status === 'open' && obligation.tool === delivery) {
          obligation.status = 'fulfilled';
          sessionLog(session).info(`⚖️ Obligation fulfilled (${delivery}): ${obligation.description}`);
        }
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
  // context prompt, worktree branch prompt) — waiting for a human is correct
  if (session.messageManager?.getPendingApproval()) return false;
  if (session.messageManager?.hasPendingQuestions()) return false;
  if (session.messageManager?.getPendingContextPrompt()) return false;
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
  // 1. Delivery obligations — deterministic, checked first
  const unmet = unmetObligations(state);
  if (unmet.length > 0) {
    const remindable = unmet.filter((o) => o.remindCount < MAX_DELIVERY_REMINDERS);

    if (remindable.length > 0) {
      for (const o of remindable) o.remindCount++;
      ctx.ops.persistSession(session);
      await remindAgent(session, ctx, remindable);
    } else {
      // Out of reminders — surface to the humans once and stop tracking
      for (const o of unmet) o.status = 'failed';
      ctx.ops.persistSession(session);
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
  const lastText = state.lastAssistantText;
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
  if (verdict !== 'continue') return;

  // Re-check: a human may have replied while we were judging
  if (session.messageCount !== messageCountBefore) return;
  if (!canIntervene(session)) return;

  state.continuationNudges++;
  ctx.ops.persistSession(session);
  sessionLog(session).info(
    `⚖️ Stall detected — nudging agent to continue (${state.continuationNudges}/${MAX_CONTINUATION_NUDGES})`
  );

  const formatter = session.platform.getFormatter();
  await post(
    session,
    'info',
    `⚖️ ${formatter.formatItalic(`Arbiter: the agent paused to ask permission — nudging it to continue (${state.continuationNudges}/${MAX_CONTINUATION_NUDGES})`)}`
  );

  sendToAgent(
    session,
    ctx,
    '[Arbiter] Nobody is watching this thread right now. You ended your turn asking whether to continue — do not wait for permission: continue working on the task autonomously until it is complete. Only stop to ask when you genuinely cannot decide yourself (missing access, destructive action, or a real choice the user must make).'
  );
}

/** Remind the agent about unmet delivery obligations (starts a new turn) */
async function remindAgent(
  session: Session,
  ctx: SessionContext,
  obligations: ArbiterObligation[]
): Promise<void> {
  sessionLog(session).info(
    `⚖️ Reminding agent about ${obligations.length} unmet delivery obligation(s)`
  );

  const formatter = session.platform.getFormatter();
  await post(
    session,
    'info',
    `⚖️ ${formatter.formatItalic(`Arbiter: reminding the agent about ${obligations.length === 1 ? 'an unfinished delivery' : 'unfinished deliveries'}`)}`
  );

  const list = obligations.map((o) => `- ${o.description} (use the ${o.tool} tool)`).join('\n');
  sendToAgent(
    session,
    ctx,
    `[Arbiter] You finished your turn, but the user asked for the following and you have NOT done it yet:\n${list}\nDo it now. If it is genuinely impossible, say so explicitly in this thread.`
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
