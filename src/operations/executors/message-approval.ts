/**
 * Message Approval Executor - Handles unauthorized user message approval
 *
 * Responsible for:
 * - Managing pending message approval state
 * - Processing approval responses via reactions
 * - Notifying when messages are approved/denied/invited
 */

import { isApprovalEmoji, isDenialEmoji, isAllowAllEmoji } from '../../utils/emoji.js';
import { completePendingPrompt } from './pending-prompt.js';
import type { ExecutorContext, MessageApprovalState, PendingMessageApproval } from './types.js';
import { BaseExecutor, type ExecutorOptions } from './base.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Decision type for message approval reactions.
 */
export type MessageApprovalDecision = 'allow' | 'invite' | 'deny';

// ---------------------------------------------------------------------------
// Message Approval Executor
// ---------------------------------------------------------------------------

/**
 * Executor for message approval operations.
 */
export class MessageApprovalExecutor extends BaseExecutor<MessageApprovalState> {
  constructor(options: ExecutorOptions) {
    super(options, MessageApprovalExecutor.createInitialState());
  }

  private static createInitialState(): MessageApprovalState {
    return {
      pendingMessageApproval: null,
    };
  }

  protected getInitialState(): MessageApprovalState {
    return MessageApprovalExecutor.createInitialState();
  }

  /**
   * Get the current state (for inspection/testing).
   * Override to provide deep copy of nested object.
   */
  override getState(): Readonly<MessageApprovalState> {
    return {
      pendingMessageApproval: this.state.pendingMessageApproval
        ? { ...this.state.pendingMessageApproval }
        : null,
    };
  }

  /**
   * Hydrate state from persisted session data.
   * Used when resuming a session after bot restart.
   */
  hydrateState(persisted: {
    pendingMessageApproval?: PendingMessageApproval | null;
  }): void {
    this.state = {
      pendingMessageApproval: persisted.pendingMessageApproval ?? null,
    };
  }

  /**
   * Set pending message approval state.
   * Called when an unauthorized user sends a message that needs approval.
   */
  setPendingMessageApproval(approval: PendingMessageApproval): void {
    this.state.pendingMessageApproval = approval;
  }

  /**
   * Get pending message approval state.
   */
  getPendingMessageApproval(): PendingMessageApproval | null {
    return this.state.pendingMessageApproval;
  }

  /**
   * Check if there's a pending message approval.
   */
  hasPendingMessageApproval(): boolean {
    return this.state.pendingMessageApproval !== null;
  }

  /**
   * Clear pending message approval state.
   */
  clearPendingMessageApproval(): void {
    this.state.pendingMessageApproval = null;
  }

  /**
   * Handle a message approval reaction.
   * Returns true if the reaction was handled, false otherwise.
   *
   * @param postId - The post ID the reaction was on
   * @param decision - The approval decision (allow/invite/deny)
   * @param approver - Username of the approver (for logging)
   * @param ctx - Executor context
   */
  handleMessageApprovalResponse(
    postId: string,
    decision: MessageApprovalDecision,
    approver: string,
    ctx: ExecutorContext
  ): Promise<boolean> {
    return completePendingPrompt({
      pending: this.state.pendingMessageApproval,
      postId,
      ctx,
      label: 'message approval',
      statusMessage: ({ fromUser }) => {
        if (decision === 'allow') {
          ctx.logger.info(`Message from @${fromUser} approved by @${approver}`);
          return `✅ Message from ${ctx.formatter.formatUserMention(fromUser)} approved by ${ctx.formatter.formatUserMention(approver)}`;
        }
        if (decision === 'invite') {
          ctx.logger.info(`@${fromUser} invited to session by @${approver}`);
          return `✅ ${ctx.formatter.formatUserMention(fromUser)} invited to session by ${ctx.formatter.formatUserMention(approver)}`;
        }
        ctx.logger.info(`Message from @${fromUser} denied by @${approver}`);
        return `❌ Message from ${ctx.formatter.formatUserMention(fromUser)} denied by ${ctx.formatter.formatUserMention(approver)}`;
      },
      clear: () => { this.state.pendingMessageApproval = null; },
      emit: ({ fromUser, originalMessage }) =>
        this.events?.emit('message-approval:complete', { decision, fromUser, originalMessage, approvedBy: approver }),
    });
  }

