/**
 * Interactive Executor - Handles QuestionOp and ApprovalOp
 *
 * Responsible for:
 * - Posting questions with reaction options
 * - Posting approval prompts
 * - Managing pending question/approval state
 * - Processing user responses via reactions
 *
 * Uses TypedEventEmitter for communication with Session/Lifecycle layers.
 * Events are emitted when interactive operations complete.
 */

import { NUMBER_EMOJIS, APPROVAL_EMOJIS, DENIAL_EMOJIS, isApprovalEmoji, isDenialEmoji, isAllowAllEmoji, getNumberEmojiIndex } from '../../utils/emoji.js';
import type { QuestionOp, ApprovalOp } from '../types.js';
import type { ExecutorContext, InteractiveState, PendingMessageApproval, PendingContextPrompt, PendingExistingWorktreePrompt, PendingUpdatePrompt, PendingBugReport, RegisterPostCallback, UpdateLastMessageCallback } from './types.js';
import { createLogger } from '../../utils/logger.js';
import type { TypedEventEmitter } from '../message-manager-events.js';

/**
 * Decision type for message approval reactions.
 */
export type MessageApprovalDecision = 'allow' | 'invite' | 'deny';

const log = createLogger('interactive-executor');

// ---------------------------------------------------------------------------
// Interactive Executor
// ---------------------------------------------------------------------------

/**
 * Pending question state with answers.
 */
interface PendingQuestion {
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
  answer: string | null;
}

/**
 * Executor for interactive operations (questions, approvals).
 */
/**
 * Callback for message approval completion.
 */
export type MessageApprovalCallback = (
  decision: MessageApprovalDecision,
  context: { fromUser: string; originalMessage: string }
) => Promise<void>;

/**
 * Context prompt selection result.
 * - number > 0: Include that many messages as context
 * - 0: No context (user explicitly skipped)
 * - 'timeout': No context (prompt timed out)
 */
export type ContextPromptSelection = number | 'timeout';

/**
 * Callback for context prompt completion.
 */
export type ContextPromptCallback = (
  selection: ContextPromptSelection,
  context: {
    queuedPrompt: string;
    queuedFiles?: Array<{ id: string; name: string }>;
    threadMessageCount: number;
  }
) => Promise<void>;

/**
 * Decision type for existing worktree prompt reactions.
 */
export type ExistingWorktreeDecision = 'join' | 'skip';

/**
 * Callback for existing worktree prompt completion.
 */
export type ExistingWorktreeCallback = (
  decision: ExistingWorktreeDecision,
  context: { branch: string; worktreePath: string; username: string }
) => Promise<void>;

/**
 * Decision type for update prompt reactions.
 */
export type UpdatePromptDecision = 'update_now' | 'defer';

/**
 * Callback for update prompt completion.
 */
export type UpdatePromptCallback = (decision: UpdatePromptDecision) => Promise<void>;

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

export class InteractiveExecutor {
  private state: InteractiveState;
  private registerPost: RegisterPostCallback;
  private updateLastMessage: UpdateLastMessageCallback;
  private events?: TypedEventEmitter;

  constructor(options: {
    registerPost: RegisterPostCallback;
    updateLastMessage: UpdateLastMessageCallback;
    /**
     * Event emitter for notifying when interactive operations complete.
     * If provided, events are emitted instead of callbacks being called.
     */
    events?: TypedEventEmitter;
  }) {
    this.state = {
      pendingQuestionSet: null,
      pendingApproval: null,
      pendingMessageApproval: null,
      pendingContextPrompt: null,
      pendingExistingWorktreePrompt: null,
      pendingUpdatePrompt: null,
      pendingBugReport: null,
    };
    this.registerPost = options.registerPost;
    this.updateLastMessage = options.updateLastMessage;
    this.events = options.events;
  }

