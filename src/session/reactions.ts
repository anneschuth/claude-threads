/**
 * User reaction handling module
 *
 * Handles emoji reactions on posts: plan approval, question answers,
 * message approval, cancel/escape actions.
 */

import type { Session } from './types.js';
import type { SessionContext } from './context.js';
import {
  isApprovalEmoji,
  isDenialEmoji,
  isAllowAllEmoji,
  getNumberEmojiIndex,
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
// Question reaction handling
// ---------------------------------------------------------------------------

/**
 * Handle a reaction on a question post (number emoji to select an option).
 *
 * Note: Question handling is delegated to MessageManager.handleQuestionAnswer()
 * which manages the question state internally. This function just extracts
 * the option index from the emoji and delegates.
 */
export async function handleQuestionReaction(
  session: Session,
  postId: string,
  emojiName: string,
  username: string,
  _ctx: SessionContext
): Promise<void> {
  // Delegate to MessageManager if available
  if (!session.messageManager) return;

  const optionIndex = getNumberEmojiIndex(emojiName);
  if (optionIndex < 0) return;

  // Log the reaction
  session.threadLogger?.logReaction('question_answer', username, emojiName);

  // Delegate to MessageManager - it handles state, post updates, and callbacks
  const handled = await session.messageManager.handleQuestionAnswer(postId, optionIndex);
  if (handled) {
    sessionLog(session).debug(`💬 @${username} answered question with option ${optionIndex + 1}`);
  }
}

// ---------------------------------------------------------------------------
// Plan approval reaction handling
// ---------------------------------------------------------------------------

/**
 * Handle a reaction on a plan approval post (thumbs up/down).
 *
 * Note: Approval handling is delegated to MessageManager.handleApprovalResponse()
 * which manages the approval state internally. This function determines
 * the approval decision from the emoji and delegates.
 */
export async function handleApprovalReaction(
  session: Session,
  postId: string,
  emojiName: string,
  username: string,
  _ctx: SessionContext
): Promise<void> {
  // Delegate to MessageManager if available
  if (!session.messageManager) return;

  const isApprove = isApprovalEmoji(emojiName);
  const isReject = isDenialEmoji(emojiName);

  if (!isApprove && !isReject) return;

  // Log the reaction
  session.threadLogger?.logReaction(isApprove ? 'plan_approve' : 'plan_reject', username, emojiName);

  // Delegate to MessageManager - it handles state, post updates, and callbacks
  const handled = await session.messageManager.handleApprovalResponse(postId, isApprove);
  if (handled) {
    sessionLog(session).info(`${isApprove ? '✅' : '❌'} Plan ${isApprove ? 'approved' : 'rejected'} by @${username}`);

    // Also clear any stale questions from plan mode - they're no longer relevant
    session.messageManager.clearPendingQuestionSet();

    if (isApprove) {
      session.planApproved = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Message approval reaction handling
// ---------------------------------------------------------------------------

/**
 * Handle a reaction on a message approval post (approve/invite/deny).
 */
export async function handleMessageApprovalReaction(
  session: Session,
  emoji: string,
  approver: string,
  ctx: SessionContext
): Promise<void> {
  const pending = session.pendingMessageApproval;
  if (!pending) return;

  // Only session owner or globally allowed users can approve
  if (session.startedBy !== approver && !session.platform.isUserAllowed(approver)) {
    return;
  }

  const isAllow = isApprovalEmoji(emoji);
  const isInvite = isAllowAllEmoji(emoji);
  const isDeny = isDenialEmoji(emoji);

  if (!isAllow && !isInvite && !isDeny) return;

  const formatter = session.platform.getFormatter();

  if (isAllow) {
    // Allow this single message
    await updatePostSuccess(
      session,
      pending.postId,
      `Message from ${formatter.formatUserMention(pending.fromUser)} approved by ${formatter.formatUserMention(approver)}`
    );
    session.claude.sendMessage(pending.originalMessage);
    session.lastActivityAt = new Date();
    ctx.ops.startTyping(session);
    sessionLog(session).info(`✅ Message from @${pending.fromUser} approved by @${approver}`);
    session.threadLogger?.logReaction('message_approve', approver, emoji);
  } else if (isInvite) {
    // Invite user to session
    session.sessionAllowedUsers.add(pending.fromUser);
    await updatePostSuccess(
      session,
      pending.postId,
      `${formatter.formatUserMention(pending.fromUser)} invited to session by ${formatter.formatUserMention(approver)}`
    );
    await ctx.ops.updateSessionHeader(session);
    session.claude.sendMessage(pending.originalMessage);
    session.lastActivityAt = new Date();
    ctx.ops.startTyping(session);
    sessionLog(session).info(`👋 @${pending.fromUser} invited to session by @${approver}`);
  } else if (isDeny) {
    // Deny
    await updatePost(
      session,
      pending.postId,
      `❌ Message from ${formatter.formatUserMention(pending.fromUser)} denied by ${formatter.formatUserMention(approver)}`
    );
    sessionLog(session).info(`❌ Message from @${pending.fromUser} denied by @${approver}`);
    session.threadLogger?.logReaction('message_reject', approver, emoji);
  }

  session.pendingMessageApproval = null;
}

// NOTE: Task list toggle reaction handling has been moved to TaskListExecutor.
// It's now handled via MessageManager.handleTaskListToggle() in manager.ts

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
