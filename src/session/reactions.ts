/**
 * User reaction handling module
 *
 * Handles emoji reactions on posts for session-level prompts that haven't
 * been migrated to MessageManager yet (worktrees, updates, bug reports).
 *
 * NOTE: Question, approval, and message approval reactions are now handled
 * by MessageManager.handleReaction() which routes to InteractiveExecutor.
 * This module only handles session-level prompts that require SessionContext.
 */

import type { Session } from './types.js';
import type { SessionContext } from './context.js';
import {
  isApprovalEmoji,
  isDenialEmoji,
  isBugReportEmoji,
} from '../utils/emoji.js';
import { createLogger } from '../utils/logger.js';
import { shortenPath } from '../operations/index.js';
import { reportBug, handleBugReportApproval } from './commands.js';
import { updatePost, updatePostSuccess } from './post-helpers.js';

const log = createLogger('reactions');

/** Get session-scoped logger for routing to correct UI panel */
function sessionLog(session: Session) {
  return log.forSession(session.sessionId);
}

// ---------------------------------------------------------------------------
// Existing worktree join prompt reaction handling
// ---------------------------------------------------------------------------

/**
 * Handle a reaction on an existing worktree prompt (join or skip).
 * Returns true if the reaction was handled, false otherwise.
 *
 * @param switchToWorktree - Callback to switch session to existing worktree
 *                           (not part of SessionOperations as it's specific to this use case)
 */
export async function handleExistingWorktreeReaction(
  session: Session,
  postId: string,
  emojiName: string,
  username: string,
  ctx: SessionContext,
  switchToWorktree: (threadId: string, branchOrPath: string, username: string) => Promise<void>
): Promise<boolean> {
  const pending = session.pendingExistingWorktreePrompt;
  if (!pending || pending.postId !== postId) {
    return false;
  }

  // Only session owner or allowed users can respond
  if (session.startedBy !== username && !session.platform.isUserAllowed(username)) {
    return false;
  }

  const isApprove = isApprovalEmoji(emojiName);
  const isDeny = isDenialEmoji(emojiName);

  if (!isApprove && !isDeny) {
    return false;
  }

  const shortPath = shortenPath(pending.worktreePath, undefined, { path: pending.worktreePath, branch: pending.branch });

  const formatter = session.platform.getFormatter();

  if (isApprove) {
    // Join the existing worktree
    await updatePostSuccess(
      session,
      pending.postId,
      `Joining worktree for branch ${formatter.formatCode(pending.branch)} at ${formatter.formatCode(shortPath)}`
    );

    // Clear the pending prompt before switching
    session.pendingExistingWorktreePrompt = undefined;
    ctx.ops.persistSession(session);

    // Switch to the existing worktree
    await switchToWorktree(session.threadId, pending.worktreePath, pending.username);

    sessionLog(session).info(`🌿 @${username} joined existing worktree ${pending.branch} at ${shortPath}`);
  } else {
    // Skip - continue in current directory
    await updatePostSuccess(
      session,
      pending.postId,
      `Continuing in current directory (skipped by ${formatter.formatUserMention(username)})`
    );

    // Clear the pending prompt
    session.pendingExistingWorktreePrompt = undefined;
    ctx.ops.persistSession(session);

    sessionLog(session).info(`❌ @${username} skipped joining existing worktree ${pending.branch}`);
  }

  return true;
}

// ---------------------------------------------------------------------------
// Update prompt reaction handling
// ---------------------------------------------------------------------------

/**
 * Callback interface for update actions.
 */
export interface UpdateReactionHandler {
  forceUpdate: () => Promise<void>;
  deferUpdate: (minutes: number) => void;
}

/**
 * Handle a reaction on an update prompt post (thumbs up = now, thumbs down = defer).
 * Returns true if the reaction was handled, false otherwise.
 */
export async function handleUpdateReaction(
  session: Session,
  postId: string,
  emojiName: string,
  username: string,
  ctx: SessionContext,
  updateHandler: UpdateReactionHandler
): Promise<boolean> {
  const pending = session.pendingUpdatePrompt;
  if (!pending || pending.postId !== postId) {
    return false;
  }

  // Only session owner or allowed users can respond
  if (session.startedBy !== username && !session.platform.isUserAllowed(username)) {
    return false;
  }

  const isUpdateNow = isApprovalEmoji(emojiName);
  const isDefer = isDenialEmoji(emojiName);

  if (!isUpdateNow && !isDefer) {
    return false;
  }

  const formatter = session.platform.getFormatter();

  if (isUpdateNow) {
    // Update now
    await updatePost(
      session,
      pending.postId,
      `🔄 ${formatter.formatBold('Forcing update')} - restarting shortly...\n` +
      formatter.formatItalic('Sessions will resume automatically')
    );

    // Clear the pending prompt
    session.pendingUpdatePrompt = undefined;
    ctx.ops.persistSession(session);

    sessionLog(session).info(`🔄 @${username} triggered immediate update`);

    // Trigger the update
    await updateHandler.forceUpdate();
  } else {
    // Defer for 1 hour
    updateHandler.deferUpdate(60);

    await updatePost(
      session,
      pending.postId,
      `⏸️ ${formatter.formatBold('Update deferred')} for 1 hour\n` +
      formatter.formatItalic('Use !update now to apply earlier')
    );

    // Clear the pending prompt
    session.pendingUpdatePrompt = undefined;
    ctx.ops.persistSession(session);

    sessionLog(session).info(`⏸️ @${username} deferred update for 1 hour`);
  }

  return true;
}

// ---------------------------------------------------------------------------
// Bug report reaction handling
// ---------------------------------------------------------------------------

/**
 * Handle a bug report emoji reaction on an error post.
 * Triggers the bug report flow with the error context.
 * Returns true if the reaction was handled, false otherwise.
 */
export async function handleBugReportReaction(
  session: Session,
  postId: string,
  emojiName: string,
  username: string,
  ctx: SessionContext
): Promise<boolean> {
  // Only handle bug emoji reactions
  if (!isBugReportEmoji(emojiName)) {
    return false;
  }

  // Check if this is the error post we tracked
  if (!session.lastError || session.lastError.postId !== postId) {
    return false;
  }

  // Only session owner or allowed users can report bugs
  if (session.startedBy !== username &&
      !session.platform.isUserAllowed(username) &&
      !session.sessionAllowedUsers.has(username)) {
    return false;
  }

  sessionLog(session).info(`🐛 @${username} triggered bug report from error reaction`);

  // Trigger bug report flow with the error context
  await reportBug(session, undefined, username, ctx, session.lastError);

  return true;
}

/**
 * Handle a reaction on a bug report approval post (thumbs up/down).
 * Returns true if the reaction was handled, false otherwise.
 */
export async function handleBugApprovalReaction(
  session: Session,
  postId: string,
  emojiName: string,
  username: string,
  _ctx: SessionContext
): Promise<boolean> {
  const pending = session.pendingBugReport;
  if (!pending || pending.postId !== postId) {
    return false;
  }

  // Only session owner or allowed users can approve
  if (session.startedBy !== username &&
      !session.platform.isUserAllowed(username) &&
      !session.sessionAllowedUsers.has(username)) {
    return false;
  }

  const isApprove = isApprovalEmoji(emojiName);
  const isDeny = isDenialEmoji(emojiName);

  if (!isApprove && !isDeny) {
    return false;
  }

  // Handle the approval/denial
  await handleBugReportApproval(session, isApprove, username);

  return true;
}