  /**
   * Get the current state (for inspection/testing).
   */
  getState(): Readonly<InteractiveState> {
    return {
      pendingQuestionSet: this.state.pendingQuestionSet
        ? { ...this.state.pendingQuestionSet }
        : null,
      pendingApproval: this.state.pendingApproval
        ? { ...this.state.pendingApproval }
        : null,
      pendingMessageApproval: this.state.pendingMessageApproval
        ? { ...this.state.pendingMessageApproval }
        : null,
      pendingContextPrompt: this.state.pendingContextPrompt
        ? { ...this.state.pendingContextPrompt }
        : null,
      pendingExistingWorktreePrompt: this.state.pendingExistingWorktreePrompt
        ? { ...this.state.pendingExistingWorktreePrompt }
        : null,
      pendingUpdatePrompt: this.state.pendingUpdatePrompt
        ? { ...this.state.pendingUpdatePrompt }
        : null,
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
      pendingQuestionSet: null,
      pendingApproval: null,
      pendingMessageApproval: null,
      pendingContextPrompt: null,
      pendingExistingWorktreePrompt: null,
      pendingUpdatePrompt: null,
      pendingBugReport: null,
    };
  }

  /**
   * Hydrate state from persisted session data.
   * Used when resuming a session after bot restart.
   */
  hydrateState(persisted: {
    pendingQuestionSet?: InteractiveState['pendingQuestionSet'];
    pendingApproval?: InteractiveState['pendingApproval'];
    pendingMessageApproval?: InteractiveState['pendingMessageApproval'];
    pendingContextPrompt?: InteractiveState['pendingContextPrompt'];
    pendingExistingWorktreePrompt?: InteractiveState['pendingExistingWorktreePrompt'];
    pendingUpdatePrompt?: InteractiveState['pendingUpdatePrompt'];
    pendingBugReport?: InteractiveState['pendingBugReport'];
  }): void {
    this.state = {
      pendingQuestionSet: persisted.pendingQuestionSet ?? null,
      pendingApproval: persisted.pendingApproval ?? null,
      pendingMessageApproval: persisted.pendingMessageApproval ?? null,
      pendingContextPrompt: persisted.pendingContextPrompt ?? null,
      pendingExistingWorktreePrompt: persisted.pendingExistingWorktreePrompt ?? null,
      pendingUpdatePrompt: persisted.pendingUpdatePrompt ?? null,
      pendingBugReport: persisted.pendingBugReport ?? null,
    };
  }

  /**
   * Check if there are pending questions.
   */
  hasPendingQuestions(): boolean {
    return this.state.pendingQuestionSet !== null;
  }

  /**
   * Check if there's a pending approval.
   */
  hasPendingApproval(): boolean {
    return this.state.pendingApproval !== null;
  }

  /**
   * Get pending approval info.
   */
  getPendingApproval(): InteractiveState['pendingApproval'] {
    return this.state.pendingApproval;
  }

  /**
   * Get pending question set info.
   */
  getPendingQuestionSet(): InteractiveState['pendingQuestionSet'] {
    return this.state.pendingQuestionSet;
  }

  /**
   * Execute a question operation.
   */
  async executeQuestion(op: QuestionOp, ctx: ExecutorContext): Promise<void> {
    const logger = log.forSession(ctx.sessionId);

    // If already have pending questions, don't start another set
    if (this.state.pendingQuestionSet) {
      logger.debug('Questions already pending, skipping');
      return;
    }

    // Initialize question set state
    this.state.pendingQuestionSet = {
      toolUseId: op.toolUseId,
      currentIndex: op.currentIndex,
      currentPostId: null,
      questions: op.questions.map((q) => ({
        header: q.header,
        question: q.question,
        options: q.options,
        answer: null,
      })),
    };

    // Post the first question
    await this.postCurrentQuestion(ctx);
  }

  /**
   * Execute an approval operation.
   */
  async executeApproval(op: ApprovalOp, ctx: ExecutorContext): Promise<void> {
    const logger = log.forSession(ctx.sessionId);

    // If already have pending approval, don't post another
    if (this.state.pendingApproval) {
      logger.debug('Approval already pending, skipping');
      return;
    }

    const formatter = ctx.platform.getFormatter();

    // Build approval message based on type
    let message: string;
    if (op.approvalType === 'plan') {
      message =
        `✅ ${formatter.formatBold('Plan ready for approval')}\n\n` +
        `👍 Approve and start building\n` +
        `👎 Request changes\n\n` +
        formatter.formatItalic('React to respond');
    } else {
      message =
        `⚠️ ${formatter.formatBold('Action requires approval')}\n\n`;
      if (op.content) {
        message += `${op.content}\n\n`;
      }
      message +=
        `👍 Approve\n` +
        `👎 Deny\n\n` +
        formatter.formatItalic('React to respond');
    }

    // Create interactive post with approval reactions
    const post = await ctx.platform.createInteractivePost(
      message,
      [APPROVAL_EMOJIS[0], DENIAL_EMOJIS[0]],
      ctx.threadId
    );

    // Track pending approval state
    this.state.pendingApproval = {
      postId: post.id,
      type: op.approvalType,
      toolUseId: op.toolUseId,
    };

    // Register post for reaction routing
    this.registerPost(post.id, {
      type: 'plan_approval',
      interactionType: 'plan_approval',
      toolUseId: op.toolUseId,
    });
    this.updateLastMessage(post);

    logger.debug(`Created ${op.approvalType} approval post ${post.id.substring(0, 8)}`);
  }

