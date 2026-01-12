/**
 * Post Helper Utilities
 *
 * Centralizes common patterns for posting messages to chat platforms.
 * This eliminates duplication of `session.platform.createPost()` calls
 * and provides consistent formatting with emoji prefixes.
 *
 * Benefits:
 * - DRY: Single implementation for all post operations
 * - Consistency: Standard emoji prefixes for message types
 * - Extensibility: Easy to add logging, metrics, rate limiting
 * - Testability: Can mock a single interface
 */

import type { Session } from './types.js';
import type { PlatformPost, PlatformFormatter } from '../platform/index.js';
import { createLogger } from '../utils/logger.js';
import { withErrorHandling } from './error-handler.js';
import { BUG_REPORT_EMOJI } from '../utils/emoji.js';
import { updateWorktreeActivity } from '../git/worktree.js';

const log = createLogger('helpers');

/** Get session-scoped logger for routing to correct UI panel */
function sessionLog(session: Session) {
  return log.forSession(session.sessionId);
}

// =============================================================================
// Internal Helper
// =============================================================================

/**
 * Create a post and automatically track it as the last message for jump-to-bottom links.
 * This is the core helper used by all post functions to ensure consistent tracking.
 */
async function createPostAndTrack(session: Session, message: string): Promise<PlatformPost> {
  const post = await session.platform.createPost(message, session.threadId);
  // Track this post for jump-to-bottom links in the sticky message
  updateLastMessage(session, post);
  return post;
}

// =============================================================================
// Core Post Functions
// =============================================================================

/**
 * Post an informational message to the session thread.
 * @param session - The session to post to
 * @param message - The message content
 * @returns The created post
 */
export async function postInfo(session: Session, message: string): Promise<PlatformPost> {
  return createPostAndTrack(session, message);
}

/**
 * Post a success message (with ✅ prefix).
 * @param session - The session to post to
 * @param message - The message content (without emoji)
 * @returns The created post
 */
export async function postSuccess(session: Session, message: string): Promise<PlatformPost> {
  return createPostAndTrack(session, `✅ ${message}`);
}

/**
 * Post a warning message (with ⚠️ prefix).
 * @param session - The session to post to
 * @param message - The message content (without emoji)
 * @returns The created post
 */
export async function postWarning(session: Session, message: string): Promise<PlatformPost> {
  return createPostAndTrack(session, `⚠️ ${message}`);
}

/**
 * Post an error message (with ❌ prefix).
 * Adds a bug reaction for quick error reporting.
 * @param session - The session to post to
 * @param message - The message content (without emoji)
 * @param addBugReaction - Whether to add bug reaction for quick reporting (default: true)
 * @returns The created post
 */
export async function postError(
  session: Session,
  message: string,
  addBugReaction = true
): Promise<PlatformPost> {
  const post = await createPostAndTrack(session, `❌ ${message}`);

  // Add bug reaction for quick error reporting
  if (addBugReaction) {
    try {
      await session.platform.addReaction(post.id, BUG_REPORT_EMOJI);
      // Store error context for potential bug report
      session.lastError = {
        postId: post.id,
        message,
        timestamp: new Date(),
      };
    } catch {
      // Ignore if reaction fails - not critical
    }
  }

  return post;
}

/**
 * Post a security/permission message (with 🔐 prefix).
 * @param session - The session to post to
 * @param message - The message content (without emoji)
 * @returns The created post
 */
export async function postSecure(session: Session, message: string): Promise<PlatformPost> {
  return createPostAndTrack(session, `🔐 ${message}`);
}

/**
 * Post a command/action message (with ⚙️ prefix).
 * @param session - The session to post to
 * @param message - The message content (without emoji)
 * @returns The created post
 */
export async function postCommand(session: Session, message: string): Promise<PlatformPost> {
  return createPostAndTrack(session, `⚙️ ${message}`);
}

/**
 * Post a session cancelled message (with 🛑 prefix).
 * @param session - The session to post to
 * @param message - The message content (without emoji)
 * @returns The created post
 */
export async function postCancelled(session: Session, message: string): Promise<PlatformPost> {
  return createPostAndTrack(session, `🛑 ${message}`);
}

/**
 * Post a resume/refresh message (with 🔄 prefix).
 * @param session - The session to post to
 * @param message - The message content (without emoji)
 * @returns The created post
 */
export async function postResume(session: Session, message: string): Promise<PlatformPost> {
  return createPostAndTrack(session, `🔄 ${message}`);
}

/**
 * Post a timeout message (with ⏱️ prefix).
 * @param session - The session to post to
 * @param message - The message content (without emoji)
 * @returns The created post
 */
export async function postTimeout(session: Session, message: string): Promise<PlatformPost> {
  return createPostAndTrack(session, `⏱️ ${message}`);
}

