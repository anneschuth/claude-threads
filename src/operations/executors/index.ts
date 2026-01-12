/**
 * Executors module - Operation executors for chat platforms
 *
 * Executors are responsible for actually performing operations
 * on the chat platform (posting messages, updating posts, etc.).
 */

// Types
export type {
  ExecutorContext,
  ContentState,
  TaskListState,
  QuestionApprovalState,
  MessageApprovalState,
  PromptState,
  BugReportState,
  InteractiveState,
  SubagentState,
  PendingMessageApproval,
  PendingContextPrompt,
  ContextPromptFile,
  PendingExistingWorktreePrompt,
  PendingUpdatePrompt,
  PendingBugReport,
  Executor,
  ExecutionResult,
  RegisterPostCallback,
  UpdateLastMessageCallback,
} from './types.js';

// Executors
export { ContentExecutor } from './content.js';
export { TaskListExecutor } from './task-list.js';
export { SubagentExecutor } from './subagent.js';
export { SystemExecutor } from './system.js';

// New focused executors (split from InteractiveExecutor)
export { QuestionApprovalExecutor } from './question-approval.js';
export type {
  QuestionCompleteCallback,
  ApprovalCompleteCallback,
} from './question-approval.js';

export { MessageApprovalExecutor } from './message-approval.js';
export type {
  MessageApprovalDecision,
  MessageApprovalCallback,
} from './message-approval.js';

export { PromptExecutor } from './prompt.js';
export type {
  ContextPromptSelection,
  ContextPromptCallback,
  ExistingWorktreeDecision,
  ExistingWorktreeCallback,
  UpdatePromptDecision,
  UpdatePromptCallback,
} from './prompt.js';

export { BugReportExecutor } from './bug-report.js';
export type {
  BugReportDecision,
  BugReportCallback,
} from './bug-report.js';

// Legacy export for backward compatibility - re-export InteractiveExecutor
// This is deprecated and will be removed in a future version.
// Use the focused executors instead:
// - QuestionApprovalExecutor for questions and approvals
// - MessageApprovalExecutor for message approvals
// - PromptExecutor for context/worktree/update prompts
// - BugReportExecutor for bug reports
export { InteractiveExecutor } from './interactive.js';