  /**
   * Post the current question in the question set.
   */
  async postCurrentQuestion(ctx: ExecutorContext): Promise<void> {
    if (!this.state.pendingQuestionSet) return;

    const { currentIndex, questions } = this.state.pendingQuestionSet;
    if (currentIndex >= questions.length) return;

    const q = questions[currentIndex];
    const total = questions.length;
    const formatter = ctx.platform.getFormatter();

    // Format the question message
    let message = `❓ ${formatter.formatBold('Question')} ${formatter.formatItalic(`(${currentIndex + 1}/${total})`)}\n`;
    message += `${formatter.formatBold(`${q.header}:`)} ${q.question}\n\n`;

    for (let i = 0; i < q.options.length && i < 4; i++) {
      const emoji = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'][i];
      message += `${emoji} ${formatter.formatBold(q.options[i].label)}`;
      if (q.options[i].description) {
        message += ` - ${q.options[i].description}`;
      }
      message += '\n';
    }

    // Post the question with reaction options
    const reactionOptions = NUMBER_EMOJIS.slice(0, q.options.length);
    const post = await ctx.platform.createInteractivePost(
      message,
      reactionOptions,
      ctx.threadId
    );

    this.state.pendingQuestionSet.currentPostId = post.id;

    // Register post for reaction routing
    this.registerPost(post.id, {
      type: 'question',
      interactionType: 'question',
      toolUseId: this.state.pendingQuestionSet.toolUseId,
    });
    this.updateLastMessage(post);
  }

  /**
   * Handle a question answer reaction.
   * Returns true if the reaction was handled, false otherwise.
   */
  async handleQuestionAnswer(
    postId: string,
    optionIndex: number,
    ctx: ExecutorContext
  ): Promise<boolean> {
    if (!this.state.pendingQuestionSet) return false;
    if (this.state.pendingQuestionSet.currentPostId !== postId) return false;

    const { currentIndex, questions, toolUseId } = this.state.pendingQuestionSet;
    const question = questions[currentIndex];
    if (!question) return false;

    if (optionIndex < 0 || optionIndex >= question.options.length) return false;

    const logger = log.forSession(ctx.sessionId);
    const selectedOption = question.options[optionIndex];
    question.answer = selectedOption.label;

    logger.debug(`Question "${question.header}" answered: ${selectedOption.label}`);

    // Update the post to show answer
    const formatter = ctx.platform.getFormatter();
    try {
      await ctx.platform.updatePost(
        postId,
        `✅ ${formatter.formatBold(question.header)}: ${selectedOption.label}`
      );
    } catch (err) {
      logger.debug(`Failed to update question post: ${err}`);
    }

    // Move to next question or finish
    this.state.pendingQuestionSet.currentIndex++;

    if (this.state.pendingQuestionSet.currentIndex < questions.length) {
      // Post next question
      await this.postCurrentQuestion(ctx);
    } else {
      // All questions answered
      logger.debug('All questions answered');

      // Collect answers
      const answers = questions
        .filter((q): q is PendingQuestion & { answer: string } => q.answer !== null)
        .map((q) => ({ header: q.header, answer: q.answer }));

      // Clear pending state
      this.state.pendingQuestionSet = null;

      // Emit question complete event
      if (this.events) {
        this.events.emit('question:complete', { toolUseId, answers });
      }
    }

    return true;
  }

