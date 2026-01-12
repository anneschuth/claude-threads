/**
 * Session module public exports
 *
 * Provides SessionManager for managing multiple concurrent Claude Code sessions.
 * SessionRegistry provides pure session lookup without business logic.
 */

export { SessionManager } from './manager.js';
export { SessionRegistry } from './registry.js';
export type {
  Session,
  SessionTimers,
  SessionLifecycle,
  SessionLifecycleState,
  PendingApproval,
  PendingQuestionSet,
  PendingExistingWorktreePrompt,
  PendingWorktreeFailurePrompt,
} from './types.js';
export {
  createSessionTimers,
  clearAllTimers,
  isTyping,
  createSessionLifecycle,
  createResumedLifecycle,
  isSessionActive,
  canInterruptSession,
  isSessionRestarting,
  isSessionCancelled,
  isSessionPaused,
  wasSessionResumed,
  transitionTo,
  markClaudeResponded,
} from './types.js';
export type { PendingContextPrompt } from '../operations/context-prompt/index.js';

// Re-export PendingMessageApproval from executors (now managed by MessageManager)
export type { PendingMessageApproval } from '../operations/executors/index.js';

// Pending prompts utilities (reusable for displaying pending states)
export type { PendingPrompt } from '../operations/sticky-message/index.js';
export { getPendingPrompts, formatPendingPrompts } from '../operations/sticky-message/index.js';

// Session metadata suggestion utilities (re-exported from operations/suggestions)
export { suggestSessionMetadata } from '../operations/suggestions/title.js';
export type { SessionMetadata, TitleContext } from '../operations/suggestions/title.js';
export { suggestSessionTags, VALID_TAGS, isValidTag } from '../operations/suggestions/tag.js';
export type { SessionTag } from '../operations/suggestions/tag.js';
