/**
 * Message streaming utilities
 *
 * Handles typing indicators, image attachments, and task list positioning.
 *
 * NOTE: Content flushing and message breaking is now handled by MessageManager
 * and ContentExecutor. This module contains utilities that are still needed
 * for session-level operations.
 */

import type { PlatformClient, PlatformFile, PlatformFormatter } from '../platform/index.js';
import { truncateMessageSafely } from '../platform/utils.js';
import type { Session } from './types.js';
import type { ContentBlock } from '../claude/cli.js';
import { MINIMIZE_TOGGLE_EMOJIS } from '../utils/emoji.js';
import { createLogger } from '../utils/logger.js';
import { withErrorHandling } from './error-handler.js';
import { updateLastMessage } from './post-helpers.js';

// Re-export content breaking utilities for backward compatibility
export {
  getCodeBlockState,
  findLogicalBreakpoint,
  shouldFlushEarly,
  endsAtBreakpoint,
  SOFT_BREAK_THRESHOLD,
  MIN_BREAK_THRESHOLD,
  MAX_LINES_BEFORE_BREAK,
} from '../operations/content-breaker.js';

export type { BreakpointType, CodeBlockInfo } from '../operations/content-breaker.js';

const log = createLogger('streaming');

/** Get session-scoped logger for routing to correct UI panel */
function sessionLog(session: Session) {
  return log.forSession(session.sessionId);
}

// ---------------------------------------------------------------------------
// Task list lock utilities
// ---------------------------------------------------------------------------

/**
 * Acquire the task list lock in an atomic manner.
 *
 * This function solves the race condition where multiple concurrent calls
 * could both see `taskListCreationPromise` as undefined and both proceed
 * to create task lists.
 */
export async function acquireTaskListLock(session: Session): Promise<() => void> {
  let resolveCreation: (() => void) | undefined;

  const newPromise = new Promise<void>((resolve) => {
    resolveCreation = resolve;
  });

  const existingPromise = session.taskListCreationPromise;

  // CRITICAL: Immediately set the new promise so any subsequent callers will wait
  session.taskListCreationPromise = existingPromise
    ? existingPromise.then(() => newPromise)
    : newPromise;

  if (existingPromise) {
    await existingPromise;
  }

  return () => {
    if (resolveCreation) {
      resolveCreation();
    }
  };
}

// ---------------------------------------------------------------------------
// Task display helpers
// ---------------------------------------------------------------------------

/**
 * Compute the minimized task list message from the full content.
 * Format: "---\n📋 **Tasks** (X/Y · Z%) · 🔄 TaskName 🔽"
 */
function getMinimizedTaskContent(fullContent: string, formatter: PlatformFormatter): string {
  const progressMatch = fullContent.match(/\((\d+)\/(\d+) · (\d+)%\)/);
  const completed = progressMatch ? parseInt(progressMatch[1], 10) : 0;
  const total = progressMatch ? parseInt(progressMatch[2], 10) : 0;
  const pct = progressMatch ? parseInt(progressMatch[3], 10) : 0;

  // Match both ** (Mattermost) and * (Slack) bold formatting
  const inProgressMatch = fullContent.match(/🔄 \*{1,2}([^*]+)\*{1,2}(?:\s*\((\d+)s\))?/);
  let currentTaskText = '';
  if (inProgressMatch) {
    const taskName = inProgressMatch[1];
    const elapsed = inProgressMatch[2] ? ` (${inProgressMatch[2]}s)` : '';
    currentTaskText = ` · 🔄 ${taskName}${elapsed}`;
  }

  return `${formatter.formatHorizontalRule()}\n📋 ${formatter.formatBold('Tasks')} (${completed}/${total} · ${pct}%)${currentTaskText} 🔽`;
}

/**
 * Get the task content to display based on minimized state.
 */
function getTaskDisplayContent(session: Session): string {
  if (!session.lastTasksContent) {
    return '';
  }
  const formatter = session.platform.getFormatter();
  return session.tasksMinimized
    ? getMinimizedTaskContent(session.lastTasksContent, formatter)
    : session.lastTasksContent;
}

// ---------------------------------------------------------------------------
// Message content building
// ---------------------------------------------------------------------------

/**
 * Build message content for Claude, including images if present.
 * Returns either a string or an array of content blocks.
 */
