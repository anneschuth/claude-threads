/**
 * Docs-ping — the bot tells the docs bot about a shipped change.
 *
 * Hooks (wired in operations/events/handler.ts and session/lifecycle.ts):
 * - noteEvent(): notices the agent pinging the docs channel itself.
 * - onTurnComplete(): arms a quiescence timer once the session has an MR.
 * - cancelDocsPing(): clears the timer when the session ends.
 *
 * Trigger is deterministic: `session.pullRequestUrl`, which the PR detector
 * already sets from the agent's output. No MR, no ping — a session that only
 * investigated something has nothing for the docs bot.
 *
 * The judgement ("does this touch documentation?") is one out-of-band call,
 * the same mechanism as the arbiter's judge. Its cost is bounded: at most one
 * call per session, and only for sessions that produced an MR.
 */

import { quickQuery } from '../../claude/quick-query.js';
import { createLogger } from '../../utils/logger.js';
import { createSessionLog } from '../../utils/session-log.js';
import { post } from '../post-helpers/index.js';
import type { Session } from '../../session/types.js';
import type { SessionContext } from '../session-context/index.js';
import type { ClaudeEvent } from '../../claude/cli.js';
import { createDocsPingState, type DocsPingState, type DocsVerdict } from './types.js';
import { resolveTeammateRoute, buildHandoffMessage } from '../../teammates/registry.js';
import { buildReturnAddressMarker } from '../return-address/parser.js';

const log = createLogger('docs-ping');
const sessionLog = createSessionLog(log);

/**
 * Quiet period before the ping fires. Longer than the return delivery: the
 * docs bot should hear about a change once the dust has settled, and it is
 * never the urgent half of the work.
 */
export const DOCS_PING_QUIESCENCE_MS = 120_000;

/** Judge timeout. */
const JUDGE_TIMEOUT_MS = 30_000;

/** Max final-report text fed to the judge. */
const MAX_REPORT_TEXT = 2000;

/** Tools that post a message somewhere, used only together with a channel id. */
const POST_TOOL_RE = /^(send_message|post_message|post_in_thread|create_post|post_to_channel)$/;

/** Input keys carrying a channel id across MCP servers. */
const CHANNEL_ID_KEYS = ['channel_id', 'channelId', 'channel'];

export function getDocsPingState(session: Session): DocsPingState {
  if (!session.docsPing) {
    session.docsPing = createDocsPingState();
  }
  return session.docsPing;
}

interface DocsPingConfig {
  channelId: string;
  botName: string;
  judgeModel: 'haiku' | 'sonnet' | 'opus';
}

/**
 * Resolve the docs-ping config, or null when it's off / not applicable.
 * Returns null for the docs bot's own sessions — it must not ping itself.
 */
export function resolveDocsPing(session: Session, ctx: SessionContext): DocsPingConfig | null {
  const cfg = ctx.config.docsPing;
  if (!cfg?.enabled) return null;
  if (!cfg.channelId) return null;

  const botName = cfg.botName || 'docs';
  // The docs bot must not ping itself. Checked by name AND by channel: a
  // renamed bot still lives in the same channel, and a bot watching several
  // channels could otherwise post into its own.
  const ownBot = session.platform.getBotName?.();
  if (ownBot && ownBot.toLowerCase() === botName.toLowerCase()) return null;
  if (session.platform.getMcpConfig?.().channelId === cfg.channelId) return null;

  return { channelId: cfg.channelId, botName, judgeModel: cfg.judgeModel ?? 'sonnet' };
}

function persistIfActive(session: Session, ctx: SessionContext): void {
  if (!ctx.state.sessions.has(session.sessionId)) return;
  ctx.ops.persistSession(session);
}

// ---------------------------------------------------------------------------
// Event bookkeeping
// ---------------------------------------------------------------------------

