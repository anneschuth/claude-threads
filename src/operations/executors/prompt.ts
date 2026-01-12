/**
 * Prompt Executor - Handles system prompts requiring user selection
 *
 * Responsible for:
 * - Context prompt (thread context selection)
 * - Existing worktree prompt (join/skip worktree)
 * - Update prompt (update now/defer)
 * - Processing user responses via reactions
 */

import { isApprovalEmoji, isDenialEmoji, getNumberEmojiIndex } from '../../utils/emoji.js';
import type {
  ExecutorContext,
  PromptState,
  PendingContextPrompt,
  PendingExistingWorktreePrompt,
  PendingUpdatePrompt,
} from './types.js';
import { createLogger } from '../../utils/logger.js';
import { BaseExecutor, type ExecutorOptions } from './base.js';

const log = createLogger('prompt-executor');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Context prompt selection result.
 * - number > 0: Include that many messages as context
 * - 0: No context (user explicitly skipped)
 * - 'timeout': No context (prompt timed out)
 */
export type ContextPromptSelection = number | 'timeout';

/**
 * Callback for context prompt completion.
 */
export type ContextPromptCallback = (
  selection: ContextPromptSelection,
  context: {
    queuedPrompt: string;
    queuedFiles?: Array<{ id: string; name: string }>;
    threadMessageCount: number;
  }
) => Promise<void>;

/**
 * Decision type for existing worktree prompt reactions.
 */
export type ExistingWorktreeDecision = 'join' | 'skip';

/**
 * Callback for existing worktree prompt completion.
 */
export type ExistingWorktreeCallback = (
  decision: ExistingWorktreeDecision,
  context: { branch: string; worktreePath: string; username: string }
) => Promise<void>;

/**
 * Decision type for update prompt reactions.
 */
export type UpdatePromptDecision = 'update_now' | 'defer';

/**
 * Callback for update prompt completion.
 */
export type UpdatePromptCallback = (decision: UpdatePromptDecision) => Promise<void>;

// ---------------------------------------------------------------------------
// Prompt Executor
// ---------------------------------------------------------------------------

/**
 * Executor for system prompt operations.
 */
export class PromptExecutor extends BaseExecutor<PromptState> {
  constructor(options: ExecutorOptions) {
    super(options, PromptExecutor.createInitialState());
  }

  private static createInitialState(): PromptState {
    return {
      pendingContextPrompt: null,
      pendingExistingWorktreePrompt: null,
      pendingUpdatePrompt: null,
    };
  }

  protected getInitialState(): PromptState {
    return PromptExecutor.createInitialState();
  }

  /**
   * Get the current state (for inspection/testing).
   * Override to provide deep copy of nested objects.
   */
  override getState(): Readonly<PromptState> {
    return {
      pendingContextPrompt: this.state.pendingContextPrompt
        ? { ...this.state.pendingContextPrompt }
        : null,
      pendingExistingWorktreePrompt: this.state.pendingExistingWorktreePrompt
        ? { ...this.state.pendingExistingWorktreePrompt }
        : null,
      pendingUpdatePrompt: this.state.pendingUpdatePrompt
        ? { ...this.state.pendingUpdatePrompt }
        : null,
    };
  }

