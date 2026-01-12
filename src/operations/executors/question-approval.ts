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
import type { QuestionOp, ApprovalOp } from '../types.js';
import type { ExecutorContext, QuestionApprovalState } from './types.js';
import { createLogger } from '../../utils/logger.js';
import { BaseExecutor, type ExecutorOptions } from './base.js';

const log = createLogger('question-approval-executor');

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

/**
 * Callback for question completion.
 */
export type QuestionCompleteCallback = (
  toolUseId: string,
  answers: Array<{ header: string; answer: string }>
) => void;

/**
 * Callback for approval completion.
 */
export type ApprovalCompleteCallback = (toolUseId: string, approved: boolean) => void;

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
   * Handle an approval operation.
   */
  private async handleApproval(op: ApprovalOp, ctx: ExecutorContext): Promise<void> {
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

    // No pending state matched
    return false;
  }
}
