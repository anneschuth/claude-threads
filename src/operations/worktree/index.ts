/**
 * Worktree operations module
 *
 * Git worktree management utilities for handling worktree prompts,
 * creation, switching, and cleanup.
 */

export {
  shouldPromptForWorktree,
  postWorktreePrompt,
  handleBranchSuggestionReaction,
  handleWorktreeBranchResponse,
  handleWorktreeSkip,
  createAndSwitchToWorktree,
  switchToWorktree,
  buildWorktreeListMessage,
  listWorktreesCommand,
  removeWorktreeCommand,
  disableWorktreePrompt,
  cleanupWorktreeCommand,
  cleanupWorktree,
} from './handler.js';

export type { CleanupResult } from './handler.js';
