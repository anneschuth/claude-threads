/**
 * Message Manager - Orchestrates the operation pipeline
 *
 * Handles Claude events by transforming them to operations and
 * dispatching to appropriate executors.
 */

import type { PlatformClient, PlatformPost } from '../platform/index.js';
import type { PendingQuestionSet } from '../session/types.js';
import type { ClaudeEvent } from '../claude/cli.js';
import { transformEvent, type TransformContext } from './transformer.js';
import {
  ContentExecutor,
  TaskListExecutor,
  InteractiveExecutor,
  SubagentExecutor,
  SystemExecutor,
} from './executors/index.js';
import type { MessageApprovalDecision, MessageApprovalCallback, ContextPromptCallback, ContextPromptSelection } from './executors/interactive.js';
import type { ExecutorContext, RegisterPostCallback, UpdateLastMessageCallback, PendingMessageApproval, PendingContextPrompt } from './executors/types.js';
import { PostTracker } from './post-tracker.js';
import { DefaultContentBreaker } from './content-breaker.js';
import type {
  MessageOperation,
  AppendContentOp,
  FlushOp,
  StatusUpdateOp,
  LifecycleOp,
} from './types.js';
import {
  isContentOp,
  isFlushOp,
  isTaskListOp,
  isQuestionOp,
  isApprovalOp,
  isSystemMessageOp,
  isSubagentOp,
  isStatusUpdateOp,
  isLifecycleOp,
  createFlushOp,
} from './types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('message-manager');

/**
 * Callback to handle question completion
 */
export type QuestionCompleteCallback = (
  toolUseId: string,
  answers: Array<{ header: string; answer: string }>
) => void;

/**
 * Callback to handle approval completion
 */
export type ApprovalCompleteCallback = (
  toolUseId: string,
  approved: boolean
) => void;

/**
 * Callback to handle status updates
 */
export type StatusUpdateCallback = (status: Partial<StatusUpdateOp>) => void;

/**
 * Callback to handle lifecycle events
 */
export type LifecycleCallback = (event: LifecycleOp['event']) => void;

/**
 * Options for creating a MessageManager
 */
export interface MessageManagerOptions {
  platform: PlatformClient;
  postTracker: PostTracker;
  threadId: string;
  sessionId: string;
  worktreePath?: string;
  worktreeBranch?: string;
  registerPost: RegisterPostCallback;
  updateLastMessage: UpdateLastMessageCallback;
  onQuestionComplete: QuestionCompleteCallback;
  onApprovalComplete: ApprovalCompleteCallback;
  onMessageApprovalComplete?: MessageApprovalCallback;
  onContextPromptComplete?: ContextPromptCallback;
  onStatusUpdate?: StatusUpdateCallback;
  onLifecycleEvent?: LifecycleCallback;
  onBumpTaskList?: () => Promise<void>;
}

/**
 * Message Manager - Orchestrates the operation pipeline
 *
 * Transforms Claude CLI events into operations and dispatches them
 * to the appropriate executors for rendering to the chat platform.
 */
export class MessageManager {
  private platform: PlatformClient;
  private postTracker: PostTracker;
  private contentBreaker: DefaultContentBreaker;

  // Executors
  private contentExecutor: ContentExecutor;
  private taskListExecutor: TaskListExecutor;
  private interactiveExecutor: InteractiveExecutor;
  private subagentExecutor: SubagentExecutor;
  private systemExecutor: SystemExecutor;

  // Context for transformation
  private sessionId: string;
  private threadId: string;
  private worktreePath?: string;
  private worktreeBranch?: string;

  // Callbacks
  private registerPost: RegisterPostCallback;
  private updateLastMessage: UpdateLastMessageCallback;
  private onStatusUpdate?: StatusUpdateCallback;
  private onLifecycleEvent?: LifecycleCallback;

  // Tool start times for elapsed time calculation
  private toolStartTimes: Map<string, number> = new Map();

  // Flush scheduling
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private static FLUSH_DELAY_MS = 500;

