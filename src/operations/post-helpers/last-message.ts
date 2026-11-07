/**
 * Last-message tracking, kept free of runtime imports so low-level modules
 * (the error handler) can use it without an import cycle via post-helpers.
 */

import type { Session } from '../../session/types.js';
import type { PlatformPost } from '../../platform/index.js';

/**
 * Update the session's last message tracking.
 * This enables "jump to bottom" functionality in thread links.
 *
 * @param session - The session to update
 * @param post - The post that was just created
 */
export function updateLastMessage(session: Session, post: PlatformPost): void {
  session.lastMessageId = post.id;
  // A newer bot post: the last lifecycle notice no longer ends the thread, so
  // `dedup` must not refresh it nor `reaction` land on it.
  if (session.lifecycleNotice && session.lifecycleNotice.postId !== post.id) {
    session.lifecycleNotice.trailing = false;
  }
  // For Slack, we need the timestamp as well (format: "1234567890.123456")
  // The post ID in Slack is the timestamp, so we can use it directly
  if (session.platform.platformType === 'slack') {
    session.lastMessageTs = post.id;
  }
}
