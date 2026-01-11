/**
 * Executor Types - Shared interfaces for operation executors
 *
 * Executors are responsible for actually performing operations
 * on the chat platform (posting messages, updating posts, etc.).
 */

import type { PlatformClient, PlatformPost } from '../../platform/index.js';
import type { PostTracker, RegisterPostOptions } from '../post-tracker.js';
import type { ContentBreaker } from '../content-breaker.js';
import type { MessageOperation } from '../types.js';

// ---------------------------------------------------------------------------
// Executor Context
// ---------------------------------------------------------------------------

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
  /** Post tracker for registering posts */
  postTracker: PostTracker;
  /** Content breaker for message splitting */
  contentBreaker: ContentBreaker;
  /** Debug mode */
  debug?: boolean;
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
 * State managed by the interactive executor.
 */
export interface InteractiveState {
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
// Executor Interface
// ---------------------------------------------------------------------------

/**
 * Generic executor interface.
 */
export interface Executor<T extends MessageOperation> {
  /**
   * Execute an operation.
   *
   * @param operation - The operation to execute
   * @param ctx - Executor context
   * @returns Promise that resolves when execution is complete
   */
  execute(operation: T, ctx: ExecutorContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Execution Result
// ---------------------------------------------------------------------------

/**
 * Result of executing an operation.
 */
export interface ExecutionResult {
  /** Whether execution succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Post ID created or updated (if applicable) */
  postId?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
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
