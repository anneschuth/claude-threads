/**
 * Executor Types - Shared interfaces for operation executors
 *
 * Executors are responsible for actually performing operations
 * on the chat platform (posting messages, updating posts, etc.).
 */

import type { PlatformClient, PlatformPost, PlatformFormatter } from '../../platform/index.js';
import type { PostTracker, RegisterPostOptions, PostType, InteractionType } from '../post-tracker.js';
import type { ContentBreaker } from '../content-breaker.js';
import type { Logger } from '../../utils/logger.js';
import type { ThreadLogger } from '../../persistence/thread-logger.js';

// ---------------------------------------------------------------------------
// Executor Context
// ---------------------------------------------------------------------------

/**
 * Options for creating a tracked post.
 * Compatible with RegisterPostOptions for direct pass-through.
 */
export interface CreatePostOptions {
  type: PostType;
  interactionType?: InteractionType;
  toolUseId?: string;
}

/**
 * Context provided to executors for performing operations.
 */
export interface ExecutorContext {
  /** Session ID */
  sessionId: string;
  /** Thread ID for posting */
  threadId: string;
  /** Platform client for API calls */
  platform: PlatformClient;
  /** Platform formatter (pre-fetched for convenience) */
  formatter: PlatformFormatter;
  /** Session-scoped logger (pre-configured for convenience) */
  logger: Logger;
  /** Post tracker for registering posts */
  postTracker: PostTracker;
  /** Content breaker for message splitting */
  contentBreaker: ContentBreaker;
  /** Thread logger for persisting session events (optional) */
  threadLogger?: ThreadLogger;
  /** Debug mode */
  debug?: boolean;

  /**
   * Create a post and automatically register + track it.
   * Combines platform.createPost + registerPost + updateLastMessage.
   */
  createPost(content: string, options: CreatePostOptions): Promise<PlatformPost>;

  /**
   * Create an interactive post with reactions and automatically register + track it.
   * Combines platform.createInteractivePost + registerPost + updateLastMessage.
   */
  createInteractivePost(
    content: string,
    reactions: string[],
    options: CreatePostOptions
  ): Promise<PlatformPost>;
}

/**
 * State managed by the content executor.
 */
export interface ContentState {
  /** Current post ID (if any) */
  currentPostId: string | null;
  /** Content already posted to currentPostId */
  currentPostContent: string;
  /** Pending content waiting to be flushed */
  pendingContent: string;
  /** Scheduled flush timer */
  updateTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * State managed by the task list executor.
 */
export interface TaskListState {
  /** Current task list post ID (if any) */
  tasksPostId: string | null;
  /** Last task list content (for re-posting on bump) */
  lastTasksContent: string | null;
  /** Whether all tasks are completed */
  tasksCompleted: boolean;
  /** Whether task list is minimized */
  tasksMinimized: boolean;
  /** When the current in_progress task started */
  inProgressTaskStart: number | null;
}

/**
 * Pending message from unauthorized user awaiting approval.
 */
export interface PendingMessageApproval {
  postId: string;
  originalMessage: string;
  fromUser: string;
}

/**
 * Simplified file reference for context prompts.
 */
export interface ContextPromptFile {
  id: string;
  name: string;
}

/**
 * Pending context prompt state for thread context selection.
 * Note: timeoutId is handled by the session layer, not stored here.
 */
export interface PendingContextPrompt {
  postId: string;
  queuedPrompt: string;
  queuedFiles?: ContextPromptFile[];
  threadMessageCount: number;
  createdAt: number;
  availableOptions: number[];
}

/**
 * Pending existing worktree prompt state for worktree selection.
 */
export interface PendingExistingWorktreePrompt {
  postId: string;
  branch: string;
  worktreePath: string;
  username: string;
}

/**
 * Pending update prompt state for version update prompts.
 */
export interface PendingUpdatePrompt {
  postId: string;
}

/**
 * Pending bug report state for bug report submission.
 */
export interface PendingBugReport {
  postId: string;
  title: string;
  body: string;
  userDescription: string;
  imageUrls: string[];
  imageErrors: string[];
  errorContext?: {
    postId: string;
    message: string;
    timestamp: Date;
  };
}

/**
 * State managed by the question approval executor.
 */
export interface QuestionApprovalState {
  /** Pending question set */
  pendingQuestionSet: {
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
  /** Pending approval (plan or action) */
  pendingApproval: {
    postId: string;
    type: 'plan' | 'action';
    toolUseId: string;
  } | null;
}

/**
 * State managed by the message approval executor.
 */
export interface MessageApprovalState {
  /** Pending message approval from unauthorized user */
  pendingMessageApproval: PendingMessageApproval | null;
}

/**
 * State managed by the prompt executor.
 */
export interface PromptState {
  /** Pending context prompt for thread context selection */
  pendingContextPrompt: PendingContextPrompt | null;
  /** Pending existing worktree prompt for worktree selection */
  pendingExistingWorktreePrompt: PendingExistingWorktreePrompt | null;
  /** Pending update prompt for version update prompts */
  pendingUpdatePrompt: PendingUpdatePrompt | null;
}

/**
 * State managed by the bug report executor.
 */
export interface BugReportState {
  /** Pending bug report for bug report submission */
  pendingBugReport: PendingBugReport | null;
}

/**
 * State managed by the system executor.
 */
export interface SystemState {
  /** Track ephemeral posts for potential cleanup */
  ephemeralPosts: Set<string>;
}

/**
 * State managed by the subagent executor.
 */
export interface SubagentState {
  /** Active subagents: toolUseId -> subagent info */
  activeSubagents: Map<string, {
    postId: string;
    startTime: number;
    description: string;
    subagentType: string;
    isMinimized: boolean;
    isComplete: boolean;
    lastUpdateTime: number;
  }>;
  /** Timer for updating elapsed times */
  subagentUpdateTimer: ReturnType<typeof setInterval> | null;
}

// ---------------------------------------------------------------------------
// Callback Types
// ---------------------------------------------------------------------------

/**
 * Callback for registering a post with the tracker.
 */
export type RegisterPostCallback = (
  postId: string,
  options?: RegisterPostOptions
) => void;

/**
 * Callback for updating last message tracking.
 */
export type UpdateLastMessageCallback = (post: PlatformPost) => void;
