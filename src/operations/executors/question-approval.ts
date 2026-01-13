/**
 * Question & Approval Executor - Handles QuestionOp and ApprovalOp
 *
 * Responsible for:
 * - Posting questions with reaction options
 * - Posting approval prompts
 * - Managing pending question/approval state
 * - Processing user responses via reactions
 */

import { NUMBER_EMOJIS, APPROVAL_EMOJIS, DENIAL_EMOJIS, isApprovalEmoji, isDenialEmoji, getNumberEmojiIndex } from '../../utils/emoji.js';
import { formatShortId } from '../../utils/format.js';
import type { QuestionOp, ApprovalOp } from '../types.js';
import type { ExecutorContext, QuestionApprovalState } from './types.js';
import { BaseExecutor, type ExecutorOptions } from './base.js';

// ---------------------------------------------------------------------------
// Types
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

// ---------------------------------------------------------------------------
// Question & Approval Executor
// ---------------------------------------------------------------------------

/**
 * Executor for question and approval operations.
 */
export class QuestionApprovalExecutor extends BaseExecutor<QuestionApprovalState> {
  constructor(options: ExecutorOptions) {
    super(options, QuestionApprovalExecutor.createInitialState());
  }

  private static createInitialState(): QuestionApprovalState {
    return {
      pendingQuestionSet: null,
      pendingApproval: null,
    };
  }

  protected getInitialState(): QuestionApprovalState {
    return QuestionApprovalExecutor.createInitialState();
  }

  /**
   * Get the current state (for inspection/testing).
   * Override to provide deep copy of nested objects.
   */
  override getState(): Readonly<QuestionApprovalState> {
    return {
      pendingQuestionSet: this.state.pendingQuestionSet
        ? { ...this.state.pendingQuestionSet }
        : null,
      pendingApproval: this.state.pendingApproval
        ? { ...this.state.pendingApproval }
        : null,
    };
  }

