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
  PendingWorktreeFailurePrompt,
} from './types.js';
export type { PendingContextPrompt } from './context-prompt.js';

// Pending prompts utilities (reusable for displaying pending states)
export type { PendingPrompt } from './sticky-message.js';
export { getPendingPrompts, formatPendingPrompts } from './sticky-message.js';

// Session metadata suggestion utilities (quickQuery-based)
export { suggestSessionMetadata } from './title-suggest.js';
export type { SessionMetadata } from './title-suggest.js';
export { suggestSessionTags, VALID_TAGS, isValidTag } from './tag-suggest.js';
export type { SessionTag } from './tag-suggest.js';
