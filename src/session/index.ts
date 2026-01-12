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
  PendingExistingWorktreePrompt,
  PendingWorktreeFailurePrompt,
} from './types.js';
export type { PendingContextPrompt } from './context-prompt.js';

// Re-export PendingMessageApproval from executors (now managed by MessageManager)
export type { PendingMessageApproval } from '../operations/executors/index.js';

// Pending prompts utilities (reusable for displaying pending states)
export type { PendingPrompt } from '../operations/sticky-message/index.js';
export { getPendingPrompts, formatPendingPrompts } from '../operations/sticky-message/index.js';

// Session metadata suggestion utilities (quickQuery-based)
export { suggestSessionMetadata } from './title-suggest.js';
export type { SessionMetadata, TitleContext } from './title-suggest.js';
export { suggestSessionTags, VALID_TAGS, isValidTag } from './tag-suggest.js';
export type { SessionTag } from './tag-suggest.js';