  /**
   * Hydrate state from persisted session data.
   * Used when resuming a session after bot restart.
   */
  hydrateState(persisted: {
    pendingQuestionSet?: QuestionApprovalState['pendingQuestionSet'];
    pendingApproval?: QuestionApprovalState['pendingApproval'];
  }): void {
    this.state = {
      pendingQuestionSet: persisted.pendingQuestionSet ?? null,
      pendingApproval: persisted.pendingApproval ?? null,
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
  getPendingApproval(): QuestionApprovalState['pendingApproval'] {
    return this.state.pendingApproval;
  }

  /**
   * Get pending question set info.
   */
  getPendingQuestionSet(): QuestionApprovalState['pendingQuestionSet'] {
    return this.state.pendingQuestionSet;
  }

  /**
   * Execute a question or approval operation.
   * Unified entry point for all operations handled by this executor.
   */
  async execute(op: QuestionOp | ApprovalOp, ctx: ExecutorContext): Promise<void> {
    if (op.type === 'question') {
      return this.handleQuestion(op, ctx);
    } else if (op.type === 'approval') {
      return this.handleApproval(op, ctx);
    }
  }

  /**
   * Handle a question operation.
   */
  private async handleQuestion(op: QuestionOp, ctx: ExecutorContext): Promise<void> {
    // If already have pending questions, don't start another set
    if (this.state.pendingQuestionSet) {
      ctx.logger.debug('AskUserQuestion: Already pending, skipping new question set');
      return;
    }

    ctx.logger.debug(
      `AskUserQuestion: Received ${op.questions.length} question(s), starting at index ${op.currentIndex}`
    );

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
   * Handle an approval operation.
   */
  private async handleApproval(op: ApprovalOp, ctx: ExecutorContext): Promise<void> {
    // If already have pending approval, don't post another
    if (this.state.pendingApproval) {
      ctx.logger.debug(`ExitPlanMode: ${op.approvalType} approval already pending, skipping`);
      return;
    }

    ctx.logger.debug(`ExitPlanMode: Requesting ${op.approvalType} approval`);

    // Build approval message based on type
    let message: string;
    if (op.approvalType === 'plan') {
      message =
        `✅ ${ctx.formatter.formatBold('Plan ready for approval')}\n\n` +
        `👍 Approve and start building\n` +
        `👎 Request changes\n\n` +
        ctx.formatter.formatItalic('React to respond');
    } else {
      message =
        `⚠️ ${ctx.formatter.formatBold('Action requires approval')}\n\n`;
      if (op.content) {
        message += `${op.content}\n\n`;
      }
      message +=
        `👍 Approve\n` +
        `👎 Deny\n\n` +
        ctx.formatter.formatItalic('React to respond');
    }

    // Create interactive post with approval reactions
    const post = await ctx.createInteractivePost(
      message,
      [APPROVAL_EMOJIS[0], DENIAL_EMOJIS[0]],
      {
        type: 'plan_approval',
        interactionType: 'plan_approval',
        toolUseId: op.toolUseId,
      }
    );

    // Track pending approval state
    this.state.pendingApproval = {
      postId: post.id,
      type: op.approvalType,
      toolUseId: op.toolUseId,
    };

    ctx.logger.debug(`Created ${op.approvalType} approval post ${formatShortId(post.id)}`);
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

    ctx.logger.debug(
      `AskUserQuestion: Posting question ${currentIndex + 1}/${total} - "${q.header}" (${q.options.length} options)`
    );

    // Format the question message
    let message = `❓ ${ctx.formatter.formatBold('Question')} ${ctx.formatter.formatItalic(`(${currentIndex + 1}/${total})`)}\n`;
    message += `${ctx.formatter.formatBold(`${q.header}:`)} ${q.question}\n\n`;

    for (let i = 0; i < q.options.length && i < 4; i++) {
      const emoji = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'][i];
      message += `${emoji} ${ctx.formatter.formatBold(q.options[i].label)}`;
      if (q.options[i].description) {
        message += ` - ${q.options[i].description}`;
      }
      message += '\n';
    }

    // Post the question with reaction options
    const reactionOptions = NUMBER_EMOJIS.slice(0, q.options.length);
    const post = await ctx.createInteractivePost(
      message,
      reactionOptions,
      {
        type: 'question',
        interactionType: 'question',
        toolUseId: this.state.pendingQuestionSet.toolUseId,
      }
    );

    this.state.pendingQuestionSet.currentPostId = post.id;
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

        const selectedOption = question.options[optionIndex];
    question.answer = selectedOption.label;

    ctx.logger.debug(`Question "${question.header}" answered: ${selectedOption.label}`);

    // Update the post to show answer
    try {
      await ctx.platform.updatePost(
        postId,
        `✅ ${ctx.formatter.formatBold(question.header)}: ${selectedOption.label}`
      );
    } catch (err) {
      ctx.logger.debug(`Failed to update question post: ${err}`);
    }

    // Move to next question or finish
    this.state.pendingQuestionSet.currentIndex++;

    if (this.state.pendingQuestionSet.currentIndex < questions.length) {
      // Post next question
      await this.postCurrentQuestion(ctx);
    } else {
      // All questions answered
      ctx.logger.debug('All questions answered');

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

        const { type, toolUseId } = this.state.pendingApproval;

    ctx.logger.info(`${type} ${approved ? 'approved' : 'rejected'}`);

    // Update the post to show decision
    const statusMessage = approved
      ? `✅ ${ctx.formatter.formatBold(type === 'plan' ? 'Plan approved' : 'Action approved')} - proceeding...`
      : `❌ ${ctx.formatter.formatBold(type === 'plan' ? 'Changes requested' : 'Action denied')}`;

    try {
      await ctx.platform.updatePost(postId, statusMessage);
    } catch (err) {
      ctx.logger.debug(`Failed to update approval post: ${err}`);
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
   * Clear pending question set (e.g., when session ends).
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
    ctx.logger.debug(`QuestionApprovalExecutor.handleReaction: postId=${formatShortId(postId)}, emoji=${emoji}, user=${user}, action=${action}`);

    // Only handle 'added' reactions
    if (action !== 'added') {
      ctx.logger.debug(`QuestionApprovalExecutor: ignoring ${action} reaction (only handling 'added')`);
      return false;
    }

    // Check pending question set
    if (this.state.pendingQuestionSet?.currentPostId === postId) {
      const index = getNumberEmojiIndex(emoji);
      if (index >= 0) {
        ctx.logger.debug(`Question answer reaction from @${user}: option ${index + 1}`);
        const handled = await this.handleQuestionAnswer(postId, index, ctx);
        ctx.logger.debug(`QuestionApprovalExecutor: question answer ${handled ? 'accepted' : 'rejected'}`);
        return handled;
      }
      ctx.logger.debug(`QuestionApprovalExecutor: emoji ${emoji} is not a number emoji, ignoring`);
      return false;
    }

    // Check pending approval
    if (this.state.pendingApproval?.postId === postId) {
      if (isApprovalEmoji(emoji)) {
        ctx.logger.debug(`Approval reaction from @${user}: approved`);
        const handled = await this.handleApprovalResponse(postId, true, ctx);
        ctx.logger.debug(`QuestionApprovalExecutor: approval outcome=approved, handled=${handled}`);
        return handled;
      }
      if (isDenialEmoji(emoji)) {
        ctx.logger.debug(`Approval reaction from @${user}: denied`);
        const handled = await this.handleApprovalResponse(postId, false, ctx);
        ctx.logger.debug(`QuestionApprovalExecutor: approval outcome=denied, handled=${handled}`);
        return handled;
      }
      ctx.logger.debug(`QuestionApprovalExecutor: emoji ${emoji} is not an approval/denial emoji, ignoring`);
      return false;
    }

    // No pending state matched
    ctx.logger.debug(`QuestionApprovalExecutor: no pending state matches postId=${formatShortId(postId)}`);
    return false;
  }
}
