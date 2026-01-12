/**
 * Worktree Prompt Executor - Handles worktree selection prompts
 *
 * Consolidates worktree-related pending state from Session into a single executor.
 * Responsible for:
 * - Initial worktree prompt (branch suggestions at session start)
 * - Worktree failure retry prompt (after creation fails)
 * - Processing user responses via reactions or text input
 */

import { isDenialEmoji, getNumberEmojiIndex } from '../../utils/emoji.js';
import { createLogger } from '../../utils/logger.js';
import { BaseExecutor, type ExecutorOptions } from './base.js';

const log = createLogger('worktree-prompt-executor');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Simplified file reference for worktree prompts.
 */
export interface WorktreePromptFile {
  id: string;
  name: string;
}

/**
 * Pending initial worktree prompt state (branch suggestions at session start).
 */
export interface PendingInitialWorktreePrompt {
  postId: string;
  suggestions: string[];
}

/**
 * Pending worktree failure prompt state (after creation fails).
 */
export interface PendingWorktreeFailurePrompt {
  postId: string;
  failedBranch: string;
  errorMessage: string;
  username: string;
}

/**
 * Queued data while waiting for worktree prompt response.
 */
export interface QueuedWorktreeData {
  prompt: string;
  files?: WorktreePromptFile[];
  /** Post ID of user's branch response (to exclude from context prompt) */
  responsePostId?: string;
  /** First user message, sent again after mid-session worktree creation */
  firstPrompt?: string;
}

/**
 * Complete state managed by the worktree prompt executor.
 */
export interface WorktreePromptState {
  /** Initial worktree prompt (branch suggestions) */
  pendingInitialPrompt: PendingInitialWorktreePrompt | null;
  /** Failure retry prompt */
  pendingFailurePrompt: PendingWorktreeFailurePrompt | null;
  /** Queued data while waiting for prompt response */
  queuedData: QueuedWorktreeData | null;
  /** Whether worktree prompts are disabled for this session */
  promptDisabled: boolean;
}

/**
 * Decision type for worktree prompt reactions.
 */
export type WorktreePromptDecision =
  | { type: 'branch_selected'; branch: string }
  | { type: 'skip' }
  | { type: 'retry'; branchName: string };

/**
 * Callback for worktree prompt completion.
 */
export type WorktreePromptCallback = (
  decision: WorktreePromptDecision,
  context: {
    queuedPrompt?: string;
    queuedFiles?: WorktreePromptFile[];
    responsePostId?: string;
    failedBranch?: string;
  }
) => Promise<void>;

// ---------------------------------------------------------------------------
// Worktree Prompt Executor
// ---------------------------------------------------------------------------

/**
 * Executor for worktree prompt operations.
 *
 * Consolidates all worktree-related pending state that was previously
 * spread across multiple Session fields.
 */
export class WorktreePromptExecutor extends BaseExecutor<WorktreePromptState> {
  constructor(options: ExecutorOptions) {
    super(options, WorktreePromptExecutor.createInitialState());
  }

  private static createInitialState(): WorktreePromptState {
    return {
      pendingInitialPrompt: null,
      pendingFailurePrompt: null,
      queuedData: null,
      promptDisabled: false,
    };
  }

  protected getInitialState(): WorktreePromptState {
    return WorktreePromptExecutor.createInitialState();
  }

  // ---------------------------------------------------------------------------
  // State Accessors
  // ---------------------------------------------------------------------------

  /**
   * Check if there's any pending worktree prompt (initial or failure).
   */
  hasPendingPrompt(): boolean {
    return this.state.pendingInitialPrompt !== null || this.state.pendingFailurePrompt !== null;
  }

  /**
   * Check if there's a pending initial worktree prompt.
   */
  hasPendingInitialPrompt(): boolean {
    return this.state.pendingInitialPrompt !== null;
  }

  /**
   * Check if there's a pending failure prompt.
   */
  hasPendingFailurePrompt(): boolean {
    return this.state.pendingFailurePrompt !== null;
  }

  /**
   * Get the current pending prompt state.
   */
  getPendingPrompt(): PendingInitialWorktreePrompt | PendingWorktreeFailurePrompt | null {
    return this.state.pendingInitialPrompt || this.state.pendingFailurePrompt;
  }

  /**
   * Get pending initial prompt.
   */
  getPendingInitialPrompt(): PendingInitialWorktreePrompt | null {
    return this.state.pendingInitialPrompt;
  }

  /**
   * Get pending failure prompt.
   */
  getPendingFailurePrompt(): PendingWorktreeFailurePrompt | null {
    return this.state.pendingFailurePrompt;
  }

  /**
   * Get queued data.
   */
  getQueuedData(): QueuedWorktreeData | null {
    return this.state.queuedData;
  }

  /**
   * Check if worktree prompts are disabled.
   */
  isPromptDisabled(): boolean {
    return this.state.promptDisabled;
  }

  /**
   * Get the post ID of the current prompt (for reaction handling).
   */
  getPromptPostId(): string | null {
    return this.state.pendingInitialPrompt?.postId || this.state.pendingFailurePrompt?.postId || null;
  }

  // ---------------------------------------------------------------------------
  // State Mutators
  // ---------------------------------------------------------------------------

  /**
   * Set pending initial worktree prompt.
   */
  setPendingInitialPrompt(prompt: PendingInitialWorktreePrompt): void {
    this.state.pendingInitialPrompt = prompt;
    log.debug(`Set pending initial worktree prompt with ${prompt.suggestions.length} suggestions`);
  }

