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
import { noteBotDelivery } from '../arbiter/handler.js';
import type { Session } from '../../session/types.js';
import type { SessionContext } from '../session-context/index.js';
import type { ReviewPingConfig } from '../../config/types.js';
import { createReviewPingState, type ReviewPingState } from './types.js';

const log = createLogger('review-ping');
const sessionLog = createSessionLog(log);

/** Quiet period before the ping fires — long enough that a push-then-amend settles. */
export const QUIESCENCE_MS = 120_000;

/**
 * Get (lazily creating) the review-ping state for a session. Lives on the
 * session and is persisted — see types.ts for why the in-memory WeakMap this
 * replaces was the wrong trade.
 */
export function getReviewPingState(session: Session): ReviewPingState {
  if (!session.reviewPing) {
    session.reviewPing = createReviewPingState();
  }
  return session.reviewPing;
}

/**
 * Persist only while the session is still registered — a timer continuation can
 * outlive a !stop, and a late write would resurrect a killed session.
 */
function persistIfActive(session: Session, ctx: SessionContext): void {
  if (!ctx.state.sessions.has(session.sessionId)) return;
  ctx.ops.persistSession(session);
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

  const state = getReviewPingState(session);
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
  const state = session.reviewPing;
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
  const state = getReviewPingState(session);
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
  // No channel fallback: cross-bot work stays in threads. If they hold no
  // session in this channel there is nowhere to reach them from here, and
  // opening a thread in their channel is what we stopped doing.
  if (!route) {
    sessionLog(session).info(`@${cfg.botName} holds no session in this channel — skipping the review ping`);
    state.pinged.add(mrUrl);
    return;
  }
  const target = route.target;

  // Marked before the await: a failed ping must not retry forever. The next MR
  // in this session arms a fresh one.
  state.pinged.add(mrUrl);
  persistIfActive(session, ctx);

  const body = buildHandoffMessage(route, reviewBody(mrUrl));

  try {
    await platform.deliverToThread(target, body);
    sessionLog(session).info(
      `🔍 Asked @${cfg.botName} to review ${mrUrl} (${route?.kind ?? 'channel'})`
    );
    noteBotDelivery(session, 'review ping');

    const fmt = platform.getFormatter();
    await post(session, 'info', `🔍 ${fmt.formatItalic(`Позвал @${cfg.botName} на ревью`)}`);
  } catch (err) {
    sessionLog(session).warn(`🔍 Could not ask @${cfg.botName} for a review: ${err}`);
  }
}
