/**
 * Session module public exports
 *
 * Provides SessionManager for managing multiple concurrent Claude Code sessions.
 */

export { SessionManager } from './manager.js';
export type {
  Session,
  PendingApproval,
  PendingQuestionSet,
  PendingMessageApproval,
  PendingExistingWorktreePrompt,
} from './types.js';
export type { PendingContextPrompt } from './context-prompt.js';

// Pending prompts utilities (reusable for displaying pending states)
export type { PendingPrompt } from './sticky-message.js';
export { getPendingPrompts, formatPendingPrompts } from './sticky-message.js';

// Sticky thread utilities (for task list and plan approval management)
export {
  bumpTasksToBottom,
  bumpTasksToBottomWithContent,
  bumpPlanApprovalToBottom,
  bumpAllStickyPosts,
  hasActiveStickyPosts,
  hasActiveTasks,
  acquireStickyLock,
  acquireTaskListLock, // Backward compatibility alias
} from './sticky-thread.js';
