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
  InteractiveState,
  SubagentState,
  PendingMessageApproval,
  PendingContextPrompt,
  ContextPromptFile,
  Executor,
  ExecutionResult,
  RegisterPostCallback,
  UpdateLastMessageCallback,
} from './types.js';

// Executors
export { ContentExecutor } from './content.js';
export { TaskListExecutor } from './task-list.js';
export { InteractiveExecutor } from './interactive.js';
export type { MessageApprovalDecision, MessageApprovalCallback, ContextPromptSelection, ContextPromptCallback } from './interactive.js';
export { SubagentExecutor } from './subagent.js';
export { SystemExecutor } from './system.js';
