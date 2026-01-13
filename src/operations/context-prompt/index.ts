/**
 * Context prompt module
 *
 * Handles offering users the option to include previous thread context
 * when a session restarts (via !cd, worktree creation, or mid-thread @mention).
 */

export {
  // Constants
  CONTEXT_PROMPT_TIMEOUT_MS,
  CONTEXT_OPTIONS,

  // Functions
  getThreadContextCount,
  getValidContextOptions,
  postContextPrompt,
  getContextSelectionFromReaction,
  getThreadMessagesForContext,
  formatContextForClaude,
  updateContextPromptPost,

  // High-level handlers
  handleContextPromptTimeout,
  offerContextPrompt,
} from './handler.js';

export type {
  PendingContextPrompt,
  ContextPromptHandler,
} from './handler.js';