  /**
   * Hydrate state from persisted session data.
   * Used when resuming a session after bot restart.
   */
  hydrateState(persisted: {
    pendingContextPrompt?: PendingContextPrompt | null;
    pendingExistingWorktreePrompt?: PendingExistingWorktreePrompt | null;
    pendingUpdatePrompt?: PendingUpdatePrompt | null;
  }): void {
    this.state = {
      pendingContextPrompt: persisted.pendingContextPrompt ?? null,
      pendingExistingWorktreePrompt: persisted.pendingExistingWorktreePrompt ?? null,
      pendingUpdatePrompt: persisted.pendingUpdatePrompt ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Context prompt methods
  // ---------------------------------------------------------------------------

  /**
   * Set pending context prompt state.
   * Called when starting a session mid-thread and offering context selection.
   */
  setPendingContextPrompt(prompt: PendingContextPrompt): void {
    this.state.pendingContextPrompt = prompt;
  }

  /**
   * Get pending context prompt state.
   */
  getPendingContextPrompt(): PendingContextPrompt | null {
    return this.state.pendingContextPrompt;
  }

  /**
   * Check if there's a pending context prompt.
   */
  hasPendingContextPrompt(): boolean {
    return this.state.pendingContextPrompt !== null;
  }

  /**
   * Clear pending context prompt state.
   */
  clearPendingContextPrompt(): void {
    this.state.pendingContextPrompt = null;
  }

  /**
   * Handle a context prompt reaction.
   * Returns true if the reaction was handled, false otherwise.
   *
   * @param postId - The post ID the reaction was on
   * @param selection - The context selection (number of messages or 'timeout')
   * @param username - Username of the user who responded (for logging)
   * @param ctx - Executor context
   */
  async handleContextPromptResponse(
    postId: string,
    selection: ContextPromptSelection,
    username: string,
    ctx: ExecutorContext
  ): Promise<boolean> {
    if (!this.state.pendingContextPrompt) return false;
    if (this.state.pendingContextPrompt.postId !== postId) return false;

    const logger = log.forSession(ctx.sessionId);
    const { queuedPrompt, queuedFiles, threadMessageCount } = this.state.pendingContextPrompt;
    const formatter = ctx.platform.getFormatter();

    // Update the post based on selection
    let statusMessage: string;
    if (selection === 'timeout') {
      statusMessage = `⏱️ Continuing without context (no response)`;
      logger.info(`Context prompt timed out, continuing without context`);
    } else if (selection === 0) {
      statusMessage = `✅ Continuing without context (skipped by ${formatter.formatUserMention(username)})`;
      logger.info(`Context skipped by @${username}`);
    } else {
      statusMessage = `✅ Including last ${selection} messages (selected by ${formatter.formatUserMention(username)})`;
      logger.info(`Context selection: last ${selection} messages by @${username}`);
    }

    try {
      await ctx.platform.updatePost(postId, statusMessage);
    } catch (err) {
      logger.debug(`Failed to update context prompt post: ${err}`);
    }

    // Clear pending state
    this.state.pendingContextPrompt = null;

    // Emit context prompt complete event
    if (this.events) {
      this.events.emit('context-prompt:complete', {
        selection,
        queuedPrompt,
        queuedFiles,
        threadMessageCount,
      });
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Existing worktree prompt methods
  // ---------------------------------------------------------------------------

  /**
   * Set pending existing worktree prompt state.
   * Called when an existing worktree is found and user must decide to join or skip.
   */
  setPendingExistingWorktreePrompt(prompt: PendingExistingWorktreePrompt): void {
    this.state.pendingExistingWorktreePrompt = prompt;
  }

  /**
   * Get pending existing worktree prompt state.
   */
  getPendingExistingWorktreePrompt(): PendingExistingWorktreePrompt | null {
    return this.state.pendingExistingWorktreePrompt;
  }

  /**
   * Check if there's a pending existing worktree prompt.
   */
  hasPendingExistingWorktreePrompt(): boolean {
    return this.state.pendingExistingWorktreePrompt !== null;
  }

  /**
   * Clear pending existing worktree prompt state.
   */
  clearPendingExistingWorktreePrompt(): void {
    this.state.pendingExistingWorktreePrompt = null;
  }

  /**
   * Handle an existing worktree prompt reaction.
   * Returns true if the reaction was handled, false otherwise.
   *
   * @param postId - The post ID the reaction was on
   * @param decision - The worktree decision (join or skip)
   * @param username - Username of the user who responded (for logging)
   * @param ctx - Executor context
   */
  async handleExistingWorktreeResponse(
    postId: string,
    decision: ExistingWorktreeDecision,
    username: string,
    ctx: ExecutorContext
  ): Promise<boolean> {
    if (!this.state.pendingExistingWorktreePrompt) return false;
    if (this.state.pendingExistingWorktreePrompt.postId !== postId) return false;

    const logger = log.forSession(ctx.sessionId);
    const { branch, worktreePath } = this.state.pendingExistingWorktreePrompt;
    const formatter = ctx.platform.getFormatter();

    // Update the post based on decision
    let statusMessage: string;
    if (decision === 'join') {
      statusMessage = `✅ Joining existing worktree ${formatter.formatBold(branch)} (${formatter.formatUserMention(username)})`;
      logger.info(`Joining existing worktree ${branch} by @${username}`);
    } else {
      statusMessage = `✅ Continuing in current directory (skipped by ${formatter.formatUserMention(username)})`;
      logger.info(`Skipped joining existing worktree ${branch} by @${username}`);
    }

    try {
      await ctx.platform.updatePost(postId, statusMessage);
    } catch (err) {
      logger.debug(`Failed to update existing worktree prompt post: ${err}`);
    }

    // Clear pending state
    this.state.pendingExistingWorktreePrompt = null;

    // Emit worktree prompt complete event
    if (this.events) {
      this.events.emit('worktree-prompt:complete', {
        decision,
        branch,
        worktreePath,
        username,
      });
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Update prompt methods
  // ---------------------------------------------------------------------------

  /**
   * Set pending update prompt state.
   * Called when a version update is available and user must decide to update or defer.
   */
  setPendingUpdatePrompt(prompt: PendingUpdatePrompt): void {
    this.state.pendingUpdatePrompt = prompt;
  }

  /**
   * Get pending update prompt state.
   */
  getPendingUpdatePrompt(): PendingUpdatePrompt | null {
    return this.state.pendingUpdatePrompt;
  }

  /**
   * Check if there's a pending update prompt.
   */
  hasPendingUpdatePrompt(): boolean {
    return this.state.pendingUpdatePrompt !== null;
  }

  /**
   * Clear pending update prompt state.
   */
  clearPendingUpdatePrompt(): void {
    this.state.pendingUpdatePrompt = null;
  }

  /**
   * Handle an update prompt reaction.
   * Returns true if the reaction was handled, false otherwise.
   *
   * @param postId - The post ID the reaction was on
   * @param decision - The update decision (update_now or defer)
   * @param username - Username of the user who responded (for logging)
   * @param ctx - Executor context
   */
  async handleUpdatePromptResponse(
    postId: string,
    decision: UpdatePromptDecision,
    username: string,
    ctx: ExecutorContext
  ): Promise<boolean> {
    if (!this.state.pendingUpdatePrompt) return false;
    if (this.state.pendingUpdatePrompt.postId !== postId) return false;

    const logger = log.forSession(ctx.sessionId);
    const formatter = ctx.platform.getFormatter();

    // Update the post based on decision
    let statusMessage: string;
    if (decision === 'update_now') {
      statusMessage = `🔄 ${formatter.formatBold('Forcing update')} - restarting shortly...`;
      logger.info(`Update prompt: forcing update now by @${username}`);
    } else {
      statusMessage = `⏸️ ${formatter.formatBold('Update deferred')} for 1 hour`;
      logger.info(`Update prompt: update deferred by @${username}`);
    }

    try {
      await ctx.platform.updatePost(postId, statusMessage);
    } catch (err) {
      logger.debug(`Failed to update update prompt post: ${err}`);
    }

    // Clear pending state
    this.state.pendingUpdatePrompt = null;

    // Emit update prompt complete event
    if (this.events) {
      this.events.emit('update-prompt:complete', { decision });
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Unified reaction handler
  // ---------------------------------------------------------------------------

  /**
   * Handle a reaction on any post managed by this executor.
   * Returns true if the reaction was handled, false otherwise.
   *
   * @param postId - The post ID the reaction was on
   * @param emoji - The emoji name that was used
   * @param user - Username of the user who reacted
   * @param action - Whether the reaction was 'added' or 'removed'
   * @param ctx - Executor context
   */
  async handleReaction(
    postId: string,
    emoji: string,
    user: string,
    action: 'added' | 'removed',
    ctx: ExecutorContext
  ): Promise<boolean> {
    // Only handle 'added' reactions
    if (action !== 'added') {
      return false;
    }

    const logger = log.forSession(ctx.sessionId);

    // Check pending context prompt
    if (this.state.pendingContextPrompt?.postId === postId) {
      // Check for number emoji (to include N messages)
      const index = getNumberEmojiIndex(emoji);
      if (index >= 0) {
        // Number emojis are 1-indexed in context prompts (1 = 1 message, etc.)
        const { availableOptions } = this.state.pendingContextPrompt;
        if (index < availableOptions.length) {
          const selection = availableOptions[index];
          logger.debug(`Context prompt reaction from @${user}: ${selection} messages`);
          return this.handleContextPromptResponse(postId, selection, user, ctx);
        }
      }
      // Check for skip emoji (x or similar denial emoji means skip)
      if (isDenialEmoji(emoji)) {
        logger.debug(`Context prompt reaction from @${user}: skip`);
        return this.handleContextPromptResponse(postId, 0, user, ctx);
      }
      return false;
    }

    // Check pending existing worktree prompt
    if (this.state.pendingExistingWorktreePrompt?.postId === postId) {
      if (isApprovalEmoji(emoji)) {
        logger.debug(`Existing worktree reaction from @${user}: join`);
        return this.handleExistingWorktreeResponse(postId, 'join', user, ctx);
      }
      if (isDenialEmoji(emoji)) {
        logger.debug(`Existing worktree reaction from @${user}: skip`);
        return this.handleExistingWorktreeResponse(postId, 'skip', user, ctx);
      }
      return false;
    }

    // Check pending update prompt
    if (this.state.pendingUpdatePrompt?.postId === postId) {
      if (isApprovalEmoji(emoji)) {
        logger.debug(`Update prompt reaction from @${user}: update_now`);
        return this.handleUpdatePromptResponse(postId, 'update_now', user, ctx);
      }
      if (isDenialEmoji(emoji)) {
        logger.debug(`Update prompt reaction from @${user}: defer`);
        return this.handleUpdatePromptResponse(postId, 'defer', user, ctx);
      }
      return false;
    }

    // No pending state matched
    return false;
  }
}
