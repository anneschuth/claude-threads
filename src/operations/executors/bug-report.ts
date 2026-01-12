/**
 * Bug Report Executor - Handles bug report approval
 *
 * Responsible for:
 * - Managing pending bug report state
 * - Processing approval/denial responses via reactions
 * - Notifying when bug reports are approved/denied
 */

import { isApprovalEmoji, isDenialEmoji } from '../../utils/emoji.js';
import type { ExecutorContext, BugReportState, PendingBugReport, RegisterPostCallback, UpdateLastMessageCallback } from './types.js';
import { createLogger } from '../../utils/logger.js';
import type { TypedEventEmitter } from '../message-manager-events.js';

const log = createLogger('bug-report-executor');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Decision type for bug report reactions.
 */
export type BugReportDecision = 'approve' | 'deny';

/**
 * Callback for bug report completion.
 */
export type BugReportCallback = (
  decision: BugReportDecision,
  report: PendingBugReport
) => Promise<void>;

// ---------------------------------------------------------------------------
// Bug Report Executor
// ---------------------------------------------------------------------------

/**
 * Executor for bug report operations.
 */
export class BugReportExecutor {
  private state: BugReportState;
  private registerPost: RegisterPostCallback;
  private updateLastMessage: UpdateLastMessageCallback;
  private events?: TypedEventEmitter;

  constructor(options: {
    registerPost: RegisterPostCallback;
    updateLastMessage: UpdateLastMessageCallback;
    /**
     * Event emitter for notifying when interactive operations complete.
     */
    events?: TypedEventEmitter;
  }) {
    this.state = {
      pendingBugReport: null,
    };
    this.registerPost = options.registerPost;
    this.updateLastMessage = options.updateLastMessage;
    this.events = options.events;
  }

  /**
   * Get the current state (for inspection/testing).
   */
  getState(): Readonly<BugReportState> {
    return {
      pendingBugReport: this.state.pendingBugReport
        ? { ...this.state.pendingBugReport }
        : null,
    };
  }

  /**
   * Reset state (for session restart).
   */
  reset(): void {
    this.state = {
      pendingBugReport: null,
    };
  }

  /**
   * Hydrate state from persisted session data.
   * Used when resuming a session after bot restart.
   */
  hydrateState(persisted: {
    pendingBugReport?: PendingBugReport | null;
  }): void {
    this.state = {
      pendingBugReport: persisted.pendingBugReport ?? null,
    };
  }

  /**
   * Set pending bug report state.
   * Called when a bug report is ready for user approval before submission.
   */
  setPendingBugReport(report: PendingBugReport): void {
    this.state.pendingBugReport = report;
  }

  /**
   * Get pending bug report state.
   */
  getPendingBugReport(): PendingBugReport | null {
    return this.state.pendingBugReport;
  }

  /**
   * Check if there's a pending bug report.
   */
  hasPendingBugReport(): boolean {
    return this.state.pendingBugReport !== null;
  }

  /**
   * Clear pending bug report state.
   */
  clearPendingBugReport(): void {
    this.state.pendingBugReport = null;
  }

  /**
   * Handle a bug report reaction.
   * Returns true if the reaction was handled, false otherwise.
   *
   * @param postId - The post ID the reaction was on
   * @param decision - The bug report decision (approve or deny)
   * @param username - Username of the user who responded (for logging)
   * @param ctx - Executor context
   */
  async handleBugReportResponse(
    postId: string,
    decision: BugReportDecision,
    username: string,
    ctx: ExecutorContext
  ): Promise<boolean> {
    if (!this.state.pendingBugReport) return false;
    if (this.state.pendingBugReport.postId !== postId) return false;

    const logger = log.forSession(ctx.sessionId);
    const report = this.state.pendingBugReport;
    const formatter = ctx.platform.getFormatter();

    // Update the post based on decision
    let statusMessage: string;
    if (decision === 'approve') {
      statusMessage = `✅ ${formatter.formatBold('Bug report submitted')} - creating issue...`;
      logger.info(`Bug report approved by @${username}`);
    } else {
      statusMessage = `❌ ${formatter.formatBold('Bug report cancelled')}`;
      logger.info(`Bug report denied by @${username}`);
    }

    try {
      await ctx.platform.updatePost(postId, statusMessage);
    } catch (err) {
      logger.debug(`Failed to update bug report post: ${err}`);
    }

    // Clear pending state
    this.state.pendingBugReport = null;

    // Emit bug report complete event
    if (this.events) {
      this.events.emit('bug-report:complete', { decision, report });
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

    // Check pending bug report
    if (this.state.pendingBugReport?.postId === postId) {
      if (isApprovalEmoji(emoji)) {
        logger.debug(`Bug report reaction from @${user}: approve`);
        return this.handleBugReportResponse(postId, 'approve', user, ctx);
      }
      if (isDenialEmoji(emoji)) {
        logger.debug(`Bug report reaction from @${user}: deny`);
        return this.handleBugReportResponse(postId, 'deny', user, ctx);
      }
      return false;
    }

    // No pending state matched
    return false;
  }
}
