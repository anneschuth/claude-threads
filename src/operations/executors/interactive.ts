/**
 * Interactive Executor - Handles QuestionOp and ApprovalOp
 *
 * Responsible for:
 * - Posting questions with reaction options
 * - Posting approval prompts
 * - Managing pending question/approval state
 * - Processing user responses via reactions
 */

import { NUMBER_EMOJIS, APPROVAL_EMOJIS, DENIAL_EMOJIS } from '../../utils/emoji.js';
import type { QuestionOp, ApprovalOp } from '../types.js';
import type { ExecutorContext, InteractiveState, PendingMessageApproval, PendingContextPrompt, RegisterPostCallback, UpdateLastMessageCallback } from './types.js';
import { createLogger } from '../../utils/logger.js';

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

export class InteractiveExecutor {
  private state: InteractiveState;
  private registerPost: RegisterPostCallback;
  private updateLastMessage: UpdateLastMessageCallback;
  private onQuestionComplete?: (toolUseId: string, answers: Array<{ header: string; answer: string }>) => void;
  private onApprovalComplete?: (toolUseId: string, approved: boolean) => void;
  private onMessageApprovalComplete?: MessageApprovalCallback;
  private onContextPromptComplete?: ContextPromptCallback;

  constructor(options: {
    registerPost: RegisterPostCallback;
    updateLastMessage: UpdateLastMessageCallback;
    onQuestionComplete?: (toolUseId: string, answers: Array<{ header: string; answer: string }>) => void;
    onApprovalComplete?: (toolUseId: string, approved: boolean) => void;
    onMessageApprovalComplete?: MessageApprovalCallback;
    onContextPromptComplete?: ContextPromptCallback;
  }) {
    this.state = {
      pendingQuestionSet: null,
      pendingApproval: null,
      pendingMessageApproval: null,
      pendingContextPrompt: null,
    };
    this.registerPost = options.registerPost;
    this.updateLastMessage = options.updateLastMessage;
    this.onQuestionComplete = options.onQuestionComplete;
    this.onApprovalComplete = options.onApprovalComplete;
    this.onMessageApprovalComplete = options.onMessageApprovalComplete;
    this.onContextPromptComplete = options.onContextPromptComplete;
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
  }): void {
    this.state = {
      pendingQuestionSet: persisted.pendingQuestionSet ?? null,
      pendingApproval: persisted.pendingApproval ?? null,
      pendingMessageApproval: persisted.pendingMessageApproval ?? null,
      pendingContextPrompt: persisted.pendingContextPrompt ?? null,
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

      // Notify completion handler
      if (this.onQuestionComplete) {
        this.onQuestionComplete(toolUseId, answers);
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

    // Notify completion handler
    if (this.onApprovalComplete) {
      this.onApprovalComplete(toolUseId, approved);
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

    // Notify completion handler
    if (this.onMessageApprovalComplete) {
      await this.onMessageApprovalComplete(decision, { fromUser, originalMessage });
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

    // Notify completion handler
    if (this.onContextPromptComplete) {
      await this.onContextPromptComplete(selection, {
        queuedPrompt,
        queuedFiles,
        threadMessageCount,
      });
    }

    return true;
  }
}
