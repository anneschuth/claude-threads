/**
 * Message Approval Executor - Handles unauthorized user message approval
 *
 * Responsible for:
 * - Managing pending message approval state
 * - Processing approval responses via reactions
 * - Notifying when messages are approved/denied/invited
 */

import { isApprovalEmoji, isDenialEmoji, isAllowAllEmoji } from '../../utils/emoji.js';
import type { ExecutorContext, MessageApprovalState, PendingMessageApproval } from './types.js';
import { createLogger } from '../../utils/logger.js';
import { BaseExecutor, type ExecutorOptions } from './base.js';

const log = createLogger('message-approval-executor');

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
  async handleMessageApprovalResponse(
    postId: string,
    decision: MessageApprovalDecision,
    approver: string,
    ctx: ExecutorContext
  ): Promise<boolean> {
    if (!this.state.pendingMessageApproval) return false;
    if (this.state.pendingMessageApproval.postId !== postId) return false;

    const logger = log.forSession(ctx.sessionId);
    const { fromUser, originalMessage } = this.state.pendingMessageApproval;
    const formatter = ctx.platform.getFormatter();

    // Update the post based on decision
    let statusMessage: string;
    if (decision === 'allow') {
      statusMessage = `✅ Message from ${formatter.formatUserMention(fromUser)} approved by ${formatter.formatUserMention(approver)}`;
      logger.info(`Message from @${fromUser} approved by @${approver}`);
    } else if (decision === 'invite') {
      statusMessage = `✅ ${formatter.formatUserMention(fromUser)} invited to session by ${formatter.formatUserMention(approver)}`;
      logger.info(`@${fromUser} invited to session by @${approver}`);
    } else {
      statusMessage = `❌ Message from ${formatter.formatUserMention(fromUser)} denied by ${formatter.formatUserMention(approver)}`;
      logger.info(`Message from @${fromUser} denied by @${approver}`);
    }

    try {
      await ctx.platform.updatePost(postId, statusMessage);
    } catch (err) {
      logger.debug(`Failed to update message approval post: ${err}`);
    }

    // Clear pending state
    this.state.pendingMessageApproval = null;

    // Emit message approval complete event
    if (this.events) {
      this.events.emit('message-approval:complete', { decision, fromUser, originalMessage });
    }

    return true;
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
    // Only handle 'added' reactions
    if (action !== 'added') {
      return false;
    }

    const logger = log.forSession(ctx.sessionId);

    // Check pending message approval
    if (this.state.pendingMessageApproval?.postId === postId) {
      if (isApprovalEmoji(emoji)) {
        logger.debug(`Message approval reaction from @${user}: allow`);
        return this.handleMessageApprovalResponse(postId, 'allow', user, ctx);
      }
      if (isAllowAllEmoji(emoji)) {
        logger.debug(`Message approval reaction from @${user}: invite`);
        return this.handleMessageApprovalResponse(postId, 'invite', user, ctx);
      }
      if (isDenialEmoji(emoji)) {
        logger.debug(`Message approval reaction from @${user}: deny`);
        return this.handleMessageApprovalResponse(postId, 'deny', user, ctx);
      }
      return false;
    }

    // No pending state matched
    return false;
  }
}
