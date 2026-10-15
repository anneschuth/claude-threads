/**
 * How a lifecycle notice reaches the thread (#606).
 *
 * `lifecycle` (lifecycle-visibility.ts) decides WHETHER a notice is wanted;
 * `lifecycleDelivery` decides its shape. On a fleet of bots sharing one
 * workspace, a single restart drops a near-identical notice into every open
 * thread, each one a push notification, and teams want different amounts of
 * that.
 *
 * - `post` — a new post, exactly as before. Nothing here runs: the create is
 *   called and its result returned untouched.
 * - `dedup` — no new post when the bot's last post in the thread already shows
 *   the same notice. That post becomes the anchor instead.
 * - `reaction` — an emoji on the bot's last post instead of a new post. A
 *   reaction notifies nobody.
 *
 * Two invariants:
 *
 * 1. The abnormal exit (`[Exited: <code>]`) never comes through here. It is a
 *    failure report, and a session that died must not look like one that
 *    finished.
 * 2. The post a notice lands on is returned as the anchor, and every caller
 *    stores it as `lifecyclePostId` exactly as it stores a new post. That is
 *    the field `findByPostId` matches, so a 🔄 on the deduped or reacted-to
 *    post resumes the session.
 *
 * The anchor of a reaction is usually Claude's own reply, so its text must
 * never be rewritten. `updateLifecycleNotice` covers the in-place edits (idle
 * warning → timed out, shutdown → resumed): on such an anchor it swaps the
 * emoji instead of editing.
 */

import type { LifecycleDelivery } from '../config/types.js';
import type { PlatformPost } from '../platform/index.js';
import { createLogger } from '../utils/logger.js';
import { createSessionLog } from '../utils/session-log.js';
import type { LifecyclePost } from './lifecycle-visibility.js';
import type { Session } from './types.js';

const sessionLog = createSessionLog(createLogger('lifecycle'));

/** Every lifecycle notice except the abnormal exit, which always posts. */
export type LifecycleNoticeKind = Exclude<LifecyclePost, 'abnormal-exit'>;

/**
 * The bot's latest lifecycle notice in a thread. Only tracked for `dedup` and
 * `reaction`, so `post` persists exactly what it always did.
 */
export interface LifecycleNotice {
  /** The post that shows the notice, or carries it as a reaction. */
  postId: string;
  kind: LifecycleNoticeKind;
  /** Carried as a reaction: the post's text is not ours to edit. */
  reaction: boolean;
  /**
   * Still the bot's last post in the thread. `updateLastMessage` clears it on
   * the next post the bot makes there.
   */
  trailing: boolean;
}

/**
 * None of these is a reaction control (emoji.ts): the bot's own reaction must
 * not read as a 🔄 resume, a ⏸️ interrupt or a ❌ cancel, and a user clicking
 * it must not trigger one either. All exist on Slack and Mattermost.
 */
export const LIFECYCLE_REACTION_EMOJI: Record<LifecycleNoticeKind, string> = {
  'idle-warning': 'hourglass_flowing_sand',
  'timed-out': 'alarm_clock',
  paused: 'zzz',
  shutdown: 'electric_plug',
  resumed: 'sunrise',
};

/**
 * Whether a thread already shows `next` when its last bot notice is `shown`.
 *
 * A shutdown post exists to be rewritten into the resume notice when the bot
 * comes back, so after a restart the thread reads "Session resumed". The next
 * restart's shutdown notice is the start of that same post again; a thread
 * whose last bot post is a resume notice already shows it. Without this, back
 * to back restarts (the case #606 is about) would never dedup.
 */
function showsSameNotice(shown: LifecycleNoticeKind, next: LifecycleNoticeKind): boolean {
  const restartNotice = (kind: LifecycleNoticeKind) => (kind === 'shutdown' ? 'resumed' : kind);
  return restartNotice(shown) === restartNotice(next);
}

async function react(
  session: Session,
  postId: string,
  kind: LifecycleNoticeKind,
  replacing?: LifecycleNoticeKind,
): Promise<boolean> {
  const emoji = LIFECYCLE_REACTION_EMOJI[kind];
  try {
    await session.platform.addReaction(postId, emoji);
  } catch (err) {
    sessionLog(session).warn(`Lifecycle reaction on ${postId} failed: ${err}`);
    return false;
  }
  const previous = replacing && LIFECYCLE_REACTION_EMOJI[replacing];
  if (previous && previous !== emoji) {
    await session.platform.removeReaction(postId, previous).catch(() => {});
  }
  return true;
}

/**
 * Deliver a NEW lifecycle notice. `create` makes the post the way the call
 * site always did; it is what runs under `post`, and the fallback when there
 * is nothing to dedup against or react to.
 *
 * Returns the post now anchoring the notice — the caller stores it as
 * `lifecyclePostId` — or null when nothing does.
 */
export async function deliverLifecycleNotice(
  session: Session,
  delivery: LifecycleDelivery,
  kind: LifecycleNoticeKind,
  create: () => Promise<PlatformPost | undefined | null>,
): Promise<{ id: string } | null> {
  if (delivery === 'post') return (await create()) ?? null;

  const last = session.lifecycleNotice?.trailing ? session.lifecycleNotice : undefined;

  if (delivery === 'dedup' && last && showsSameNotice(last.kind, kind)) {
    sessionLog(session).debug(`Lifecycle ${kind} deduped onto ${last.postId}`);
    return { id: last.postId };
  }

  if (delivery === 'reaction') {
    // The bot's last post: the notice it already carries if nothing came
    // after it, otherwise the last post the session made this run. Neither is
    // known after a restart until the bot posts again; then it posts.
    const target = last?.postId ?? session.lastMessageId;
    const replacing = last?.reaction ? last.kind : undefined;
    if (target && (await react(session, target, kind, replacing))) {
      session.lifecycleNotice = { postId: target, kind, reaction: true, trailing: true };
      return { id: target };
    }
  }

  const created = await create();
  if (!created) return null;
  session.lifecycleNotice = { postId: created.id, kind, reaction: false, trailing: true };
  return created;
}

/**
 * Rewrite the notice the thread already has (`lifecyclePostId`) to `kind`.
 * `edit` is the call site's own update. When the anchor carries the notice as
 * a reaction its text is someone else's message, so the emoji is swapped and
 * the text left alone.
 */
export async function updateLifecycleNotice(
  session: Session,
  kind: LifecycleNoticeKind,
  edit: () => Promise<unknown>,
): Promise<void> {
  const notice = session.lifecycleNotice;
  const anchored = notice !== undefined && notice.postId === session.lifecyclePostId;
  if (anchored && notice.reaction) {
    await react(session, notice.postId, kind, notice.kind);
  } else {
    await edit();
  }
  if (anchored) notice.kind = kind;
}
