/**
 * Bug Report Executor - Handles bug report approval
 *
 * Responsible for:
 * - Managing pending bug report state
 * - Processing approval/denial responses via reactions
 * - Notifying when bug reports are approved/denied
 */

import { isApprovalEmoji, isDenialEmoji } from '../../utils/emoji.js';
import type { ExecutorContext, BugReportState, PendingBugReport } from './types.js';
import { BaseExecutor, type ExecutorOptions } from './base.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Decision type for bug report reactions.
 */
export type BugReportDecision = 'approve' | 'deny';

// ---------------------------------------------------------------------------
// Bug Report Executor
// ---------------------------------------------------------------------------

/**
 * Executor for bug report operations.
 */
export class BugReportExecutor extends BaseExecutor<BugReportState> {
  constructor(options: ExecutorOptions) {
    super(options, BugReportExecutor.createInitialState());
  }

  private static createInitialState(): BugReportState {
    return {
      pendingBugReport: null,
    };
  }

  protected getInitialState(): BugReportState {
    return BugReportExecutor.createInitialState();
  }

  /**
   * Get the current state (for inspection/testing).
   * Override to provide deep copy of nested object.
   */
  override getState(): Readonly<BugReportState> {
    return {
      pendingBugReport: this.state.pendingBugReport
        ? { ...this.state.pendingBugReport }
        : null,
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

    const report = this.state.pendingBugReport;

    // Update the post based on decision
    let statusMessage: string;
    if (decision === 'approve') {
      statusMessage = `✅ ${ctx.formatter.formatBold('Bug report submitted')} - creating issue...`;
      ctx.logger.info(`Bug report approved by @${username}`);
    } else {
      statusMessage = `❌ ${ctx.formatter.formatBold('Bug report cancelled')}`;
      ctx.logger.info(`Bug report denied by @${username}`);
    }

    try {
      await ctx.platform.updatePost(postId, statusMessage);
    } catch (err) {
      ctx.logger.debug(`Failed to update bug report post: ${err}`);
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
    ctx.logger.debug(`BugReportExecutor.handleReaction: postId=${postId.substring(0, 8)}, emoji=${emoji}, user=${user}, action=${action}`);

    // Only handle 'added' reactions
    if (action !== 'added') {
      ctx.logger.debug(`BugReportExecutor: ignoring ${action} reaction (only handling 'added')`);
      return false;
    }

    // Check pending bug report
    if (this.state.pendingBugReport?.postId === postId) {
      if (isApprovalEmoji(emoji)) {
        ctx.logger.debug(`Bug report reaction from @${user}: approve`);
        const handled = await this.handleBugReportResponse(postId, 'approve', user, ctx);
        ctx.logger.debug(`BugReportExecutor: outcome=approve, handled=${handled}`);
        return handled;
      }
      if (isDenialEmoji(emoji)) {
        ctx.logger.debug(`Bug report reaction from @${user}: deny`);
        const handled = await this.handleBugReportResponse(postId, 'deny', user, ctx);
        ctx.logger.debug(`BugReportExecutor: outcome=deny, handled=${handled}`);
        return handled;
      }
      ctx.logger.debug(`BugReportExecutor: emoji ${emoji} not valid for bug report, ignoring`);
      return false;
    }

    // No pending state matched
    ctx.logger.debug(`BugReportExecutor: no pending bug report for postId=${postId.substring(0, 8)}`);
    return false;
  }
}