function extractChannelId(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of CHANNEL_ID_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/** Notice the agent posting to the docs channel on its own. */
export function noteEvent(session: Session, event: ClaudeEvent, ctx: SessionContext): void {
  const cfg = resolveDocsPing(session, ctx);
  if (!cfg) return;
  const state = getDocsPingState(session);

  if (event.type === 'tool_use') {
    const tool = event.tool_use as { id?: string; name?: string; input?: unknown } | undefined;
    if (!tool?.id || !tool.name) return;
    const shortName = tool.name.startsWith('mcp__')
      ? tool.name.split('__').slice(2).join('__')
      : tool.name;
    if (!POST_TOOL_RE.test(shortName)) return;
    if (extractChannelId(tool.input) !== cfg.channelId) return;
    state.pendingAgentPings.set(tool.id, true);
    return;
  }

  if (event.type === 'tool_result') {
    const result = event.tool_result as { tool_use_id?: string; is_error?: boolean } | undefined;
    if (!result?.tool_use_id) return;
    if (!state.pendingAgentPings.delete(result.tool_use_id)) return;
    if (result.is_error) return;
    if (!state.agentPinged) {
      state.agentPinged = true;
      sessionLog(session).info(`📗 Agent notified @${cfg.botName} itself — standing down`);
    }
  }
}

// ---------------------------------------------------------------------------
// Quiescence trigger
// ---------------------------------------------------------------------------

/** Is a docs ping still owed for this session? Exported for tests. */
export function pingPending(session: Session, state: DocsPingState): boolean {
  if (state.settled || state.agentPinged) return false;
  // Deterministic gate: only sessions that actually produced an MR.
  return !!session.pullRequestUrl;
}

/** Clear the pending timer — call when the session ends. */
export function cancelDocsPing(session: Session): void {
  const state = session.docsPing;
  if (state?.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }
}

/** Called on each `result`: (re)arm the quiescence timer. */
export function onTurnComplete(session: Session, ctx: SessionContext): void {
  const cfg = resolveDocsPing(session, ctx);
  if (!cfg) return;
  const state = getDocsPingState(session);
  if (!pingPending(session, state)) return;

  if (state.timer) clearTimeout(state.timer);
  const delay = ctx.config.docsPing?.quiescenceMs ?? DOCS_PING_QUIESCENCE_MS;
  state.timer = setTimeout(() => {
    state.timer = undefined;
    void sendDocsPing(session, ctx).catch((err) => log.debug(`Docs ping failed: ${err}`));
  }, delay);
  state.timer.unref?.();
}

// ---------------------------------------------------------------------------
// The judge
// ---------------------------------------------------------------------------

export function buildDocsJudgePrompt(
  task: string | undefined,
  report: string | undefined,
  mrUrl: string
): string {
  return `A coding agent finished a change and opened a merge request. Decide whether the documentation team needs to hear about it.

Original task:
"""
${(task ?? '(unknown)').substring(0, 600)}
"""

The agent's final report:
"""
${(report ?? '(no report)').substring(0, MAX_REPORT_TEXT)}
"""

Merge request: ${mrUrl}

Docs are affected when the change touches anything a reader outside the codebase can observe: public API or its behaviour, feature behaviour, configuration and environment variables, installation or setup steps, limits and quotas, user-visible texts, or the changelog.

Docs are NOT affected by: internal refactoring, tests, CI or build changes, logging, performance work, or a bug fix that merely restores already-documented behaviour.

"summary" and "whatToCheck" must be written in the SAME LANGUAGE as the agent's report.

Respond with ONLY a JSON object, no other text:
{"needsDocs": true|false, "summary": "<1-2 sentences: what changed>", "whatToCheck": "<which doc section to look at and why; empty string when needsDocs is false>"}`;
}

/** Parse the judge response. Exported for tests. */
export function parseDocsVerdict(response: string): DocsVerdict | null {
  const match = response.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    if (typeof parsed.needsDocs !== 'boolean') return null;

    if (!parsed.needsDocs) return { needsDocs: false, summary: '', whatToCheck: '' };

    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    // A ping with no summary is worse than no ping — the docs bot would have
    // to go dig out what happened by itself.
    if (!summary) return null;

    return {
      needsDocs: true,
      summary: summary.substring(0, 600),
      whatToCheck: typeof parsed.whatToCheck === 'string' ? parsed.whatToCheck.trim().substring(0, 600) : '',
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * The substance of the ping, without the mention or reply-back link — those are
 * added by buildHandoffMessage so this reads the same wherever it lands.
 */
export function docsBody(verdict: DocsVerdict, mrUrl: string): string {
  const lines = [verdict.summary, '', `MR: ${mrUrl}`];
  if (verdict.whatToCheck) lines.push(`Что проверить в доке: ${verdict.whatToCheck}`);
  return lines.join('\n');
}

/** Legacy shape, kept for the no-registry fallback. Exported for tests. */
export function buildDocsMessage(
  session: Session,
  cfg: DocsPingConfig,
  verdict: DocsVerdict,
  mrUrl: string
): string {
  const backLink = session.platform.getThreadLink(session.threadId);
  const lines = [`@${cfg.botName} ${verdict.summary}`, '', `MR: ${mrUrl}`];
  if (verdict.whatToCheck) lines.push(`Что проверить в доке: ${verdict.whatToCheck}`);
  lines.push('', buildReturnAddressMarker(backLink));
  return lines.join('\n');
}

async function sendDocsPing(session: Session, ctx: SessionContext): Promise<void> {
  const cfg = resolveDocsPing(session, ctx);
  if (!cfg) return;
  const state = getDocsPingState(session);
  if (!pingPending(session, state)) return;
  if (session.isProcessing) return; // work resumed; onTurnComplete re-arms
  if (!ctx.state.sessions.has(session.sessionId)) return;

  const platform = session.platform;
  if (!platform.deliverToThread) return;

  const mrUrl = session.pullRequestUrl;
  if (!mrUrl) return;

  const report = session.returnDelivery?.lastFinalText ?? session.arbiter?.lastAssistantText;
  const result = await quickQuery({
    prompt: buildDocsJudgePrompt(session.firstPrompt, report, mrUrl),
    model: cfg.judgeModel,
    timeout: JUDGE_TIMEOUT_MS,
  });
  if (!result.success || !result.response) return; // retry on a later turn

  const verdict = parseDocsVerdict(result.response);
  if (!verdict) return;

  // Settle either way: a "no" is a decision, not a reason to re-judge every
  // turn for the rest of the session.
  state.settled = true;
  persistIfActive(session, ctx);

  if (!verdict.needsDocs) {
    sessionLog(session).info(`📗 Change does not touch docs — not pinging @${cfg.botName}`);
    return;
  }

  // Re-check liveness after the judge round trip.
  if (!ctx.state.sessions.has(session.sessionId)) return;
  if (state.agentPinged) return;

  // Same rule as send_to_teammate: a docs bot that works in THIS channel is
  // told in THIS thread, next to the work. Hardcoding "her own channel" was the
  // inconsistency — she'd be pinged elsewhere while sitting in the very thread.
  const mcp = platform.getMcpConfig?.();
  const route = resolveTeammateRoute(cfg.botName, {
    registry: mcp?.teammates ?? [{ name: cfg.botName, channelId: cfg.channelId }],
    presentHere: mcp?.teammatesPresent ?? [],
    currentChannelId: mcp?.channelId ?? '',
    currentThreadId: session.threadId,
  });
  const target = route?.target ?? { channelId: cfg.channelId, rootId: '' };
  const body = route
    ? buildHandoffMessage(route, docsBody(verdict, mrUrl), platform.getThreadLink(session.threadId))
    : buildDocsMessage(session, cfg, verdict, mrUrl);

  try {
    await platform.deliverToThread(target, body);
    sessionLog(session).info(
      `📗 Notified @${cfg.botName} about a docs-affecting change (${route?.kind ?? 'channel'})`
    );

    const fmt = platform.getFormatter();
    await post(session, 'info', `📗 ${fmt.formatItalic(`Позвал @${cfg.botName} проверить документацию`)}`);
  } catch (err) {
    sessionLog(session).warn(`📗 Could not notify @${cfg.botName}: ${err}`);
  }
}