  /**
   * Handle an approval reaction.
   * Returns true if the reaction was handled, false otherwise.
   */
  async handleApprovalResponse(
    postId: string,
    approved: boolean,
    ctx: ExecutorContext
  ): Promise<boolean> {
    if (!this.state.pendingApproval) return false;
    if (this.state.pendingApproval.postId !== postId) return false;

    const logger = log.forSession(ctx.sessionId);
    const { type, toolUseId } = this.state.pendingApproval;
    const formatter = ctx.platform.getFormatter();

    logger.info(`${type} ${approved ? 'approved' : 'rejected'}`);

    // Update the post to show decision
    const statusMessage = approved
      ? `✅ ${formatter.formatBold(type === 'plan' ? 'Plan approved' : 'Action approved')} - proceeding...`
      : `❌ ${formatter.formatBold(type === 'plan' ? 'Changes requested' : 'Action denied')}`;

    try {
      await ctx.platform.updatePost(postId, statusMessage);
    } catch (err) {
      logger.debug(`Failed to update approval post: ${err}`);
    }

    // Clear pending state
    this.state.pendingApproval = null;

    // Emit approval complete event
    if (this.events) {
      this.events.emit('approval:complete', { toolUseId, approved });
    }

    return true;
  }

  /**
   * Clear pending approval (e.g., when plan is already approved).
   */
  clearPendingApproval(): void {
    this.state.pendingApproval = null;
  }

  /**
   * Clear pending questions (e.g., when session ends).
   */
  clearPendingQuestions(): void {
    this.state.pendingQuestionSet = null;
  }

  /**
   * Clear pending question set (alias for clearPendingQuestions).
   */
  clearPendingQuestionSet(): void {
    this.state.pendingQuestionSet = null;
  }

  /**
   * Advance to the next question in the pending question set.
   */
  advanceQuestionIndex(): void {
    if (this.state.pendingQuestionSet) {
      this.state.pendingQuestionSet.currentIndex++;
    }
  }

  // ---------------------------------------------------------------------------
  // Message approval methods
  // ---------------------------------------------------------------------------

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
  // Context prompt methods
  // ---------------------------------------------------------------------------

  /**
   * Set pending context prompt state.
   * Called when starting a session mid-thread and offering context selection.
   */
  setPendingContextPrompt(prompt: PendingContextPrompt): void {
    this.state.pendingContextPrompt = prompt;
  }

  /**
   * Get pending context prompt state.
   */
  getPendingContextPrompt(): PendingContextPrompt | null {
    return this.state.pendingContextPrompt;
  }

  /**
   * Check if there's a pending context prompt.
   */
  hasPendingContextPrompt(): boolean {
    return this.state.pendingContextPrompt !== null;
  }

  /**
   * Clear pending context prompt state.
   */
  clearPendingContextPrompt(): void {
    this.state.pendingContextPrompt = null;
  }

