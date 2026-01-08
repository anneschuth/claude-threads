/**
 * Thread-level sticky post management
 *
 * Manages posts that should stay at the bottom of a thread:
 * - Plan approval: Just above task list while pending
 * - Task list: Always at the very bottom while not completed
 *
 * Order (bottom to top): [content] [plan approval] [task list]
 */

import type { PlatformFormatter } from '../platform/index.js';
import type { Session } from './types.js';
import { TASK_TOGGLE_EMOJIS, APPROVAL_EMOJIS, DENIAL_EMOJIS } from '../utils/emoji.js';
import { withErrorHandling } from './error-handler.js';
import { updateLastMessage } from './post-helpers.js';
import { createLogger } from '../utils/logger.js';
import { truncateMessageSafely } from '../platform/utils.js';

const log = createLogger('sticky-thread');

/** Get session-scoped logger for routing to correct UI panel */
function sessionLog(session: Session) {
  return log.forSession(session.sessionId);
}

// ---------------------------------------------------------------------------
// Lock management
// ---------------------------------------------------------------------------

/**
 * Acquire the sticky post lock in an atomic manner.
 *
 * This function solves the race condition where multiple concurrent calls
 * could both see the lock as undefined and both proceed to modify sticky posts.
 * By chaining the new promise onto the existing one (or creating a new chain
 * if none exists) in a single synchronous operation, we ensure that all
 * callers properly serialize their access.
 *
 * The key insight is that in JavaScript's event loop, synchronous code runs
 * atomically (no interleaving). By immediately setting the new promise in
 * the same synchronous block where we check for existing promises, we prevent
 * the race condition where two callers both see "no lock" simultaneously.
 *
 * @param session - The session to acquire the lock for
 * @returns A promise that resolves to a release function when the lock is acquired
 */
export async function acquireStickyLock(session: Session): Promise<() => void> {
  let resolveCreation: (() => void) | undefined;

  // Create a new promise that will be resolved when the caller releases the lock
  const newPromise = new Promise<void>((resolve) => {
    resolveCreation = resolve;
  });

  // Get the existing promise (may be undefined)
  // Support both old and new field names for backward compatibility
  const existingPromise = session.stickyPostLock ?? session.taskListCreationPromise;

  // CRITICAL: This is the atomic part - we immediately set the new promise
  // so any subsequent callers will see it and wait on it.
  // We chain onto the existing promise (if any) so operations serialize.
  const chainedPromise = existingPromise
    ? existingPromise.then(() => newPromise)
    : newPromise;

  // Set both fields for compatibility
  session.stickyPostLock = chainedPromise;
  session.taskListCreationPromise = chainedPromise;

  // Wait for our turn (if there was an existing promise, wait for it)
  if (existingPromise) {
    await existingPromise;
  }

  // Now we have the lock - return the release function
  return () => {
    if (resolveCreation) {
      resolveCreation();
    }
    // Note: we don't clear the lock here because other callers may have
    // already chained onto it. The promise chain will naturally resolve
    // and eventually be garbage collected.
  };
}

// Backward compatibility alias
export { acquireStickyLock as acquireTaskListLock };

// ---------------------------------------------------------------------------
// Task display helpers
// ---------------------------------------------------------------------------

/**
 * Compute the minimized task list message from the full content.
 * Format: "---\n📋 **Tasks** (X/Y · Z%) · 🔄 TaskName 🔽"
 */
