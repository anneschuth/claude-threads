/**
 * Review ping — the bot asks for the review, not the agent.
 *
 * The mirror image of docs-ping. When a session opens a merge request, the
 * reviewer is called deterministically instead of hopefully: nothing in code
 * used to make anyone request a review, only a line in the agent's prompt
 * ("write to @rocksteady when you need a code review"), and an agent deep in
 * its own task doesn't act on that. Observed: a docs bot opened an MR, noticed
 * on its own that GitLab required an approver sign-off, said so — and never
 * asked anyone. Reporting is a thought; asking is an action, and only code
 * reliably performs actions.
 *
 * Wired from operations/events/handler.ts on every `result` event.
 */

import { createLogger } from '../../utils/logger.js';
import { createSessionLog } from '../../utils/session-log.js';
import { post } from '../post-helpers/index.js';
import { resolveTeammateRoute, buildHandoffMessage } from '../../teammates/registry.js';
import type { Session } from '../../session/types.js';
import type { SessionContext } from '../session-context/index.js';
import type { ReviewPingConfig } from '../../config/types.js';

const log = createLogger('review-ping');
const sessionLog = createSessionLog(log);

/** Quiet period before the ping fires — long enough that a push-then-amend settles. */
export const QUIESCENCE_MS = 120_000;

/**
 * Per-session bookkeeping. Deliberately in memory rather than on the persisted
 * session: the only cost of losing it is one duplicate review request after a
 * bot restart, which is far cheaper than another persisted field to keep
 * backward-compatible.
 */
interface ReviewPingState {
  pinged: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
}

const states = new WeakMap<Session, ReviewPingState>();

function getState(session: Session): ReviewPingState {
  let state = states.get(session);
  if (!state) {
    state = { pinged: new Set() };
    states.set(session, state);
  }
  return state;
}

/**
 * Config for this session, or null when the ping must not fire. Same two-way
 * self-guard as docs-ping: by name, because that's what we'd mention, and by
 * channel, because a renamed reviewer still lives in the same channel.
 */
/** Resolved config: botName and channelId are guaranteed present. */
type ResolvedReviewPing = ReviewPingConfig & { botName: string; channelId: string };

export function resolveReviewPing(session: Session, ctx: SessionContext): ResolvedReviewPing | null {
  const cfg = ctx.config.reviewPing;
  if (!cfg?.enabled) return null;
  if (!cfg.channelId) return null;

  const botName = cfg.botName || 'reviewer';
  const channelId = cfg.channelId;
  const ownBot = session.platform.getBotName?.();
  if (ownBot && ownBot.toLowerCase() === botName.toLowerCase()) return null;
  if (session.platform.getMcpConfig?.().channelId === cfg.channelId) return null;

  return { ...cfg, botName, channelId };
}

function quiescenceMs(cfg: ResolvedReviewPing): number {
  return cfg.quiescenceMs ?? QUIESCENCE_MS;
}

/** (Re)arm the ping while the session keeps working; fires once it goes quiet. */
export function onTurnComplete(session: Session, ctx: SessionContext): void {
  const cfg = resolveReviewPing(session, ctx);
  if (!cfg) return;

  const mrUrl = session.pullRequestUrl;
  if (!mrUrl) return;

  const state = getState(session);
  if (state.pinged.has(mrUrl)) return;

  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = undefined;
    void deliver(session, ctx, cfg).catch((err) => log.debug(`Review ping failed: ${err}`));
  }, quiescenceMs(cfg));
  state.timer.unref?.();
}

/** Clear the pending timer — call when the session ends or is killed. */
export function cancelReviewPing(session: Session): void {
  const state = states.get(session);
  if (state?.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }
}

/** The ask itself. Short on purpose: the reviewer reads the MR, not this post. */
function reviewBody(mrUrl: string): string {
  return (
    `прошу ревью: ${mrUrl}\n\n` +
    `Approve — твой, если всё чисто. Мерж не жми, мержит владелец.`
  );
}

async function deliver(
  session: Session,
  ctx: SessionContext,
  cfg: ResolvedReviewPing
): Promise<void> {
  const state = getState(session);
  if (session.isProcessing) return; // work resumed; onTurnComplete re-arms
  if (!ctx.state.sessions.has(session.sessionId)) return;

  // Re-read: the session may have opened a different MR since the timer was armed.
  const mrUrl = session.pullRequestUrl;
  if (!mrUrl || state.pinged.has(mrUrl)) return;

  const platform = session.platform;
  if (!platform.deliverToThread) return;

  // Same routing rule as send_to_teammate and the docs ping: a reviewer working
  // in THIS channel is asked in THIS thread, next to the code.
  const mcp = platform.getMcpConfig?.();
  const route = resolveTeammateRoute(cfg.botName, {
    registry: mcp?.teammates ?? [{ name: cfg.botName, channelId: cfg.channelId }],
    presentHere: mcp?.teammatesPresent ?? [],
    currentChannelId: mcp?.channelId ?? '',
    currentThreadId: session.threadId,
  });
  const target = route?.target ?? { channelId: cfg.channelId, rootId: '' };

  // Marked before the await: a failed ping must not retry forever. The next MR
  // in this session arms a fresh one.
  state.pinged.add(mrUrl);

  const body = route
    ? buildHandoffMessage(route, reviewBody(mrUrl), platform.getThreadLink(session.threadId))
    : `@${cfg.botName} ${reviewBody(mrUrl)}`;

  try {
    await platform.deliverToThread(target, body);
    sessionLog(session).info(
      `🔍 Asked @${cfg.botName} to review ${mrUrl} (${route?.kind ?? 'channel'})`
    );

    const fmt = platform.getFormatter();
    await post(session, 'info', `🔍 ${fmt.formatItalic(`Позвал @${cfg.botName} на ревью`)}`);
  } catch (err) {
    sessionLog(session).warn(`🔍 Could not ask @${cfg.botName} for a review: ${err}`);
  }
}
