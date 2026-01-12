/**
 * Message Manager - Orchestrates the operation pipeline
 *
 * Handles Claude events by transforming them to operations and
 * dispatching to appropriate executors.
 *
 * Uses an EventEmitter pattern for communicating with Session/Lifecycle layers:
 * - Subscribe to events via `messageManager.events.on('event-name', handler)`
 * - No more callback parameters in the constructor
 * - Easy to add new event types by updating MessageManagerEventMap
 */

import type { PlatformClient, PlatformPost, PlatformFile } from '../platform/index.js';
import type { PendingQuestionSet, Session } from '../session/types.js';
import type { ClaudeEvent, ContentBlock } from '../claude/cli.js';
import { transformEvent, type TransformContext } from './transformer.js';
import {
  ContentExecutor,
  TaskListExecutor,
  QuestionApprovalExecutor,
  MessageApprovalExecutor,
  PromptExecutor,
  BugReportExecutor,
  SubagentExecutor,
  SystemExecutor,
} from './executors/index.js';
import type {
  MessageApprovalDecision,
} from './executors/message-approval.js';
import type {
  ContextPromptSelection,
} from './executors/prompt.js';
import type {
  ExecutorContext,
  RegisterPostCallback,
  UpdateLastMessageCallback,
  PendingMessageApproval,
  PendingContextPrompt,
  PendingExistingWorktreePrompt,
  PendingUpdatePrompt,
  PendingBugReport,
} from './executors/types.js';
import { PostTracker } from './post-tracker.js';
import { DefaultContentBreaker } from './content-breaker.js';
import type {
  MessageOperation,
  AppendContentOp,
  FlushOp,
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
import { TypedEventEmitter, createMessageManagerEvents } from './message-manager-events.js';

const log = createLogger('msg-mgr');

/**
 * Callback to build message content (handles image attachments)
 */
export type BuildMessageContentCallback = (
  text: string,
  platform: PlatformClient,
  files?: PlatformFile[]
) => Promise<string | ContentBlock[]>;

/**
 * Callback to start typing indicator
 */
export type StartTypingCallback = () => void;

/**
 * Callback to emit session update events
 */
export type EmitSessionUpdateCallback = (updates: Record<string, unknown>) => void;

/**
 * Options for creating a MessageManager
 *
 * Note: Event-based callbacks have been removed. Instead, subscribe to
 * events on `messageManager.events` after creating the MessageManager.
 *
 * @example
 * const manager = new MessageManager({ platform, postTracker, ... });
 * manager.events.on('question:complete', ({ toolUseId, answers }) => { ... });
 * manager.events.on('approval:complete', ({ toolUseId, approved }) => { ... });
 */
export interface MessageManagerOptions {
  /** The session this MessageManager belongs to (for direct access to Claude CLI, logger, etc.) */
  session: Session;
  platform: PlatformClient;
  postTracker: PostTracker;
  threadId: string;
  sessionId: string;
  worktreePath?: string;
  worktreeBranch?: string;
  registerPost: RegisterPostCallback;
  updateLastMessage: UpdateLastMessageCallback;
  onBumpTaskList?: () => Promise<void>;
  /** Callback to build message content (handles image attachments) */
  buildMessageContent?: BuildMessageContentCallback;
  /** Callback to start typing indicator */
  startTyping?: StartTypingCallback;
  /** Callback to emit session update events */
  emitSessionUpdate?: EmitSessionUpdateCallback;
}

/**
 * Message Manager - Orchestrates the operation pipeline
 *
 * Transforms Claude CLI events into operations and dispatches them
 * to the appropriate executors for rendering to the chat platform.
 *
 * Uses TypedEventEmitter for communication with Session/Lifecycle layers.
 * Subscribe to events via `messageManager.events.on('event-name', handler)`.
 */
export class MessageManager {
  private platform: PlatformClient;
  private postTracker: PostTracker;
  private contentBreaker: DefaultContentBreaker;

  // Session reference for direct access to Claude CLI, logger, etc.
  private session: Session;

  // Executors
  private contentExecutor: ContentExecutor;
  private taskListExecutor: TaskListExecutor;
  private questionApprovalExecutor: QuestionApprovalExecutor;
  private messageApprovalExecutor: MessageApprovalExecutor;
  private promptExecutor: PromptExecutor;
  private bugReportExecutor: BugReportExecutor;
  private subagentExecutor: SubagentExecutor;
  private systemExecutor: SystemExecutor;

  // Context for transformation
  private sessionId: string;
  private threadId: string;
  private worktreePath?: string;
  private worktreeBranch?: string;

  // Callbacks (only structural, not event-based)
  private registerPost: RegisterPostCallback;
  private updateLastMessage: UpdateLastMessageCallback;
  private buildMessageContentCallback?: BuildMessageContentCallback;
  private startTypingCallback?: StartTypingCallback;
  private emitSessionUpdateCallback?: EmitSessionUpdateCallback;

  // Tool start times for elapsed time calculation
  private toolStartTimes: Map<string, number> = new Map();

  // Flush scheduling
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private static FLUSH_DELAY_MS = 500;

  /**
   * Event emitter for MessageManager events.
   *
   * Subscribe to events to receive notifications when interactive operations complete:
   *
   * @example
   * manager.events.on('question:complete', ({ toolUseId, answers }) => {
   *   // Send answers back to Claude
   *   session.claude.sendMessage(JSON.stringify(answers));
   * });
   *
   * manager.events.on('approval:complete', ({ toolUseId, approved }) => {
   *   // Handle approval/denial
   *   session.claude.sendMessage(approved ? 'approved' : 'denied');
   * });
   *
   * manager.events.on('message-approval:complete', ({ decision, fromUser, originalMessage }) => {
   *   // Handle message approval from unauthorized user
   * });
   *
   * manager.events.on('context-prompt:complete', ({ selection, queuedPrompt }) => {
   *   // Handle context selection for mid-thread session start
   * });
   *
   * manager.events.on('status:update', (statusInfo) => {
   *   // Update session header with status info
   * });
   */
  public readonly events: TypedEventEmitter;

  constructor(options: MessageManagerOptions) {
    this.session = options.session;
    this.platform = options.platform;
    this.postTracker = options.postTracker;
    this.sessionId = options.sessionId;
    this.threadId = options.threadId;
    this.worktreePath = options.worktreePath;
    this.worktreeBranch = options.worktreeBranch;
    this.registerPost = options.registerPost;
    this.updateLastMessage = options.updateLastMessage;
    this.buildMessageContentCallback = options.buildMessageContent;
    this.startTypingCallback = options.startTyping;
    this.emitSessionUpdateCallback = options.emitSessionUpdate;

    // Create event emitter
    this.events = createMessageManagerEvents();

    // Create content breaker
    this.contentBreaker = new DefaultContentBreaker();

    // Create executors - pass the events emitter for callbacks
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

    this.questionApprovalExecutor = new QuestionApprovalExecutor({
      registerPost: options.registerPost,
      updateLastMessage: options.updateLastMessage,
      events: this.events,
    });

    this.messageApprovalExecutor = new MessageApprovalExecutor({
      registerPost: options.registerPost,
      updateLastMessage: options.updateLastMessage,
      events: this.events,
    });

    this.promptExecutor = new PromptExecutor({
      registerPost: options.registerPost,
      updateLastMessage: options.updateLastMessage,
      events: this.events,
    });

    this.bugReportExecutor = new BugReportExecutor({
      registerPost: options.registerPost,
      updateLastMessage: options.updateLastMessage,
      events: this.events,
    });

    this.subagentExecutor = new SubagentExecutor({
      registerPost: options.registerPost,
      updateLastMessage: options.updateLastMessage,
      onBumpTaskList: options.onBumpTaskList,
    });

    this.systemExecutor = new SystemExecutor({
      registerPost: options.registerPost,
      updateLastMessage: options.updateLastMessage,
      events: this.events,
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
      } else if (isQuestionOp(op) || isApprovalOp(op)) {
        await this.questionApprovalExecutor.execute(op, ctx);
      } else if (isSystemMessageOp(op) || isStatusUpdateOp(op) || isLifecycleOp(op)) {
        await this.systemExecutor.execute(op, ctx);
      } else if (isSubagentOp(op)) {
        await this.subagentExecutor.execute(op, ctx);
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
    return this.questionApprovalExecutor.handleQuestionAnswer(postId, optionIndex, this.getExecutorContext());
  }

  /**
   * Handle an approval response reaction
   */
  async handleApprovalResponse(postId: string, approved: boolean): Promise<boolean> {
    return this.questionApprovalExecutor.handleApprovalResponse(postId, approved, this.getExecutorContext());
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
    return this.questionApprovalExecutor.hasPendingQuestions();
  }

  /**
   * Check if there is a pending approval
   */
  hasPendingApproval(): boolean {
    return this.questionApprovalExecutor.hasPendingApproval();
  }

  /**
   * Get pending approval info
   */
  getPendingApproval(): { postId: string; type: string; toolUseId: string } | null {
    return this.questionApprovalExecutor.getPendingApproval();
  }

  /**
   * Get pending question set (full data including questions)
   */
  getPendingQuestionSet(): PendingQuestionSet | null {
    const state = this.questionApprovalExecutor.getState();
    return state.pendingQuestionSet ?? null;
  }

  /**
   * Clear pending approval state
   */
  clearPendingApproval(): void {
    this.questionApprovalExecutor.clearPendingApproval();
  }

  /**
   * Clear pending question set state
   */
  clearPendingQuestionSet(): void {
    this.questionApprovalExecutor.clearPendingQuestionSet();
  }

  /**
   * Advance to the next question in the pending question set
   */
  advanceQuestionIndex(): void {
    this.questionApprovalExecutor.advanceQuestionIndex();
  }

  // ---------------------------------------------------------------------------
  // Message approval delegation
  // ---------------------------------------------------------------------------

  /**
   * Set pending message approval state.
   * Called when an unauthorized user sends a message that needs approval.
   */
  setPendingMessageApproval(approval: PendingMessageApproval): void {
    this.messageApprovalExecutor.setPendingMessageApproval(approval);
  }

  /**
   * Get pending message approval state.
   */
  getPendingMessageApproval(): PendingMessageApproval | null {
    return this.messageApprovalExecutor.getPendingMessageApproval();
  }

  /**
   * Check if there's a pending message approval.
   */
  hasPendingMessageApproval(): boolean {
    return this.messageApprovalExecutor.hasPendingMessageApproval();
  }

  /**
   * Clear pending message approval state.
   */
  clearPendingMessageApproval(): void {
    this.messageApprovalExecutor.clearPendingMessageApproval();
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
    return this.messageApprovalExecutor.handleMessageApprovalResponse(
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
    this.promptExecutor.setPendingContextPrompt(prompt);
  }

  /**
   * Get pending context prompt state.
   */
  getPendingContextPrompt(): PendingContextPrompt | null {
    return this.promptExecutor.getPendingContextPrompt();
  }

  /**
   * Check if there's a pending context prompt.
   */
  hasPendingContextPrompt(): boolean {
    return this.promptExecutor.hasPendingContextPrompt();
  }

  /**
   * Clear pending context prompt state.
   */
  clearPendingContextPrompt(): void {
    this.promptExecutor.clearPendingContextPrompt();
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
    return this.promptExecutor.handleContextPromptResponse(
      postId,
      selection,
      username,
      this.getExecutorContext()
    );
  }

  // ---------------------------------------------------------------------------
  // Existing worktree prompt delegation
  // ---------------------------------------------------------------------------

  /**
   * Set pending existing worktree prompt state.
   * Called when an existing worktree is found and user must decide to join or skip.
   */
  setPendingExistingWorktreePrompt(prompt: PendingExistingWorktreePrompt): void {
    this.promptExecutor.setPendingExistingWorktreePrompt(prompt);
  }

  /**
   * Get pending existing worktree prompt state.
   */
  getPendingExistingWorktreePrompt(): PendingExistingWorktreePrompt | null {
    return this.promptExecutor.getPendingExistingWorktreePrompt();
  }

  /**
   * Check if there's a pending existing worktree prompt.
   */
  hasPendingExistingWorktreePrompt(): boolean {
    return this.promptExecutor.hasPendingExistingWorktreePrompt();
  }

  /**
   * Clear pending existing worktree prompt state.
   */
  clearPendingExistingWorktreePrompt(): void {
    this.promptExecutor.clearPendingExistingWorktreePrompt();
  }

  // ---------------------------------------------------------------------------
  // Update prompt delegation
  // ---------------------------------------------------------------------------

  /**
   * Set pending update prompt state.
   * Called when prompting user about a version update.
   */
  setPendingUpdatePrompt(prompt: PendingUpdatePrompt): void {
    this.promptExecutor.setPendingUpdatePrompt(prompt);
  }

  /**
   * Get pending update prompt state.
   */
  getPendingUpdatePrompt(): PendingUpdatePrompt | null {
    return this.promptExecutor.getPendingUpdatePrompt();
  }

  /**
   * Check if there's a pending update prompt.
   */
  hasPendingUpdatePrompt(): boolean {
    return this.promptExecutor.hasPendingUpdatePrompt();
  }

  /**
   * Clear pending update prompt state.
   */
  clearPendingUpdatePrompt(): void {
    this.promptExecutor.clearPendingUpdatePrompt();
  }

  // ---------------------------------------------------------------------------
  // Bug report delegation
  // ---------------------------------------------------------------------------

  /**
   * Set pending bug report state.
   * Called when a bug report is being reviewed before submission.
   */
  setPendingBugReport(report: PendingBugReport): void {
    this.bugReportExecutor.setPendingBugReport(report);
  }

  /**
   * Get pending bug report state.
   */
  getPendingBugReport(): PendingBugReport | null {
    return this.bugReportExecutor.getPendingBugReport();
  }

  /**
   * Check if there's a pending bug report.
   */
  hasPendingBugReport(): boolean {
    return this.bugReportExecutor.hasPendingBugReport();
  }

  /**
   * Clear pending bug report state.
   */
  clearPendingBugReport(): void {
    this.bugReportExecutor.clearPendingBugReport();
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
    pendingExistingWorktreePrompt?: PendingExistingWorktreePrompt | null;
    pendingUpdatePrompt?: PendingUpdatePrompt | null;
    pendingBugReport?: PendingBugReport | null;
  }): void {
    // Hydrate each executor with its relevant state
    this.questionApprovalExecutor.hydrateState({
      pendingQuestionSet: persisted.pendingQuestionSet,
      pendingApproval: persisted.pendingApproval,
    });

    this.messageApprovalExecutor.hydrateState({
      pendingMessageApproval: persisted.pendingMessageApproval,
    });

    this.promptExecutor.hydrateState({
      pendingContextPrompt: persisted.pendingContextPrompt,
      pendingExistingWorktreePrompt: persisted.pendingExistingWorktreePrompt,
      pendingUpdatePrompt: persisted.pendingUpdatePrompt,
    });

    this.bugReportExecutor.hydrateState({
      pendingBugReport: persisted.pendingBugReport,
    });
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
   * Post an error message with bug reaction for quick error reporting.
   * Matches the behavior of post-helpers/postError().
   */
  async postError(message: string, addBugReaction = true): Promise<PlatformPost | undefined> {
    const post = await this.systemExecutor.postError(message, this.getExecutorContext());

    // Add bug reaction for quick error reporting (matches post-helpers behavior)
    if (post && addBugReaction) {
      try {
        const { BUG_REPORT_EMOJI } = await import('../utils/emoji.js');
        await this.platform.addReaction(post.id, BUG_REPORT_EMOJI);
        // Store error context for potential bug report
        this.session.lastError = {
          postId: post.id,
          message,
          timestamp: new Date(),
        };
      } catch {
        // Ignore if reaction fails - not critical
      }
    }

    return post;
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

  /**
   * Handle a user message.
   * This is the main entry point for user messages in follow-up mode.
   *
   * The MessageManager handles:
   * - Logging the user message
   * - Preparing for the new message (flush, reset, bump tasks)
   * - Building the message content (with images if provided)
   * - Sending to Claude
   * - Starting typing indicator
   * - Updating activity time
   *
   * @param message - The user's message text
   * @param files - Optional attached files (images)
   * @param username - Username of the sender
   * @param displayName - Display name of the sender (optional)
   * @returns true if message was sent, false if Claude is not running
   */
  async handleUserMessage(
    message: string,
    files?: PlatformFile[],
    username?: string,
    displayName?: string
  ): Promise<boolean> {
    const logger = log.forSession(this.sessionId);

    // Check if Claude is running
    if (!this.session.claude.isRunning()) {
      logger.debug('Claude not running, ignoring user message');
      return false;
    }

    // Log the user message
    this.session.threadLogger?.logUserMessage(
      username || this.session.startedBy,
      message,
      displayName,
      files && files.length > 0
    );

    // Prepare for the new message (flush, reset, bump tasks)
    await this.prepareForUserMessage();

    // Build message content (with images if provided)
    let content: string | ContentBlock[] = message;
    if (this.buildMessageContentCallback) {
      content = await this.buildMessageContentCallback(message, this.platform, files);
    }

    // Send to Claude
    this.session.claude.sendMessage(content);

    // Update activity time
    this.session.lastActivityAt = new Date();

    // Mark as processing
    this.session.isProcessing = true;
    this.emitSessionUpdateCallback?.({ status: 'active', isTyping: true });

    // Start typing indicator
    this.startTypingCallback?.();

    logger.debug('User message sent to Claude');
    return true;
  }

  /**
   * Get the session reference (for advanced use cases).
   */
  getSession(): Session {
    return this.session;
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

    // Try question/approval executor first
    if (await this.questionApprovalExecutor.handleReaction(postId, emoji, user, action, ctx)) {
      logger.debug('Reaction handled by QuestionApprovalExecutor');
      return true;
    }

    // Try message approval executor
    if (await this.messageApprovalExecutor.handleReaction(postId, emoji, user, action, ctx)) {
      logger.debug('Reaction handled by MessageApprovalExecutor');
      return true;
    }

    // Try prompt executor (context, worktree, update prompts)
    if (await this.promptExecutor.handleReaction(postId, emoji, user, action, ctx)) {
      logger.debug('Reaction handled by PromptExecutor');
      return true;
    }

    // Try bug report executor
    if (await this.bugReportExecutor.handleReaction(postId, emoji, user, action, ctx)) {
      logger.debug('Reaction handled by BugReportExecutor');
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
    this.questionApprovalExecutor.reset();
    this.messageApprovalExecutor.reset();
    this.promptExecutor.reset();
    this.bugReportExecutor.reset();
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