  constructor(options: MessageManagerOptions) {
    this.platform = options.platform;
    this.postTracker = options.postTracker;
    this.sessionId = options.sessionId;
    this.threadId = options.threadId;
    this.worktreePath = options.worktreePath;
    this.worktreeBranch = options.worktreeBranch;
    this.registerPost = options.registerPost;
    this.updateLastMessage = options.updateLastMessage;
    this.onStatusUpdate = options.onStatusUpdate;
    this.onLifecycleEvent = options.onLifecycleEvent;

    // Create content breaker
    this.contentBreaker = new DefaultContentBreaker();

    // Create executors
    this.contentExecutor = new ContentExecutor({
      registerPost: options.registerPost,
      updateLastMessage: options.updateLastMessage,
      onBumpTaskList: options.onBumpTaskList
        ? async () => {
            await options.onBumpTaskList!();
            return null;
          }
        : undefined,
    });

    this.taskListExecutor = new TaskListExecutor({
      registerPost: options.registerPost,
      updateLastMessage: options.updateLastMessage,
    });

    this.interactiveExecutor = new InteractiveExecutor({
      registerPost: options.registerPost,
      updateLastMessage: options.updateLastMessage,
      onQuestionComplete: options.onQuestionComplete,
      onApprovalComplete: options.onApprovalComplete,
      onMessageApprovalComplete: options.onMessageApprovalComplete,
      onContextPromptComplete: options.onContextPromptComplete,
    });

    this.subagentExecutor = new SubagentExecutor({
      registerPost: options.registerPost,
      updateLastMessage: options.updateLastMessage,
      onBumpTaskList: options.onBumpTaskList,
    });

    this.systemExecutor = new SystemExecutor({
      registerPost: options.registerPost,
      updateLastMessage: options.updateLastMessage,
      onStatusUpdate: options.onStatusUpdate,
      onLifecycleEvent: options.onLifecycleEvent,
    });
  }

  /**
   * Handle a Claude CLI event
   */
  async handleEvent(event: ClaudeEvent): Promise<void> {
    const logger = log.forSession(this.sessionId);

    // Build transformation context
    const transformCtx: TransformContext = {
      sessionId: this.sessionId,
      formatter: this.platform.getFormatter(),
      toolStartTimes: this.toolStartTimes,
      detailed: true,
      worktreeInfo: this.worktreePath && this.worktreeBranch
        ? { path: this.worktreePath, branch: this.worktreeBranch }
        : undefined,
    };

    // Transform event to operations
    const ops = transformEvent(event, transformCtx);

    if (ops.length === 0) {
      logger.debug(`No operations from event: ${event.type}`);
      return;
    }

    logger.debug(`Transformed ${event.type} to ${ops.length} operation(s)`);

    // Execute each operation
    for (const op of ops) {
      await this.executeOperation(op);
    }
  }

  /**
   * Execute a single operation
   */
  private async executeOperation(op: MessageOperation): Promise<void> {
    const logger = log.forSession(this.sessionId);
    const ctx = this.getExecutorContext();

    try {
      if (isContentOp(op)) {
        await this.handleContentOp(op, ctx);
      } else if (isFlushOp(op)) {
        await this.handleFlushOp(op, ctx);
      } else if (isTaskListOp(op)) {
        await this.taskListExecutor.execute(op, ctx);
      } else if (isQuestionOp(op)) {
        await this.interactiveExecutor.executeQuestion(op, ctx);
      } else if (isApprovalOp(op)) {
        await this.interactiveExecutor.executeApproval(op, ctx);
      } else if (isSystemMessageOp(op)) {
        await this.systemExecutor.executeSystemMessage(op, ctx);
      } else if (isSubagentOp(op)) {
        await this.subagentExecutor.execute(op, ctx);
      } else if (isStatusUpdateOp(op)) {
        await this.systemExecutor.executeStatusUpdate(op, ctx);
      } else if (isLifecycleOp(op)) {
        await this.systemExecutor.executeLifecycle(op, ctx);
      } else {
        // Type narrowing - if we get here, it means we have an unhandled operation type
        const unknownOp = op as { type: string };
        logger.warn(`Unknown operation type: ${unknownOp.type}`);
      }
    } catch (err) {
      logger.error(`Failed to execute operation ${op.type}: ${err}`);
    }
  }

  /**
   * Handle content append operation
   */
  private async handleContentOp(op: AppendContentOp, ctx: ExecutorContext): Promise<void> {
    // Append content to executor
    await this.contentExecutor.executeAppend(op, ctx);

    // Schedule flush if not already scheduled
    this.scheduleFlush(ctx);
  }