  // ---------------------------------------------------------------------------
  // Unified reaction handler
  // ---------------------------------------------------------------------------

  /**
   * Handle a reaction on any post managed by this executor.
   * Returns true if the reaction was handled, false otherwise.
   *
   * @param postId - The post ID the reaction was on
   * @param emoji - The emoji name that was used
   * @param user - Username of the user who reacted
   * @param action - Whether the reaction was 'added' or 'removed'
   * @param ctx - Executor context
   */
  async handleReaction(
    postId: string,
    emoji: string,
    user: string,
    action: 'added' | 'removed',
    ctx: ExecutorContext
  ): Promise<boolean> {
    ctx.logger.debug(`MessageApprovalExecutor.handleReaction: postId=${postId.substring(0, 8)}, emoji=${emoji}, user=${user}, action=${action}`);

    // Only handle 'added' reactions
    if (action !== 'added') {
      ctx.logger.debug(`MessageApprovalExecutor: ignoring ${action} reaction (only handling 'added')`);
      return false;
    }

    // Check pending message approval
    if (this.state.pendingMessageApproval?.postId === postId) {
      if (isApprovalEmoji(emoji)) {
        ctx.logger.debug(`Message approval reaction from @${user}: allow`);
        const handled = await this.handleMessageApprovalResponse(postId, 'allow', user, ctx);
        ctx.logger.debug(`MessageApprovalExecutor: outcome=allow, handled=${handled}`);
        return handled;
      }
      if (isAllowAllEmoji(emoji)) {
        // "✅ Invite to session" grants standing membership — an owner
        // privilege, matching the owner-gated `!invite` command. The reaction
        // router has already confirmed `user` is at least a session
        // participant, but a temporarily-invited guest is a participant who
        // must NOT be able to invite further users. Port `requireSessionOwner`'s
        // first gate here: only the session owner or a platform-allowlisted
        // user may invite. Anyone else's ✅ is downgraded to a one-shot allow
        // (the message still goes through once; no permanent membership is
        // granted). A missing `sessionOwner` (older persisted approval) falls
        // back to platform-allowlist only.
        const pending = this.state.pendingMessageApproval;
        const isInviteAuthorized =
          (pending.sessionOwner !== undefined && user === pending.sessionOwner) ||
          ctx.platform.isUserAllowed(user);
        if (!isInviteAuthorized) {
          ctx.logger.info(
            `Message approval invite (✅) from @${user} downgraded to allow-once: only the session owner may invite`
          );
          // Tell the reactor their invite was declined and only a one-shot
          // allow was granted, so a guest who reacted ✅ doesn't wrongly believe
          // they added the user to the session.
          await ctx.createPost(
            `ℹ️ Only the session owner can invite ${ctx.formatter.formatUserMention(pending.fromUser)} to the session — allowing this one message instead.`,
            { type: 'system' },
          );
          const handled = await this.handleMessageApprovalResponse(postId, 'allow', user, ctx);
          ctx.logger.debug(`MessageApprovalExecutor: outcome=allow (invite downgraded), handled=${handled}`);
          return handled;
        }
        ctx.logger.debug(`Message approval reaction from @${user}: invite`);
        const handled = await this.handleMessageApprovalResponse(postId, 'invite', user, ctx);
        ctx.logger.debug(`MessageApprovalExecutor: outcome=invite, handled=${handled}`);
        return handled;
      }
      if (isDenialEmoji(emoji)) {
        ctx.logger.debug(`Message approval reaction from @${user}: deny`);
        const handled = await this.handleMessageApprovalResponse(postId, 'deny', user, ctx);
        ctx.logger.debug(`MessageApprovalExecutor: outcome=deny, handled=${handled}`);
        return handled;
      }
      ctx.logger.debug(`MessageApprovalExecutor: emoji ${emoji} is not a valid message approval emoji, ignoring`);
      return false;
    }

    // No pending state matched
    ctx.logger.debug(`MessageApprovalExecutor: no pending message approval for postId=${postId.substring(0, 8)}`);
    return false;
  }
}