export async function buildMessageContent(
  text: string,
  platform: PlatformClient,
  files?: PlatformFile[],
  debug: boolean = false
): Promise<string | ContentBlock[]> {
  // Filter to only image files
  const imageFiles = files?.filter(f =>
    f.mimeType.startsWith('image/') &&
    ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(f.mimeType)
  ) || [];

  if (imageFiles.length === 0) {
    return text;
  }

  // Build content blocks with images
  const blocks: ContentBlock[] = [];

  for (const file of imageFiles) {
    try {
      if (!platform.downloadFile) {
        log.warn(`Platform does not support file downloads, skipping ${file.name}`);
        continue;
      }
      const buffer = await platform.downloadFile(file.id);
      const base64 = buffer.toString('base64');

      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: file.mimeType,
          data: base64,
        },
      });

      if (debug) {
        log.debug(`Attached image: ${file.name} (${file.mimeType}, ${Math.round(buffer.length / 1024)}KB)`);
      }
    } catch (err) {
      log.error(`Failed to download image ${file.name}: ${err}`);
    }
  }

  if (text) {
    blocks.push({
      type: 'text',
      text,
    });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Typing indicators
// ---------------------------------------------------------------------------

/**
 * Start sending typing indicators to the platform.
 * Sends immediately, then every 3 seconds until stopped.
 */
export function startTyping(session: Session): void {
  if (session.typingTimer) return;
  session.platform.sendTyping(session.threadId);
  session.typingTimer = setInterval(() => {
    session.platform.sendTyping(session.threadId);
  }, 3000);
}

/**
 * Stop sending typing indicators.
 */
export function stopTyping(session: Session): void {
  if (session.typingTimer) {
    clearInterval(session.typingTimer);
    session.typingTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Task list bumping
// ---------------------------------------------------------------------------

/**
 * Bump the task list to the bottom of the thread.
 *
 * Call this when a user sends a follow-up message to keep the task list
 * below user messages. Deletes the old task post and creates a new one.
 */
export async function bumpTasksToBottom(
  session: Session,
  registerPost?: (postId: string, threadId: string) => void
): Promise<void> {
  // Early exit checks
  if (!session.tasksPostId || !session.lastTasksContent) {
    sessionLog(session).debug('No task list to bump');
    return;
  }

  // Don't bump completed task lists
  if (session.tasksCompleted) {
    sessionLog(session).debug('Tasks completed, not bumping');
    return;
  }

  const releaseLock = await acquireTaskListLock(session);

  try {
    // Re-check conditions after acquiring lock
    if (!session.tasksPostId || !session.lastTasksContent || session.tasksCompleted) {
      sessionLog(session).debug('Task list state changed while waiting for lock');
      return;
    }
    const oldPostId = session.tasksPostId;
    sessionLog(session).debug(`Bumping tasks: deleting old post ${oldPostId.substring(0, 8)}`);

    // Unpin the old task post before deleting
    await session.platform.unpinPost(session.tasksPostId).catch(() => {});

    // Delete the old task post (ignore 404)
    await session.platform.deletePost(session.tasksPostId).catch(() => {});

    // Create a new task post at the bottom
    const displayContent = getTaskDisplayContent(session);

    const newPost = await session.platform.createInteractivePost(
      displayContent,
      [MINIMIZE_TOGGLE_EMOJIS[0]],
      session.threadId
    );
    session.tasksPostId = newPost.id;
    sessionLog(session).debug(`Created new task post ${newPost.id.substring(0, 8)}`);

    if (registerPost) {
      registerPost(newPost.id, session.threadId);
    }
    updateLastMessage(session, newPost);

    // Pin the new task post
    await session.platform.pinPost(newPost.id).catch(() => {});
  } catch (err) {
    sessionLog(session).error(`Failed to bump tasks to bottom: ${err}`);
  } finally {
    releaseLock();
  }
}

/**
 * Bump the task list to the bottom by reusing its post for new content.
 *
 * When we need to create a new post and a task list exists, we:
 * 1. Update the task list post with the new content (repurposing it)
 * 2. Create a fresh task list post at the bottom
 */
export async function bumpTasksToBottomWithContent(
  session: Session,
  newContent: string,
  registerPost: (postId: string, threadId: string) => void
): Promise<string> {
  const releaseLock = await acquireTaskListLock(session);

  try {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const oldTasksPostId = session.tasksPostId!;
    const oldTasksContent = session.lastTasksContent;

    sessionLog(session).debug(`Bumping tasks to bottom, repurposing post ${oldTasksPostId.substring(0, 8)}`);

    const { maxLength: MAX_POST_LENGTH } = session.platform.getMessageLimits();

    let contentToPost = newContent;
    if (contentToPost.length > MAX_POST_LENGTH) {
      sessionLog(session).warn(`Content too long for repurposed post (${contentToPost.length}), truncating`);
      const formatter = session.platform.getFormatter();
      contentToPost = truncateMessageSafely(
        contentToPost,
        MAX_POST_LENGTH,
        formatter.formatItalic('... (truncated)')
      );
    }

    // Remove the toggle emoji from the old task post
    try {
      await session.platform.removeReaction(oldTasksPostId, MINIMIZE_TOGGLE_EMOJIS[0]);
    } catch (err) {
      sessionLog(session).debug(`Could not remove toggle emoji: ${err}`);
    }

    await session.platform.unpinPost(oldTasksPostId).catch(() => {});

    let repurposedPostId: string | null = null;
    try {
      await session.platform.updatePost(oldTasksPostId, contentToPost);
      repurposedPostId = oldTasksPostId;
      registerPost(oldTasksPostId, session.threadId);
    } catch (err) {
      sessionLog(session).debug(`Could not repurpose task post (creating new): ${err}`);
      const newPost = await session.platform.createPost(contentToPost, session.threadId);
      repurposedPostId = newPost.id;
      registerPost(newPost.id, session.threadId);
      updateLastMessage(session, newPost);
    }

    // Create a new task list post at the bottom
    if (oldTasksContent) {
      const displayContent = getTaskDisplayContent(session);

      const newTasksPost = await session.platform.createInteractivePost(
        displayContent,
        [MINIMIZE_TOGGLE_EMOJIS[0]],
        session.threadId
      );
      session.tasksPostId = newTasksPost.id;
      sessionLog(session).debug(`Created new task post ${newTasksPost.id.substring(0, 8)}`);
      registerPost(newTasksPost.id, session.threadId);
      updateLastMessage(session, newTasksPost);
      await session.platform.pinPost(newTasksPost.id).catch(() => {});
    } else {
      session.tasksPostId = null;
    }

    return repurposedPostId || oldTasksPostId;
  } finally {
    releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Scheduled updates (used by manager for flush scheduling)
// ---------------------------------------------------------------------------

/**
 * Schedule a delayed flush of the session's pending content.
 */
export function scheduleUpdate(session: Session, onFlush: (session: Session) => Promise<void>): void {
  if (session.updateTimer) return;
  session.updateTimer = setTimeout(() => {
    session.updateTimer = null;
    onFlush(session);
  }, 500);
}

/**
 * Clear flushed content from pendingContent, preserving any content added during the async flush.
 */
export function clearFlushedContent(session: Session, flushedContent: string): void {
  if (session.pendingContent.startsWith(flushedContent)) {
    session.pendingContent = session.pendingContent.slice(flushedContent.length);
  } else {
    session.pendingContent = '';
  }
}

// ---------------------------------------------------------------------------
// Legacy flush (still used by manager.appendContent until full migration)
// ---------------------------------------------------------------------------

/**
 * Flush pending content to the platform.
 *
 * NOTE: This is a transitional function. MessageManager and ContentExecutor
 * now handle flushing for event-driven content. This function is kept for
 * session-level operations (compaction, context prompts, etc.) that still
 * use the old streaming path.
 */
export async function flush(
  session: Session,
  registerPost: (postId: string, threadId: string) => void
): Promise<void> {
  if (!session.pendingContent.trim()) {
    return;
  }

  const pendingAtFlushStart = session.pendingContent;
  const formatter = session.platform.getFormatter();
  let content = formatter.formatMarkdown(pendingAtFlushStart).trim();

  const { maxLength: MAX_POST_LENGTH } = session.platform.getMessageLimits();

  if (content.length > MAX_POST_LENGTH) {
    sessionLog(session).warn(`Content too long (${content.length}), truncating`);
    content = truncateMessageSafely(
      content,
      MAX_POST_LENGTH,
      formatter.formatItalic('... (truncated)')
    );
  }

  if (session.currentPostId) {
    const postId = session.currentPostId;
    try {
      const combinedContent = session.currentPostContent
        ? session.currentPostContent + content
        : content;
      await session.platform.updatePost(postId, combinedContent);
      session.currentPostContent = combinedContent;
      clearFlushedContent(session, pendingAtFlushStart);
    } catch {
      sessionLog(session).debug('Update failed, will create new post on next flush');
      session.currentPostId = null;
      session.currentPostContent = '';
    }
  } else {
    // Check if we should reuse task list post
    const hasActiveTasks = session.tasksPostId && session.lastTasksContent && !session.tasksCompleted;
    if (hasActiveTasks) {
      const postId = await bumpTasksToBottomWithContent(session, content, registerPost);
      session.currentPostId = postId;
      session.currentPostContent = content;
      clearFlushedContent(session, pendingAtFlushStart);
    } else {
      const post = await withErrorHandling(
        () => session.platform.createPost(content, session.threadId),
        { action: 'Create new post', session }
      );
      if (post) {
        session.currentPostId = post.id;
        session.currentPostContent = content;
        sessionLog(session).debug(`Created post ${post.id.substring(0, 8)}`);
        registerPost(post.id, session.threadId);
        updateLastMessage(session, post);
        clearFlushedContent(session, pendingAtFlushStart);
      }
    }
  }
}