export function getMinimizedTaskContent(fullContent: string, formatter: PlatformFormatter): string {
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
export function getTaskDisplayContent(session: Session): string {
  if (!session.lastTasksContent) {
    return '';
  }
  const formatter = session.platform.getFormatter();
  return session.tasksMinimized
    ? getMinimizedTaskContent(session.lastTasksContent, formatter)
    : session.lastTasksContent;
}

// ---------------------------------------------------------------------------
// Plan approval bumping
// ---------------------------------------------------------------------------

/**
 * Bump the plan approval message to the bottom of the thread.
 *
 * Call this when new content is posted to keep the plan approval prompt
 * visible at the bottom while it's pending.
 *
 * @param session - The session
 * @param registerPost - Callback to register the new post for reaction routing
 */
export async function bumpPlanApprovalToBottom(
  session: Session,
  registerPost: (postId: string, threadId: string) => void
): Promise<void> {
  // Early exit if no pending plan approval
  if (!session.pendingApproval || session.pendingApproval.type !== 'plan') {
    return;
  }

  // Need content to recreate the post
  if (!session.pendingApproval.content) {
    sessionLog(session).debug('No plan approval content stored, cannot bump');
    return;
  }

  // Acquire the lock atomically
  const releaseLock = await acquireStickyLock(session);

  try {
    // Re-check after acquiring lock (state may have changed)
    if (!session.pendingApproval || session.pendingApproval.type !== 'plan') {
      return;
    }

    const oldPostId = session.pendingApproval.postId;
    const content = session.pendingApproval.content;

    sessionLog(session).debug(`Bumping plan approval: deleting old post ${oldPostId.substring(0, 8)}`);

    // Delete the old post
    await session.platform.deletePost(oldPostId);

    // Create new post at bottom with the same content and reactions
    const newPost = await session.platform.createInteractivePost(
      content,
      [APPROVAL_EMOJIS[0], DENIAL_EMOJIS[0]],
      session.threadId
    );

    // Update the post ID
    session.pendingApproval.postId = newPost.id;
    sessionLog(session).debug(`Created new plan approval post ${newPost.id.substring(0, 8)}`);

    // Register for reaction routing
    registerPost(newPost.id, session.threadId);

    // Track for jump-to-bottom links
    updateLastMessage(session, newPost);
  } catch (err) {
    sessionLog(session).error(`Failed to bump plan approval: ${err}`);
  } finally {
    releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Task list bumping
// ---------------------------------------------------------------------------

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
export async function bumpTasksToBottomWithContent(
  session: Session,
  newContent: string,
  registerPost: (postId: string, threadId: string) => void
): Promise<string> {
  // Acquire the lock atomically - this prevents race conditions where
  // multiple concurrent calls could both proceed simultaneously.
  const releaseLock = await acquireStickyLock(session);

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
      await session.platform.removeReaction(oldTasksPostId, TASK_TOGGLE_EMOJIS[0]);
    } catch (err) {
      sessionLog(session).debug(`Could not remove toggle emoji: ${err}`);
    }

    // Unpin the old task post before repurposing it
    await session.platform.unpinPost(oldTasksPostId).catch(() => {});

    // Repurpose the task list post for the new content
    await withErrorHandling(
      () => session.platform.updatePost(oldTasksPostId, contentToPost),
      { action: 'Repurpose task post', session }
    );
    registerPost(oldTasksPostId, session.threadId);

    // Create a new task list post at the bottom (if we have content to show)
    if (oldTasksContent) {
      // Preserve the minimized state for content, but always add the toggle emoji
      // (emoji is always present as a clickable button; user clicks to toggle)
      const displayContent = getTaskDisplayContent(session);

      const newTasksPost = await session.platform.createInteractivePost(
        displayContent,
        [TASK_TOGGLE_EMOJIS[0]], // Always add toggle emoji
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

    return oldTasksPostId;
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
  const releaseLock = await acquireStickyLock(session);

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

    // Delete the old task post
    await session.platform.deletePost(session.tasksPostId);

    // Create a new task post at the bottom, preserving minimized state for content
    // but always adding the toggle emoji (it's always present as a clickable button)
    const displayContent = getTaskDisplayContent(session);

    const newPost = await session.platform.createInteractivePost(
      displayContent,
      [TASK_TOGGLE_EMOJIS[0]], // Always add toggle emoji
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

// ---------------------------------------------------------------------------
// Unified sticky post management
// ---------------------------------------------------------------------------

/**
 * Bump all sticky posts to the bottom in correct order.
 *
 * This ensures:
 * 1. Plan approval is bumped first (if pending)
 * 2. Task list is bumped last (so it's always at the very bottom)
 *
 * Call this when new content is posted to keep sticky posts at the bottom.
 *
 * @param session - The session
 * @param registerPost - Callback to register posts for reaction routing
 */
export async function bumpAllStickyPosts(
  session: Session,
  registerPost: (postId: string, threadId: string) => void
): Promise<void> {
  // Bump plan approval first (if pending)
  if (session.pendingApproval?.type === 'plan' && session.pendingApproval.content) {
    await bumpPlanApprovalToBottom(session, registerPost);
  }

  // Bump task list last (so it stays at very bottom)
  if (session.tasksPostId && session.lastTasksContent && !session.tasksCompleted) {
    await bumpTasksToBottom(session, registerPost);
  }
}

/**
 * Check if there are any active sticky posts that would need bumping.
 */
export function hasActiveStickyPosts(session: Session): boolean {
  const hasPlanApproval = session.pendingApproval?.type === 'plan' && !!session.pendingApproval.content;
  const hasTaskList = !!session.tasksPostId && !!session.lastTasksContent && !session.tasksCompleted;
  return hasPlanApproval || hasTaskList;
}

/**
 * Check if the session has an active (non-completed) task list.
 */
export function hasActiveTasks(session: Session): boolean {
  return !!session.tasksPostId && !!session.lastTasksContent && !session.tasksCompleted;
}
