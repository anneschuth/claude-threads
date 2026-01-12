/**
 * Executors module - Operation executors for chat platforms
 *
 * Executors are responsible for actually performing operations
 * on the chat platform (posting messages, updating posts, etc.).
 */

// Base class
export { BaseExecutor, type ExecutorOptions } from './base.js';

// Types
export type {
  ExecutorContext,
  ContentState,
  TaskListState,
  QuestionApprovalState,
  MessageApprovalState,
  PromptState,
  BugReportState,
  SubagentState,
  SystemState,
  PendingMessageApproval,
  PendingContextPrompt,
  ContextPromptFile,
  PendingExistingWorktreePrompt,
  PendingUpdatePrompt,
  PendingBugReport,
  RegisterPostCallback,
  UpdateLastMessageCallback,
} from './types.js';

// Executors
export { ContentExecutor, type ContentExecutorOptions } from './content.js';
export { TaskListExecutor } from './task-list.js';
export { SubagentExecutor, type SubagentExecutorOptions } from './subagent.js';
export { SystemExecutor } from './system.js';

// Focused executors for interactive operations
export { QuestionApprovalExecutor } from './question-approval.js';

export { MessageApprovalExecutor } from './message-approval.js';
export type { MessageApprovalDecision } from './message-approval.js';

export { PromptExecutor } from './prompt.js';
export type {
  ContextPromptSelection,
  ExistingWorktreeDecision,
  UpdatePromptDecision,
} from './prompt.js';

export { BugReportExecutor } from './bug-report.js';
export type { BugReportDecision } from './bug-report.js';

export { WorktreePromptExecutor } from './worktree-prompt.js';
export type {
  WorktreePromptState,
  PendingInitialWorktreePrompt,
  WorktreePromptFile,
  QueuedWorktreeData,
  WorktreePromptDecision,
} from './worktree-prompt.js';
// Re-export PendingWorktreeFailurePrompt from worktree-prompt (was in session/types)
export type { PendingWorktreeFailurePrompt } from './worktree-prompt.js';
