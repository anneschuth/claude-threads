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
  Executor,
  ExecutionResult,
  RegisterPostCallback,
  UpdateLastMessageCallback,
} from './types.js';

// Executors
export { ContentExecutor } from './content.js';
export { TaskListExecutor } from './task-list.js';
export { InteractiveExecutor } from './interactive.js';
export type { MessageApprovalDecision, MessageApprovalCallback } from './interactive.js';
export { SubagentExecutor } from './subagent.js';
export { SystemExecutor } from './system.js';