  /**
   * Handle a context prompt reaction.
   * Returns true if the reaction was handled, false otherwise.
   *
   * @param postId - The post ID the reaction was on
   * @param selection - The context selection (number of messages or 'timeout')
   * @param username - Username of the user who responded (for logging)
   * @param ctx - Executor context
   */
  async handleContextPromptResponse(
    postId: string,
    selection: ContextPromptSelection,
    username: string,
    ctx: ExecutorContext
  ): Promise<boolean> {
    if (!this.state.pendingContextPrompt) return false;
    if (this.state.pendingContextPrompt.postId !== postId) return false;

    const logger = log.forSession(ctx.sessionId);
    const { queuedPrompt, queuedFiles, threadMessageCount } = this.state.pendingContextPrompt;
    const formatter = ctx.platform.getFormatter();

    // Update the post based on selection
    let statusMessage: string;
    if (selection === 'timeout') {
      statusMessage = `⏱️ Continuing without context (no response)`;
      logger.info(`Context prompt timed out, continuing without context`);
    } else if (selection === 0) {
      statusMessage = `✅ Continuing without context (skipped by ${formatter.formatUserMention(username)})`;
      logger.info(`Context skipped by @${username}`);
    } else {
      statusMessage = `✅ Including last ${selection} messages (selected by ${formatter.formatUserMention(username)})`;
      logger.info(`Context selection: last ${selection} messages by @${username}`);
    }

    try {
      await ctx.platform.updatePost(postId, statusMessage);
    } catch (err) {
      logger.debug(`Failed to update context prompt post: ${err}`);
    }

    // Clear pending state
    this.state.pendingContextPrompt = null;

    // Emit context prompt complete event
    if (this.events) {
      this.events.emit('context-prompt:complete', {
        selection,
        queuedPrompt,
        queuedFiles,
        threadMessageCount,
      });
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Existing worktree prompt methods
  // ---------------------------------------------------------------------------

  /**
   * Set pending existing worktree prompt state.
   * Called when an existing worktree is found and user must decide to join or skip.
   */
  setPendingExistingWorktreePrompt(prompt: PendingExistingWorktreePrompt): void {
    this.state.pendingExistingWorktreePrompt = prompt;
  }

  /**
   * Get pending existing worktree prompt state.
   */
  getPendingExistingWorktreePrompt(): PendingExistingWorktreePrompt | null {
    return this.state.pendingExistingWorktreePrompt;
  }

  /**
   * Check if there's a pending existing worktree prompt.
   */
  hasPendingExistingWorktreePrompt(): boolean {
    return this.state.pendingExistingWorktreePrompt !== null;
  }

  /**
   * Clear pending existing worktree prompt state.
   */
  clearPendingExistingWorktreePrompt(): void {
    this.state.pendingExistingWorktreePrompt = null;
  }

  /**
   * Handle an existing worktree prompt reaction.
   * Returns true if the reaction was handled, false otherwise.
   *
   * @param postId - The post ID the reaction was on
   * @param decision - The worktree decision (join or skip)
   * @param username - Username of the user who responded (for logging)
   * @param ctx - Executor context
   */
  async handleExistingWorktreeResponse(
    postId: string,
    decision: ExistingWorktreeDecision,
    username: string,
    ctx: ExecutorContext
  ): Promise<boolean> {
    if (!this.state.pendingExistingWorktreePrompt) return false;
    if (this.state.pendingExistingWorktreePrompt.postId !== postId) return false;

    const logger = log.forSession(ctx.sessionId);
    const { branch, worktreePath } = this.state.pendingExistingWorktreePrompt;
    const formatter = ctx.platform.getFormatter();

    // Update the post based on decision
    let statusMessage: string;
    if (decision === 'join') {
      statusMessage = `✅ Joining existing worktree ${formatter.formatBold(branch)} (${formatter.formatUserMention(username)})`;
      logger.info(`Joining existing worktree ${branch} by @${username}`);
    } else {
      statusMessage = `✅ Continuing in current directory (skipped by ${formatter.formatUserMention(username)})`;
      logger.info(`Skipped joining existing worktree ${branch} by @${username}`);
    }

    try {
      await ctx.platform.updatePost(postId, statusMessage);
    } catch (err) {
      logger.debug(`Failed to update existing worktree prompt post: ${err}`);
    }

    // Clear pending state
    this.state.pendingExistingWorktreePrompt = null;

    // Emit worktree prompt complete event
    if (this.events) {
      this.events.emit('worktree-prompt:complete', {
        decision,
        branch,
        worktreePath,
        username,
      });
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Update prompt methods
  // ---------------------------------------------------------------------------

  /**
   * Set pending update prompt state.
   * Called when a version update is available and user must decide to update or defer.
   */
  setPendingUpdatePrompt(prompt: PendingUpdatePrompt): void {
    this.state.pendingUpdatePrompt = prompt;
  }

  /**
   * Get pending update prompt state.
   */
  getPendingUpdatePrompt(): PendingUpdatePrompt | null {
    return this.state.pendingUpdatePrompt;
  }

  /**
   * Check if there's a pending update prompt.
   */
  hasPendingUpdatePrompt(): boolean {
    return this.state.pendingUpdatePrompt !== null;
  }

  /**
   * Clear pending update prompt state.
   */
  clearPendingUpdatePrompt(): void {
    this.state.pendingUpdatePrompt = null;
  }

  /**
   * Handle an update prompt reaction.
   * Returns true if the reaction was handled, false otherwise.
   *
   * @param postId - The post ID the reaction was on
   * @param decision - The update decision (update_now or defer)
   * @param username - Username of the user who responded (for logging)
   * @param ctx - Executor context
   */
  async handleUpdatePromptResponse(
    postId: string,
    decision: UpdatePromptDecision,
    username: string,
    ctx: ExecutorContext
  ): Promise<boolean> {
    if (!this.state.pendingUpdatePrompt) return false;
    if (this.state.pendingUpdatePrompt.postId !== postId) return false;

    const logger = log.forSession(ctx.sessionId);
    const formatter = ctx.platform.getFormatter();

    // Update the post based on decision
    let statusMessage: string;
    if (decision === 'update_now') {
      statusMessage = `🔄 ${formatter.formatBold('Forcing update')} - restarting shortly...`;
      logger.info(`Update prompt: forcing update now by @${username}`);
    } else {
      statusMessage = `⏸️ ${formatter.formatBold('Update deferred')} for 1 hour`;
      logger.info(`Update prompt: update deferred by @${username}`);
    }

    try {
      await ctx.platform.updatePost(postId, statusMessage);
    } catch (err) {
      logger.debug(`Failed to update update prompt post: ${err}`);
    }

    // Clear pending state
    this.state.pendingUpdatePrompt = null;

    // Emit update prompt complete event
    if (this.events) {
      this.events.emit('update-prompt:complete', { decision });
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Bug report methods
  // ---------------------------------------------------------------------------

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
   * Handle a reaction on any interactive post.
   * Routes to the appropriate handler based on pending state.
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

    // Check pending question set
    if (this.state.pendingQuestionSet?.currentPostId === postId) {
      const index = getNumberEmojiIndex(emoji);
      if (index >= 0) {
        logger.debug(`Question answer reaction from @${user}: option ${index + 1}`);
        return this.handleQuestionAnswer(postId, index, ctx);
      }
      return false;
    }

    // Check pending approval
    if (this.state.pendingApproval?.postId === postId) {
      if (isApprovalEmoji(emoji)) {
        logger.debug(`Approval reaction from @${user}: approved`);
        return this.handleApprovalResponse(postId, true, ctx);
      }
      if (isDenialEmoji(emoji)) {
        logger.debug(`Approval reaction from @${user}: denied`);
        return this.handleApprovalResponse(postId, false, ctx);
      }
      return false;
    }

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

    // Check pending context prompt
    if (this.state.pendingContextPrompt?.postId === postId) {
      // Check for number emoji (to include N messages)
      const index = getNumberEmojiIndex(emoji);
      if (index >= 0) {
        // Number emojis are 1-indexed in context prompts (1 = 1 message, etc.)
        const { availableOptions } = this.state.pendingContextPrompt;
        if (index < availableOptions.length) {
          const selection = availableOptions[index];
          logger.debug(`Context prompt reaction from @${user}: ${selection} messages`);
          return this.handleContextPromptResponse(postId, selection, user, ctx);
        }
      }
      // Check for skip emoji (x or similar denial emoji means skip)
      if (isDenialEmoji(emoji)) {
        logger.debug(`Context prompt reaction from @${user}: skip`);
        return this.handleContextPromptResponse(postId, 0, user, ctx);
      }
      return false;
    }

    // Check pending existing worktree prompt
    if (this.state.pendingExistingWorktreePrompt?.postId === postId) {
      if (isApprovalEmoji(emoji)) {
        logger.debug(`Existing worktree reaction from @${user}: join`);
        return this.handleExistingWorktreeResponse(postId, 'join', user, ctx);
      }
      if (isDenialEmoji(emoji)) {
        logger.debug(`Existing worktree reaction from @${user}: skip`);
        return this.handleExistingWorktreeResponse(postId, 'skip', user, ctx);
      }
      return false;
    }

    // Check pending update prompt
    if (this.state.pendingUpdatePrompt?.postId === postId) {
      if (isApprovalEmoji(emoji)) {
        logger.debug(`Update prompt reaction from @${user}: update_now`);
        return this.handleUpdatePromptResponse(postId, 'update_now', user, ctx);
      }
      if (isDenialEmoji(emoji)) {
        logger.debug(`Update prompt reaction from @${user}: defer`);
        return this.handleUpdatePromptResponse(postId, 'defer', user, ctx);
      }
      return false;
    }

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

    // No pending interactive state matched
    return false;
  }
}