/**
 * Post an interrupt/pause message (with ⏸️ prefix).
 * @param session - The session to post to
 * @param message - The message content (without emoji)
 * @returns The created post
 */
export async function postInterrupt(session: Session, message: string): Promise<PlatformPost> {
  return createPostAndTrack(session, `⏸️ ${message}`);
}

/**
 * Post a worktree/git message (with 🌿 prefix).
 * @param session - The session to post to
 * @param message - The message content (without emoji)
 * @returns The created post
 */
export async function postWorktree(session: Session, message: string): Promise<PlatformPost> {
  return createPostAndTrack(session, `🌿 ${message}`);
}

/**
 * Post a context/thread message (with 🧵 prefix).
 * @param session - The session to post to
 * @param message - The message content (without emoji)
 * @returns The created post
 */
export async function postContext(session: Session, message: string): Promise<PlatformPost> {
  return createPostAndTrack(session, `🧵 ${message}`);
}

/**
 * Post an invite/user message (with 👤 prefix).
 * @param session - The session to post to
 * @param message - The message content (without emoji)
 * @returns The created post
 */
export async function postUser(session: Session, message: string): Promise<PlatformPost> {
  return createPostAndTrack(session, `👤 ${message}`);
}

// =============================================================================
// Post with Reactions
// =============================================================================

/**
 * Post a message and add reaction options.
 * Used for approval/denial prompts, questions, etc.
 *
 * @param session - The session to post to
 * @param message - The message content
 * @param reactions - Array of emoji names to add as reactions
 * @returns The created post
 */
export async function postWithReactions(
  session: Session,
  message: string,
  reactions: string[]
): Promise<PlatformPost> {
  const post = await createPostAndTrack(session, message);
  sessionLog(session).debug(`Posted with ${reactions.length} reactions: ${post.id.substring(0, 8)}`);
  for (const emoji of reactions) {
    try {
      await session.platform.addReaction(post.id, emoji);
    } catch (err) {
      sessionLog(session).warn(`Failed to add reaction :${emoji}:: ${err}`);
    }
  }
  return post;
}

/**
 * Post an approval prompt with thumbs up/down reactions.
 *
 * @param session - The session to post to
 * @param message - The message content
 * @returns The created post
 */