  /**
   * Handle flush operation
   */
  private async handleFlushOp(op: FlushOp, ctx: ExecutorContext): Promise<void> {
    // Cancel any pending scheduled flush
    this.cancelScheduledFlush();

    // Execute the flush
    await this.contentExecutor.executeFlush(op, ctx);
  }

  /**
   * Schedule a delayed flush
   */
  private scheduleFlush(ctx: ExecutorContext): void {
    if (this.flushTimer) return;

    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      const flushOp = createFlushOp(this.sessionId, 'soft_threshold');
      await this.contentExecutor.executeFlush(flushOp, ctx);
    }, MessageManager.FLUSH_DELAY_MS);
  }

  /**
   * Cancel any pending scheduled flush
   */
  private cancelScheduledFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Force flush any pending content
   */
  async flush(): Promise<void> {
    this.cancelScheduledFlush();
    const flushOp = createFlushOp(this.sessionId, 'explicit');
    await this.contentExecutor.executeFlush(flushOp, this.getExecutorContext());
  }

  /**
   * Get the executor context
   */
  private getExecutorContext(): ExecutorContext {
    return {
      sessionId: this.sessionId,
      threadId: this.threadId,
      platform: this.platform,
      postTracker: this.postTracker,
      contentBreaker: this.contentBreaker,
    };
  }

  /**
   * Update worktree info (e.g., after !cd command)
   */
  setWorktreeInfo(path: string, branch: string): void {
    this.worktreePath = path;
    this.worktreeBranch = branch;
  }

  /**
   * Clear worktree info
   */
  clearWorktreeInfo(): void {
    this.worktreePath = undefined;
    this.worktreeBranch = undefined;
  }

  // ---------------------------------------------------------------------------
  // Delegation to executors
  // ---------------------------------------------------------------------------

  /**
   * Handle a question answer reaction
   */
  async handleQuestionAnswer(postId: string, optionIndex: number): Promise<boolean> {
    return this.interactiveExecutor.handleQuestionAnswer(postId, optionIndex, this.getExecutorContext());
  }

  /**
   * Handle an approval response reaction
   */
  async handleApprovalResponse(postId: string, approved: boolean): Promise<boolean> {
    return this.interactiveExecutor.handleApprovalResponse(postId, approved, this.getExecutorContext());
  }

  /**
   * Handle a subagent toggle reaction
   */
  async handleSubagentToggle(postId: string, action: 'added' | 'removed'): Promise<boolean> {
    return this.subagentExecutor.handleToggleReaction(postId, action, this.getExecutorContext());
  }

  /**
   * Handle a task list toggle reaction
   */
  async handleTaskListToggle(postId: string, _action: 'added' | 'removed'): Promise<boolean> {
    // Check if this is the task list post
    const state = this.taskListExecutor.getState();
    if (!state.tasksPostId || state.tasksPostId !== postId) {
      return false;
    }
    await this.taskListExecutor.toggleMinimize(this.getExecutorContext());
    return true;
  }

  /**
   * Check if there are pending questions
   */
  hasPendingQuestions(): boolean {
    return this.interactiveExecutor.hasPendingQuestions();
  }

  /**
   * Check if there is a pending approval
   */
  hasPendingApproval(): boolean {
    return this.interactiveExecutor.hasPendingApproval();
  }

  /**
   * Get pending approval info
   */
  getPendingApproval(): { postId: string; type: string; toolUseId: string } | null {
    return this.interactiveExecutor.getPendingApproval();
  }

  /**
   * Get pending question set (full data including questions)
   */
  getPendingQuestionSet(): PendingQuestionSet | null {
    const state = this.interactiveExecutor.getState();
    return state.pendingQuestionSet ?? null;
  }

  /**
   * Clear pending approval state
   */
  clearPendingApproval(): void {
    this.interactiveExecutor.clearPendingApproval();
  }

  /**
   * Clear pending question set state
   */
  clearPendingQuestionSet(): void {
    this.interactiveExecutor.clearPendingQuestionSet();
  }

  /**
   * Advance to the next question in the pending question set
   */
  advanceQuestionIndex(): void {
    this.interactiveExecutor.advanceQuestionIndex();
  }

  // ---------------------------------------------------------------------------
  // Message approval delegation
  // ---------------------------------------------------------------------------

  /**
   * Set pending message approval state.
   * Called when an unauthorized user sends a message that needs approval.
   */
  setPendingMessageApproval(approval: PendingMessageApproval): void {
    this.interactiveExecutor.setPendingMessageApproval(approval);
  }

  /**
   * Get pending message approval state.
   */
  getPendingMessageApproval(): PendingMessageApproval | null {
    return this.interactiveExecutor.getPendingMessageApproval();
  }

  /**
   * Check if there's a pending message approval.
   */
  hasPendingMessageApproval(): boolean {
    return this.interactiveExecutor.hasPendingMessageApproval();
  }

  /**
   * Clear pending message approval state.
   */
  clearPendingMessageApproval(): void {
    this.interactiveExecutor.clearPendingMessageApproval();
  }

  /**
   * Handle a message approval reaction.
   * Returns true if the reaction was handled, false otherwise.
   */
  async handleMessageApprovalResponse(
    postId: string,
    decision: MessageApprovalDecision,
    approver: string
  ): Promise<boolean> {
    return this.interactiveExecutor.handleMessageApprovalResponse(
      postId,
      decision,
      approver,
      this.getExecutorContext()
    );
  }

  // ---------------------------------------------------------------------------
  // Context prompt delegation
  // ---------------------------------------------------------------------------

  /**
   * Set pending context prompt state.
   * Called when prompting user for thread context inclusion.
   */
  setPendingContextPrompt(prompt: PendingContextPrompt): void {
    this.interactiveExecutor.setPendingContextPrompt(prompt);
  }

  /**
   * Get pending context prompt state.
   */
  getPendingContextPrompt(): PendingContextPrompt | null {
    return this.interactiveExecutor.getPendingContextPrompt();
  }

  /**
   * Check if there's a pending context prompt.
   */
  hasPendingContextPrompt(): boolean {
    return this.interactiveExecutor.hasPendingContextPrompt();
  }

  /**
   * Clear pending context prompt state.
   */
  clearPendingContextPrompt(): void {
    this.interactiveExecutor.clearPendingContextPrompt();
  }

  /**
   * Handle a context prompt response reaction.
   * Returns true if the reaction was handled, false otherwise.
   *
   * @param postId - The post ID the reaction was on
   * @param selection - The context selection (number of messages, 0 for skip, or 'timeout')
   * @param username - Username of the responder
   */
  async handleContextPromptResponse(
    postId: string,
    selection: ContextPromptSelection,
    username: string
  ): Promise<boolean> {
    return this.interactiveExecutor.handleContextPromptResponse(
      postId,
      selection,
      username,
      this.getExecutorContext()
    );
  }

  /**
   * Get the current post ID being updated
   */
  getCurrentPostId(): string | null {
    return this.contentExecutor.getState().currentPostId;
  }

  /**
   * Reset content post state to start next content in a new post.
   * Called after compaction or before sending follow-up messages.
   */
  resetContentPost(): void {
    this.contentExecutor.resetContentPost();
  }

  /**
   * Get the current post content
   */
  getCurrentPostContent(): string {
    return this.contentExecutor.getState().currentPostContent;
  }

  /**
   * Bump task list to bottom
   */
  async bumpTaskList(): Promise<void> {
    await this.taskListExecutor.bumpToBottom(this.getExecutorContext());
  }

  /**
   * Get task list state for persistence
   */
  getTaskListState(): {
    postId: string | null;
    content: string | null;
    isMinimized: boolean;
    isCompleted: boolean;
  } {
    const state = this.taskListExecutor.getState();
    return {
      postId: state.tasksPostId,
      content: state.lastTasksContent,
      isMinimized: state.tasksMinimized,
      isCompleted: state.tasksCompleted,
    };
  }

  /**
   * Hydrate task list state from persisted session data.
   * Called during session resume to restore task list state.
   */
  hydrateTaskListState(persisted: {
    tasksPostId?: string | null;
    lastTasksContent?: string | null;
    tasksCompleted?: boolean;
    tasksMinimized?: boolean;
  }): void {
    this.taskListExecutor.hydrateState(persisted);
  }

  /**
   * Hydrate interactive state from persisted session data.
   * Called during session resume to restore pending questions/approvals.
   */
  hydrateInteractiveState(persisted: {
    pendingQuestionSet?: {
      toolUseId: string;
      currentIndex: number;
      currentPostId: string | null;
      questions: Array<{
        header: string;
        question: string;
        options: Array<{ label: string; description: string }>;
        answer: string | null;
      }>;
    } | null;
    pendingApproval?: {
      postId: string;
      type: 'plan' | 'action';
      toolUseId: string;
    } | null;
    pendingMessageApproval?: PendingMessageApproval | null;
    pendingContextPrompt?: PendingContextPrompt | null;
  }): void {
    this.interactiveExecutor.hydrateState(persisted);
  }

  /**
   * Post an info message
   */
  async postInfo(message: string): Promise<PlatformPost | undefined> {
    return this.systemExecutor.postInfo(message, this.getExecutorContext());
  }

  /**
   * Post a warning message
   */
  async postWarning(message: string): Promise<PlatformPost | undefined> {
    return this.systemExecutor.postWarning(message, this.getExecutorContext());
  }

  /**
   * Post an error message
   */
  async postError(message: string): Promise<PlatformPost | undefined> {
    return this.systemExecutor.postError(message, this.getExecutorContext());
  }

  /**
   * Post a success message
   */
  async postSuccess(message: string): Promise<PlatformPost | undefined> {
    return this.systemExecutor.postSuccess(message, this.getExecutorContext());
  }

  // ---------------------------------------------------------------------------
  // User message handling
  // ---------------------------------------------------------------------------

  /**
   * Prepare the message manager for a new user message.
   * This flushes any pending content, resets the content post state,
   * and bumps the task list to below the user's message.
   *
   * Call this before sending a follow-up message to Claude.
   */
  async prepareForUserMessage(): Promise<void> {
    const logger = log.forSession(this.sessionId);
    logger.debug('Preparing for new user message');

    // Flush any pending content before starting new message
    // This ensures code blocks and other structures are properly closed
    await this.flush();

    // Reset current post so Claude's response starts in a new message
    this.resetContentPost();

    // Bump task list below the user's message
    await this.bumpTaskList();
  }

  // ---------------------------------------------------------------------------
  // Unified reaction routing
  // ---------------------------------------------------------------------------

  /**
   * Handle a reaction event on any post.
   * Routes to the appropriate executor based on what's pending.
   * This is the single entry point for all reaction handling.
   *
   * @param postId - The post ID the reaction was on
   * @param emoji - The emoji name that was used
   * @param user - Username of the user who reacted
   * @param action - Whether the reaction was 'added' or 'removed'
   * @returns true if the reaction was handled, false otherwise
   */
  async handleReaction(
    postId: string,
    emoji: string,
    user: string,
    action: 'added' | 'removed'
  ): Promise<boolean> {
    const logger = log.forSession(this.sessionId);
    const ctx = this.getExecutorContext();

    logger.debug(`Routing reaction: postId=${postId}, emoji=${emoji}, user=${user}, action=${action}`);

    // Try interactive executor first (questions, approvals, message approvals, context prompts)
    if (await this.interactiveExecutor.handleReaction(postId, emoji, user, action, ctx)) {
      logger.debug('Reaction handled by InteractiveExecutor');
      return true;
    }

    // Try task list executor (minimize toggle)
    if (await this.taskListExecutor.handleReaction(postId, emoji, action, ctx)) {
      logger.debug('Reaction handled by TaskListExecutor');
      return true;
    }

    // Try subagent executor (minimize toggle)
    if (await this.subagentExecutor.handleReaction(postId, emoji, action, ctx)) {
      logger.debug('Reaction handled by SubagentExecutor');
      return true;
    }

    logger.debug('Reaction not handled by any executor');
    return false;
  }

  /**
   * Reset all state (for session restart)
   */
  reset(): void {
    this.cancelScheduledFlush();
    this.toolStartTimes.clear();
    this.contentExecutor.reset();
    this.taskListExecutor.reset();
    this.interactiveExecutor.reset();
    this.subagentExecutor.reset();
    this.systemExecutor.reset();
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.cancelScheduledFlush();
    this.reset();
  }
}
