/**
 * Slack working-status helpers.
 *
 * Slack has no typing indicator for bots, but `assistant.threads.setStatus`
 * puts a live "<App> is …" line under the app name. It needs only `chat:write`
 * and a real message timestamp to anchor to.
 */

import { resolvePostThreadId } from '../utils.js';

/**
 * How long a status is left alone before it is set again.
 *
 * `startTyping` ticks every 3s, which is right for Mattermost's websocket
 * frame but wrong for an HTTP Tier-3 method: at that cadence a few concurrent
 * sessions would spend the rate limit re-asserting a status that has not
 * changed. The status persists until replaced, so this is a heartbeat, not a
 * refresh.
 */
export const STATUS_REFRESH_MS = 20_000;

/**
 * The message timestamp a status should hang on, or `undefined` if there is
 * none yet.
 *
 * A real thread anchors to itself. In channel-is-a-task mode the session's
 * thread id is synthetic and must never reach Slack, and there is no thread at
 * all — so the status anchors to the last real message the client processed,
 * which is the one that triggered the work.
 */
export function statusAnchor(
  threadId: string | undefined,
  lastProcessedTs: string | null
): string | undefined {
  return resolvePostThreadId(threadId) ?? lastProcessedTs ?? undefined;
}

/** Whether the status for an anchor is due to be (re)asserted. */
export function dueForRefresh(lastSentAt: number | undefined, now: number): boolean {
  return lastSentAt === undefined || now - lastSentAt >= STATUS_REFRESH_MS;
}