export async function postApprovalPrompt(
  session: Session,
  message: string
): Promise<PlatformPost> {
  return postWithReactions(session, message, ['+1', '-1']);
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get the post ID from a post result.
 * Convenience function for when you only need the ID.
 *
 * @param post - The platform post
 * @returns The post ID
 */
export function getPostId(post: PlatformPost): string {
  return post.id;
}

/**
 * Post and register the post ID for reaction routing.
 * Combines posting with registration in one call.
 *
 * @param session - The session to post to
 * @param message - The message content
 * @param registerPost - Function to register the post for reaction routing
 * @returns The created post
 */
export async function postAndRegister(
  session: Session,
  message: string,
  registerPost: (postId: string, threadId: string) => void
): Promise<PlatformPost | null> {
  const post = await withErrorHandling(
    () => createPostAndTrack(session, message),
    { action: 'Create post', session }
  );
  if (post) {
    sessionLog(session).debug(`Posted and registered: ${post.id.substring(0, 8)}`);
    registerPost(post.id, session.threadId);
  }
  return post ?? null;
}

/**
 * Post with reactions and register for reaction routing.
 *
 * @param session - The session to post to
 * @param message - The message content
 * @param reactions - Array of emoji names to add as reactions
 * @param registerPost - Function to register the post for reaction routing
 * @returns The created post
 */
export async function postWithReactionsAndRegister(
  session: Session,
  message: string,
  reactions: string[],
  registerPost: (postId: string, threadId: string) => void
): Promise<PlatformPost> {
  const post = await postWithReactions(session, message, reactions);
  registerPost(post.id, session.threadId);
  return post;
}

/**
 * Create an interactive post using platform's native interactive post functionality.
 * This is preferred over postWithReactions when available.
 *
 * @param session - The session to post to
 * @param message - The message content
 * @param reactions - Array of emoji names to add as reactions
 * @returns The created post
 */
export async function postInteractive(
  session: Session,
  message: string,
  reactions: string[]
): Promise<PlatformPost> {
  const post = await session.platform.createInteractivePost(message, reactions, session.threadId);
  updateLastMessage(session, post);
  return post;
}

/**
 * Create an interactive post and register for reaction routing.
 *
 * @param session - The session to post to
 * @param message - The message content
 * @param reactions - Array of emoji names to add as reactions
 * @param registerPost - Function to register the post for reaction routing
 * @returns The created post
 */
export async function postInteractiveAndRegister(
  session: Session,
  message: string,
  reactions: string[],
  registerPost: (postId: string, threadId: string) => void
): Promise<PlatformPost> {
  const post = await postInteractive(session, message, reactions);
  registerPost(post.id, session.threadId);
  return post;
}

// =============================================================================
// Update Post Functions
// =============================================================================

/**
 * Update an existing post with new content.
 * Wraps platform.updatePost with consistent error handling.
 *
 * @param session - The session containing the post
 * @param postId - ID of the post to update
 * @param message - New message content
 */
export async function updatePost(
  session: Session,
  postId: string,
  message: string
): Promise<void> {
  await withErrorHandling(
    () => session.platform.updatePost(postId, message),
    { action: 'Update post', session }
  );
}

/**
 * Update a post with a success message (with checkmark prefix).
 *
 * @param session - The session containing the post
 * @param postId - ID of the post to update
 * @param message - Message content (without emoji)
 */
export async function updatePostSuccess(
  session: Session,
  postId: string,
  message: string
): Promise<void> {
  await updatePost(session, postId, `✅ ${message}`);
}

/**
 * Update a post with an error message (with X prefix).
 *
 * @param session - The session containing the post
 * @param postId - ID of the post to update
 * @param message - Message content (without emoji)
 */
export async function updatePostError(
  session: Session,
  postId: string,
  message: string
): Promise<void> {
  await updatePost(session, postId, `❌ ${message}`);
}

/**
 * Update a post with a cancelled message (with no-entry prefix).
 *
 * @param session - The session containing the post
 * @param postId - ID of the post to update
 * @param message - Message content (without emoji)
 */
export async function updatePostCancelled(
  session: Session,
  postId: string,
  message: string
): Promise<void> {
  await updatePost(session, postId, `🚫 ${message}`);
}

// =============================================================================
// Reaction Functions
// =============================================================================

/**
 * Remove a reaction from a post.
 * Wraps platform.removeReaction with consistent error handling.
 *
 * @param session - The session containing the post
 * @param postId - ID of the post to remove the reaction from
 * @param emoji - The emoji name to remove (e.g., 'x', '+1')
 */
export async function removeReaction(
  session: Session,
  postId: string,
  emoji: string
): Promise<void> {
  await withErrorHandling(
    () => session.platform.removeReaction(postId, emoji),
    { action: `Remove ${emoji} reaction`, session }
  );
}

/**
 * Reset session activity state and clear duo-post tracking.
 * Call this when activity occurs to prevent updating stale posts in long threads.
 * Also updates worktree metadata to prevent the cleanup scheduler from
 * pruning actively-used worktrees.
 *
 * @param session - The session to reset activity for
 */
export function resetSessionActivity(session: Session): void {
  session.lastActivityAt = new Date();
  session.timeoutWarningPosted = false;
  session.lifecyclePostId = undefined;
  session.isPaused = undefined;

  // Update worktree metadata to prevent aggressive cleanup of active worktrees.
  // This is fire-and-forget - we don't want to block session activity on disk I/O.
  if (session.worktreeInfo?.worktreePath) {
    void updateWorktreeActivity(session.worktreeInfo.worktreePath, session.sessionId);
  }
}

/**
 * Update the session's last message tracking.
 * This enables "jump to bottom" functionality in thread links.
 *
 * @param session - The session to update
 * @param post - The post that was just created
 */
export function updateLastMessage(session: Session, post: PlatformPost): void {
  session.lastMessageId = post.id;
  // For Slack, we need the timestamp as well (format: "1234567890.123456")
  // The post ID in Slack is the timestamp, so we can use it directly
  if (session.platform.platformType === 'slack') {
    session.lastMessageTs = post.id;
  }
}

// =============================================================================
// Bold/Formatted Message Helpers
// =============================================================================

/**
 * Format a message with bold label using platform-specific formatting.
 * @param formatter - The platform formatter to use
 * @param label - The label to make bold
 * @param rest - Optional rest of the message (not bolded)
 * @example formatBold(formatter, 'Session cancelled', 'by @user') => '**Session cancelled** by @user' (Mattermost)
 * @example formatBold(formatter, 'Session cancelled', 'by @user') => '*Session cancelled* by @user' (Slack)
 */
export function formatBold(formatter: PlatformFormatter, label: string, rest?: string): string {
  return rest ? `${formatter.formatBold(label)} ${rest}` : formatter.formatBold(label);
}

/**
 * Post a message with a bold label.
 * @param session - The session to post to
 * @param emoji - Emoji prefix (or empty string)
 * @param label - Bold label text
 * @param rest - Optional rest of the message
 * @returns The created post
 */
export async function postBold(
  session: Session,
  emoji: string,
  label: string,
  rest?: string
): Promise<PlatformPost> {
  const formatter = session.platform.getFormatter();
  const message = emoji
    ? `${emoji} ${formatBold(formatter, label, rest)}`
    : formatBold(formatter, label, rest);
  return createPostAndTrack(session, message);
}
