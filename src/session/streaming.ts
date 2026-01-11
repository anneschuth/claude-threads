/**
 * Message streaming and flushing utilities
 *
 * Handles buffering, formatting, and posting Claude responses to the platform.
 * Implements logical message breaking to avoid content collapse on chat platforms.
 */

import type { PlatformClient, PlatformFile, PlatformFormatter } from '../platform/index.js';
import { truncateMessageSafely } from '../platform/utils.js';
import type { Session } from './types.js';
import type { ContentBlock } from '../claude/cli.js';
import { MINIMIZE_TOGGLE_EMOJIS } from '../utils/emoji.js';
import { createLogger } from '../utils/logger.js';
import { withErrorHandling } from './error-handler.js';
import { updateLastMessage } from './post-helpers.js';

// Import content breaking utilities from the extracted module
import {
  getCodeBlockState,
  findLogicalBreakpoint,
  shouldFlushEarly,
  SOFT_BREAK_THRESHOLD,
  MIN_BREAK_THRESHOLD,
} from '../operations/content-breaker.js';

// Re-export for backward compatibility (streaming.ts was the original location)
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

// ---------------------------------------------------------------------------
// Task list lock utilities
// ---------------------------------------------------------------------------

/**
 * Acquire the task list lock in an atomic manner.
 *
 * This function solves the race condition where multiple concurrent calls
 * could both see `taskListCreationPromise` as undefined and both proceed
 * to create task lists. By chaining the new promise onto the existing one
 * (or creating a new chain if none exists) in a single synchronous operation,
 * we ensure that all callers properly serialize their access.
 *
 * The key insight is that in JavaScript's event loop, synchronous code runs
 * atomically (no interleaving). By immediately setting the new promise in
 * the same synchronous block where we check for existing promises, we prevent
 * the race condition where two callers both see "no lock" simultaneously.
 *
 * @param session - The session to acquire the lock for
 * @returns A promise that resolves to a release function when the lock is acquired
 */
export async function acquireTaskListLock(session: Session): Promise<() => void> {
  let resolveCreation: (() => void) | undefined;

  // Create a new promise that will be resolved when the caller releases the lock
  const newPromise = new Promise<void>((resolve) => {
    resolveCreation = resolve;
  });

  // Get the existing promise (may be undefined)
  const existingPromise = session.taskListCreationPromise;

  // CRITICAL: This is the atomic part - we immediately set the new promise
  // so any subsequent callers will see it and wait on it.
  // We chain onto the existing promise (if any) so operations serialize.
  session.taskListCreationPromise = existingPromise
    ? existingPromise.then(() => newPromise)
    : newPromise;

  // Wait for our turn (if there was an existing promise, wait for it)
  if (existingPromise) {
    await existingPromise;
  }

  // Now we have the lock - return the release function
  return () => {
    if (resolveCreation) {
      resolveCreation();
    }
    // Note: we don't clear taskListCreationPromise here because other
    // callers may have already chained onto it. The promise chain will
    // naturally resolve and eventually be garbage collected.
  };
}

/** Get session-scoped logger for routing to correct UI panel */
function sessionLog(session: Session) {
  return log.forSession(session.sessionId);
}

// ---------------------------------------------------------------------------
// Task display helpers
// ---------------------------------------------------------------------------

/**
 * Compute the minimized task list message from the full content.
 * Format: "---\n📋 **Tasks** (X/Y · Z%) · 🔄 TaskName 🔽"
 */
