/**
 * Operations module - Message operations and utilities
 *
 * This module provides the building blocks for the new message pipeline:
 * - ContentBreaker: Logical message breaking detection
 * - PostTracker: Typed post registry
 * - ToolFormatterRegistry: Plugin system for tool formatting
 */

// Content breaking utilities
export {
  DefaultContentBreaker,
  defaultContentBreaker,
  getCodeBlockState,
  findLogicalBreakpoint,
  shouldFlushEarly,
  endsAtBreakpoint,
  SOFT_BREAK_THRESHOLD,
  MIN_BREAK_THRESHOLD,
  MAX_LINES_BEFORE_BREAK,
} from './content-breaker.js';

export type {
  ContentBreaker,
  BreakpointType,
  CodeBlockInfo,
  BreakpointResult,
} from './content-breaker.js';

// Post tracking
export {
  PostTracker,
  defaultPostTracker,
} from './post-tracker.js';

export type {
  PostType,
  InteractionType,
  PostInfo,
  RegisterPostOptions,
  PostTrackerInterface,
} from './post-tracker.js';

// Tool formatting
export {
  ToolFormatterRegistry,
  toolFormatterRegistry,
  shortenPath,
  parseMcpToolName,
  formatToolUse,
  formatToolForPermission,
} from './tool-formatters/index.js';

export type {
  ToolFormatOptions,
  ToolFormatResult,
  ToolInput,
  ToolFormatter,
  ToolFormatterRegistryInterface,
  WorktreeContext,
  FormatOptions,
} from './tool-formatters/index.js';

// Operation types
export type {
  BaseOperation,
  AppendContentOp,
  FlushOp,
  TaskItem,
  TaskListOp,
  QuestionOption,
  Question,
  QuestionOp,
  ApprovalOp,
  SystemMessageLevel,
  SystemMessageOp,
  SubagentOp,
  StatusUpdateOp,
  LifecycleOp,
  MessageOperation,
} from './types.js';

export {
  isContentOp,
  isFlushOp,
  isTaskListOp,
  isQuestionOp,
  isApprovalOp,
  isSystemMessageOp,
  isSubagentOp,
  isStatusUpdateOp,
  isLifecycleOp,
  createAppendContentOp,
  createFlushOp,
  createTaskListOp,
  createQuestionOp,
  createApprovalOp,
  createSystemMessageOp,
  createSubagentOp,
  createStatusUpdateOp,
  createLifecycleOp,
} from './types.js';

// Event transformer
export { transformEvent } from './transformer.js';
export type { TransformContext } from './transformer.js';

// Message manager
export { MessageManager } from './message-manager.js';
export type {
  MessageManagerOptions,
  QuestionCompleteCallback,
  ApprovalCompleteCallback,
  StatusUpdateCallback,
  LifecycleCallback,
} from './message-manager.js';

// Executors
export {
  ContentExecutor,
  TaskListExecutor,
  InteractiveExecutor,
  SubagentExecutor,
  SystemExecutor,
} from './executors/index.js';

export type {
  ExecutorContext,
  ContentState,
  TaskListState,
  InteractiveState,
  SubagentState,
  Executor,
  ExecutionResult,
  RegisterPostCallback,
  UpdateLastMessageCallback,
} from './executors/index.js';