  /**
   * Set pending failure prompt.
   */
  setPendingFailurePrompt(prompt: PendingWorktreeFailurePrompt): void {
    this.state.pendingFailurePrompt = prompt;
    log.debug(`Set pending failure prompt for branch: ${prompt.failedBranch}`);
  }

  /**
   * Set queued data.
   */
  setQueuedData(data: QueuedWorktreeData): void {
    this.state.queuedData = data;
    log.debug(`Queued prompt: ${data.prompt.substring(0, 50)}...`);
  }

  /**
   * Set response post ID (to exclude from context prompt).
   */
  setResponsePostId(postId: string): void {
    if (this.state.queuedData) {
      this.state.queuedData.responsePostId = postId;
    }
  }

  /**
   * Set first prompt (for mid-session worktree creation).
   */
  setFirstPrompt(prompt: string): void {
    if (this.state.queuedData) {
      this.state.queuedData.firstPrompt = prompt;
    }
  }

  /**
   * Clear all pending prompts.
   */
  clearPendingPrompts(): void {
    this.state.pendingInitialPrompt = null;
    this.state.pendingFailurePrompt = null;
    log.debug('Cleared pending worktree prompts');
  }

  /**
   * Clear queued data.
   */
  clearQueuedData(): void {
    this.state.queuedData = null;
    log.debug('Cleared queued data');
  }

  /**
   * Disable worktree prompts for this session.
   */
  disablePrompts(): void {
    this.state.promptDisabled = true;
    this.clearPendingPrompts();
    log.debug('Worktree prompts disabled');
  }

  // ---------------------------------------------------------------------------
  // Reaction Handling
  // ---------------------------------------------------------------------------

  /**
   * Handle a reaction on a worktree prompt post.
   *
   * @returns true if the reaction was handled, false otherwise
   */
  handleReaction(postId: string, emoji: string, _action: 'added' | 'removed'): boolean {
    // Only handle 'added' actions for prompts
    if (_action !== 'added') return false;

    // Check initial prompt
    if (this.state.pendingInitialPrompt?.postId === postId) {
      return this.handleInitialPromptReaction(emoji);
    }

    // Check failure prompt
    if (this.state.pendingFailurePrompt?.postId === postId) {
      return this.handleFailurePromptReaction(emoji);
    }

    return false;
  }

  /**
   * Handle reaction on initial worktree prompt.
   */
  private handleInitialPromptReaction(emoji: string): boolean {
    const prompt = this.state.pendingInitialPrompt;
    if (!prompt) return false;

    // Handle denial (skip worktree)
    if (isDenialEmoji(emoji)) {
      log.debug('User skipped worktree prompt via reaction');
      this.emitComplete({
        decision: { type: 'skip' },
        queuedData: this.state.queuedData,
      });
      this.clearPendingPrompts();
      return true;
    }

    // Handle number emoji (select suggestion)
    const index = getNumberEmojiIndex(emoji);
    if (index !== null && index < prompt.suggestions.length) {
      const branch = prompt.suggestions[index];
      log.debug(`User selected branch suggestion ${index}: ${branch}`);
      this.emitComplete({
        decision: { type: 'branch_selected', branch },
        queuedData: this.state.queuedData,
      });
      this.clearPendingPrompts();
      return true;
    }

    return false;
  }

  /**
   * Handle reaction on failure prompt.
   */
  private handleFailurePromptReaction(emoji: string): boolean {
    const prompt = this.state.pendingFailurePrompt;
    if (!prompt) return false;

    // Handle denial (skip worktree, continue in main repo)
    if (isDenialEmoji(emoji)) {
      log.debug('User skipped worktree after failure');
      this.emitComplete({
        decision: { type: 'skip' },
        queuedData: this.state.queuedData,
        failedBranch: prompt.failedBranch,
      });
      this.clearPendingPrompts();
      return true;
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Event Emission
  // ---------------------------------------------------------------------------

  /**
   * Emit worktree prompt completion event.
   */
  private emitComplete(data: {
    decision: WorktreePromptDecision;
    queuedData: QueuedWorktreeData | null;
    failedBranch?: string;
  }): void {
    this.events?.emit('worktree-initial-prompt:complete', {
      decision: data.decision,
      queuedPrompt: data.queuedData?.prompt,
      queuedFiles: data.queuedData?.files,
      responsePostId: data.queuedData?.responsePostId,
      failedBranch: data.failedBranch,
    });
  }

  // ---------------------------------------------------------------------------
  // Hydration & Reset
  // ---------------------------------------------------------------------------

  /**
   * Hydrate state from persisted session.
   */
  hydrate(state: Partial<WorktreePromptState>): void {
    if (state.pendingInitialPrompt !== undefined) {
      this.state.pendingInitialPrompt = state.pendingInitialPrompt;
    }
    if (state.pendingFailurePrompt !== undefined) {
      this.state.pendingFailurePrompt = state.pendingFailurePrompt;
    }
    if (state.queuedData !== undefined) {
      this.state.queuedData = state.queuedData;
    }
    if (state.promptDisabled !== undefined) {
      this.state.promptDisabled = state.promptDisabled;
    }
    log.debug('Hydrated worktree prompt state');
  }

  /**
   * Reset executor state.
   */
  override reset(): void {
    this.state = this.getInitialState();
    log.debug('Reset worktree prompt executor');
  }

  /**
   * Get full state for persistence.
   */
  override getState(): WorktreePromptState {
    return { ...this.state };
  }
}