function getMinimizedTaskContent(fullContent: string, formatter: PlatformFormatter): string {
  // Parse progress from content (format: "📋 **Tasks** (X/Y · Z%)")
  const progressMatch = fullContent.match(/\((\d+)\/(\d+) · (\d+)%\)/);
  const completed = progressMatch ? parseInt(progressMatch[1], 10) : 0;
  const total = progressMatch ? parseInt(progressMatch[2], 10) : 0;
  const pct = progressMatch ? parseInt(progressMatch[3], 10) : 0;

  // Find current in-progress task
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
 * If minimized, returns the compact summary; otherwise the full content.
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
// Scheduled updates
// ---------------------------------------------------------------------------

/**
 * Schedule a delayed flush of the session's pending content.
 * If an update is already scheduled, this is a no-op.
 *
 * Used during streaming to batch updates and avoid excessive API calls.
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
 *
 * This is critical for avoiding race conditions: during async operations (createPost, updatePost),
 * new content may be appended to pendingContent. We only want to clear what we actually posted,
 * not content added during the async operation.
 *
 * @param session - The session to update
 * @param flushedContent - The content that was captured at flush start and successfully posted
 */
export function clearFlushedContent(session: Session, flushedContent: string): void {
  // If pendingContent still starts with exactly what we flushed, remove it
  // This handles the case where new content was appended during the async operation
  if (session.pendingContent.startsWith(flushedContent)) {
    session.pendingContent = session.pendingContent.slice(flushedContent.length);
  } else {
    // Content changed unexpectedly - clear it all to prevent accumulation
    // This is safer than leaving stale content that would accumulate
    session.pendingContent = '';
  }
}

/**
 * Build message content for Claude, including images if present.
 * Returns either a string or an array of content blocks.
 *
 * @param text - The text message
 * @param platform - Platform client for downloading images
 * @param files - Optional files attached to the message
 * @param debug - Whether to log debug info
 * @returns Plain string or content blocks array with images
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

  // If no images, return plain text
  if (imageFiles.length === 0) {
    return text;
  }

  // Build content blocks with images
  const blocks: ContentBlock[] = [];

  // Download and add each image
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

  // Add the text message
  if (text) {
    blocks.push({
      type: 'text',
      text,
    });
  }

  return blocks;
}

/**
 * Start sending typing indicators to the platform.
 * Sends immediately, then every 3 seconds until stopped.
 */
export function startTyping(session: Session): void {
  if (session.typingTimer) return;
  // Send typing immediately, then every 3 seconds
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

/**
 * Bump the task list to the bottom by reusing its post for new content.
 *
 * When we need to create a new post and a task list exists, we:
 * 1. Update the task list post with the new content (repurposing it)
 * 2. Create a fresh task list post at the bottom
 *
 * This keeps the task list visually at the bottom without deleting messages.
 *
 * @param session - The session
 * @param newContent - Content to put in the repurposed post
 * @param registerPost - Callback to register post for reaction routing
 * @returns The post ID that now contains the content (was the task list post)
 */
async function bumpTasksToBottomWithContent(
  session: Session,
  newContent: string,
  registerPost: (postId: string, threadId: string) => void
): Promise<string> {
  // Acquire the lock atomically - this prevents race conditions where
  // multiple concurrent calls could both proceed simultaneously.
  const releaseLock = await acquireTaskListLock(session);

  try {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- caller checks tasksPostId exists
    const oldTasksPostId = session.tasksPostId!;
    const oldTasksContent = session.lastTasksContent;

    sessionLog(session).debug(`Bumping tasks to bottom, repurposing post ${oldTasksPostId.substring(0, 8)}`);

    // Get platform-specific message size limits
    const { maxLength: MAX_POST_LENGTH } = session.platform.getMessageLimits();

    // Safety truncation if content exceeds platform limits
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

    // Remove the toggle emoji from the old task post before repurposing it
    try {
      await session.platform.removeReaction(oldTasksPostId, MINIMIZE_TOGGLE_EMOJIS[0]);
    } catch (err) {
      sessionLog(session).debug(`Could not remove toggle emoji: ${err}`);
    }

    // Unpin the old task post before repurposing it
    await session.platform.unpinPost(oldTasksPostId).catch(() => {});

    // Try to repurpose the task list post for the new content
    // If update fails (e.g., stale post ID from persistence, deleted post, or permission issue),
    // fall back to creating a new post
    let repurposedPostId: string | null = null;
    try {
      await session.platform.updatePost(oldTasksPostId, contentToPost);
      repurposedPostId = oldTasksPostId;
      registerPost(oldTasksPostId, session.threadId);
    } catch (err) {
      // Update failed - log at debug level (this is expected for stale persisted task posts)
      sessionLog(session).debug(`Could not repurpose task post (creating new): ${err}`);
      // Create a new post instead
      const newPost = await session.platform.createPost(contentToPost, session.threadId);
      repurposedPostId = newPost.id;
      registerPost(newPost.id, session.threadId);
      updateLastMessage(session, newPost);
    }

    // Create a new task list post at the bottom (if we have content to show)
    if (oldTasksContent) {
      // Preserve the minimized state for content, but always add the toggle emoji
      // (emoji is always present as a clickable button; user clicks to toggle)
      const displayContent = getTaskDisplayContent(session);

      const newTasksPost = await session.platform.createInteractivePost(
        displayContent,
        [MINIMIZE_TOGGLE_EMOJIS[0]], // Always add toggle emoji
        session.threadId
      );
      session.tasksPostId = newTasksPost.id;
      sessionLog(session).debug(`Created new task post ${newTasksPost.id.substring(0, 8)}`);
      // Register the new task post so reaction clicks are routed to this session
      registerPost(newTasksPost.id, session.threadId);
      // Track for jump-to-bottom links
      updateLastMessage(session, newTasksPost);
      // Pin the new task post
      await session.platform.pinPost(newTasksPost.id).catch(() => {});
    } else {
      // No task content to re-post, clear the task post ID
      session.tasksPostId = null;
    }

    // Return the ID of the post that now contains the repurposed content
    // (either the original post if update succeeded, or the new post if fallback was used)
    return repurposedPostId || oldTasksPostId;
  } finally {
    // Release the lock so other callers can proceed
    releaseLock();
  }
}

/**
 * Bump the task list to the bottom of the thread.
 *
 * Call this when a user sends a follow-up message to keep the task list
 * below user messages. Deletes the old task post and creates a new one.
 *
 * @param session - The session
 * @param registerPost - Callback to register the new post for reaction routing
 */
export async function bumpTasksToBottom(
  session: Session,
  registerPost?: (postId: string, threadId: string) => void
): Promise<void> {
  // Early exit checks (before acquiring lock)
  if (!session.tasksPostId || !session.lastTasksContent) {
    sessionLog(session).debug('No task list to bump');
    return; // No task list to bump
  }

  // Don't bump completed task lists - they can stay where they are
  if (session.tasksCompleted) {
    sessionLog(session).debug('Tasks completed, not bumping');
    return;
  }

  // Acquire the lock atomically - this prevents race conditions where
  // multiple concurrent calls could both proceed simultaneously.
  const releaseLock = await acquireTaskListLock(session);

  try {
    // Re-check conditions after acquiring lock (state may have changed)
    if (!session.tasksPostId || !session.lastTasksContent || session.tasksCompleted) {
      sessionLog(session).debug('Task list state changed while waiting for lock');
      return;
    }
    const oldPostId = session.tasksPostId;
    sessionLog(session).debug(`Bumping tasks: deleting old post ${oldPostId.substring(0, 8)}`);

    // Unpin the old task post before deleting
    await session.platform.unpinPost(session.tasksPostId).catch(() => {});

    // Delete the old task post (ignore 404 - post may already be gone)
    await session.platform.deletePost(session.tasksPostId).catch(() => {});

    // Create a new task post at the bottom, preserving minimized state for content
    // but always adding the toggle emoji (it's always present as a clickable button)
    const displayContent = getTaskDisplayContent(session);

    const newPost = await session.platform.createInteractivePost(
      displayContent,
      [MINIMIZE_TOGGLE_EMOJIS[0]], // Always add toggle emoji
      session.threadId
    );
    session.tasksPostId = newPost.id;
    sessionLog(session).debug(`Created new task post ${newPost.id.substring(0, 8)}`);
    // Register the task post so reaction clicks are routed to this session
    if (registerPost) {
      registerPost(newPost.id, session.threadId);
    }
    // Track for jump-to-bottom links
    updateLastMessage(session, newPost);
    // Pin the new task post
    await session.platform.pinPost(newPost.id).catch(() => {});
  } catch (err) {
    sessionLog(session).error(`Failed to bump tasks to bottom: ${err}`);
  } finally {
    // Release the lock so other callers can proceed
    releaseLock();
  }
}

/**
 * Flush pending content to the platform.
 *
 * Handles:
 * - Logical message breaking (headings, tool results, code blocks)
 * - Soft threshold breaking to avoid "Show More" collapse
 * - Hard message length limits (splits into multiple posts if needed)
 * - Creating vs updating posts
 * - Post registration for reaction routing
 * - Keeping task list at the bottom (sticky tasks)
 *
 * @param session - The session to flush
 * @param registerPost - Callback to register post for reaction routing
 */
export async function flush(
  session: Session,
  registerPost: (postId: string, threadId: string) => void
): Promise<void> {
  if (!session.pendingContent.trim()) {
    return;  // No content to flush - silent return
  }

  // Capture the pending content at the start of flush.
  // This is critical: during async operations (createPost, updatePost), new content
  // may be appended to pendingContent. We only want to clear what we actually posted,
  // not content added during the async operation.
  const pendingAtFlushStart = session.pendingContent;

  // Format markdown for the target platform
  // This converts standard markdown to the platform's native format
  const formatter = session.platform.getFormatter();
  let content = formatter.formatMarkdown(pendingAtFlushStart).trim();

  // Get platform-specific message size limits
  const { maxLength: MAX_POST_LENGTH, hardThreshold: HARD_CONTINUATION_THRESHOLD } =
    session.platform.getMessageLimits();

  // Check if we should break early based on logical breakpoints
  // This helps avoid "Show More" collapse on some platforms
  const shouldBreakEarly = session.currentPostId &&
    content.length > MIN_BREAK_THRESHOLD &&
    shouldFlushEarly(content);

  // Check if we need to start a new message due to length or logical breakpoint
  if (session.currentPostId && (content.length > HARD_CONTINUATION_THRESHOLD || shouldBreakEarly)) {
    // Capture the post ID - we've confirmed it's truthy in the condition above
    const currentPostId = session.currentPostId;

    // Determine where to break
    let breakPoint: number;

    // Track if we're breaking inside a code block (so we can move it to next message)
    let codeBlockLanguage: string | undefined;
    let codeBlockOpenPosition: number | undefined;

    if (content.length > HARD_CONTINUATION_THRESHOLD) {
      // Hard break: we're at the limit, must break now
      // Try to find a logical breakpoint near the threshold
      const startSearchPos = Math.floor(HARD_CONTINUATION_THRESHOLD * 0.7);
      const breakInfo = findLogicalBreakpoint(
        content,
        startSearchPos,
        Math.floor(HARD_CONTINUATION_THRESHOLD * 0.3)
      );
      if (breakInfo) {
        breakPoint = breakInfo.position;
      } else {
        // findLogicalBreakpoint returned null - we might be inside a code block
        // Check if we're inside a code block at the desired break position
        const codeBlockState = getCodeBlockState(content, startSearchPos);

        if (codeBlockState.isInside) {
          // We're inside a code block and can't find its end within the lookahead
          // We'll split before the code block so it moves to the next message
          codeBlockLanguage = codeBlockState.language;
          codeBlockOpenPosition = codeBlockState.openPosition;
          // Temporary breakPoint - will be overridden below to split before code block
          breakPoint = HARD_CONTINUATION_THRESHOLD;
        } else {
          // Not inside a code block, just couldn't find a good breakpoint
          // Fallback: find any line break
          breakPoint = content.lastIndexOf('\n', HARD_CONTINUATION_THRESHOLD);
          if (breakPoint < HARD_CONTINUATION_THRESHOLD * 0.7) {
            breakPoint = HARD_CONTINUATION_THRESHOLD;
          }
        }
      }
    } else {
      // Soft break: we've exceeded soft threshold, find a good logical breakpoint
      const breakInfo = findLogicalBreakpoint(content, SOFT_BREAK_THRESHOLD);
      if (breakInfo && breakInfo.position < content.length) {
        breakPoint = breakInfo.position;
      } else {
        // No good breakpoint found, just update the current post and wait
        try {
          await session.platform.updatePost(currentPostId, content);
        } catch {
          // Update failed - post may have been deleted. Clear the post ID
          // so the next flush will create a new post instead of retrying.
          sessionLog(session).debug('Update failed (no breakpoint), will create new post on next flush');
          session.currentPostId = null;
        }
        return;
      }
    }

    // If we're inside a code block, split BEFORE the code block starts
    // so the entire code block moves to the next message
    if (codeBlockLanguage !== undefined && codeBlockOpenPosition !== undefined) {
      if (codeBlockOpenPosition === 0) {
        // Code block is at the very start, can't split before it - just update and wait
        try {
          await session.platform.updatePost(currentPostId, content);
        } catch {
          sessionLog(session).debug('Update failed (code block at start), will create new post on next flush');
          session.currentPostId = null;
        }
        return;
      }

      // Find the last newline before the code block to get a clean break
      const breakBeforeCodeBlock = content.lastIndexOf('\n', codeBlockOpenPosition);
      if (breakBeforeCodeBlock > 0) {
        breakPoint = breakBeforeCodeBlock;
      } else {
        // No good break point before the code block - just update and wait
        try {
          await session.platform.updatePost(currentPostId, content);
        } catch {
          sessionLog(session).debug('Update failed (no break before code block), will create new post on next flush');
          session.currentPostId = null;
        }
        return;
      }
    }

    // Split at the breakpoint
    const firstPart = content.substring(0, breakPoint).trim();
    const remainder = content.substring(breakPoint).trim();

    // Update the current post with the first part
    try {
      await session.platform.updatePost(currentPostId, firstPart);
    } catch {
      // Update failed - post may have been deleted. Log at debug level since
      // we're about to start a new post anyway, so this is not critical.
      sessionLog(session).debug('Update failed during split, continuing with new post');
    }

    // Start a new post for the continuation
    session.currentPostId = null;
    session.pendingContent = remainder;

    // Create the continuation post if there's content
    if (remainder) {
      // If we have an active (non-completed) task list, reuse its post and bump it to the bottom
      const hasActiveTasks = session.tasksPostId && session.lastTasksContent && !session.tasksCompleted;
      if (hasActiveTasks) {
        const postId = await bumpTasksToBottomWithContent(session, remainder, registerPost);
        session.currentPostId = postId;
      } else {
        const post = await withErrorHandling(
          () => session.platform.createPost(remainder, session.threadId),
          { action: 'Create continuation post', session }
        );
        if (post) {
          session.currentPostId = post.id;
          registerPost(post.id, session.threadId);
          updateLastMessage(session, post);
        }
      }
    }
    return;
  }

  // Normal case: content fits in current post
  if (content.length > MAX_POST_LENGTH) {
    // Safety truncation if we somehow got content that's still too long
    sessionLog(session).warn(`Content too long (${content.length}), truncating`);
    const formatter = session.platform.getFormatter();
    content = truncateMessageSafely(
      content,
      MAX_POST_LENGTH,
      formatter.formatItalic('... (truncated)')
    );
  }

  if (session.currentPostId) {
    const postId = session.currentPostId;
    try {
      // Combine existing content with new content for the update.
      // updatePost replaces content, so we need to include what's already posted.
      const combinedContent = session.currentPostContent
        ? session.currentPostContent + content
        : content;
      await session.platform.updatePost(postId, combinedContent);
      // Track what we've posted for future updates
      session.currentPostContent = combinedContent;
      // Clear the flushed content, preserving any content added during the async operation
      clearFlushedContent(session, pendingAtFlushStart);
    } catch {
      // Update failed - post may have been deleted. Clear the post ID
      // so the next flush will create a new post instead of retrying.
      sessionLog(session).debug('Update failed, will create new post on next flush');
      session.currentPostId = null;
      session.currentPostContent = '';
    }
  } else {
    // Need to create a new post
    // If we have an active (non-completed) task list, reuse its post and bump it to the bottom
    const hasActiveTasks = session.tasksPostId && session.lastTasksContent && !session.tasksCompleted;
    if (hasActiveTasks) {
      const postId = await bumpTasksToBottomWithContent(session, content, registerPost);
      session.currentPostId = postId;
      session.currentPostContent = content;
      // Clear the flushed content, preserving any content added during the async operation
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
        // Register post for reaction routing
        registerPost(post.id, session.threadId);
        // Track for jump-to-bottom links
        updateLastMessage(session, post);
        // Clear the flushed content, preserving any content added during the async operation
        clearFlushedContent(session, pendingAtFlushStart);
      }
    }
  }
}
