/**
 * Prompt Executor - Handles system prompts requiring user selection
 *
 * Responsible for:
 * - Context prompt (thread context selection)
 * - Existing worktree prompt (join/skip worktree)
 * - Update prompt (update now/defer)
 * - Processing user responses via reactions
 */

import { isApprovalEmoji, isDenialEmoji, isAllowAllEmoji, getNumberEmojiIndex } from '../../utils/emoji.js';
import { completePendingPrompt } from './pending-prompt.js';
import type {
  ExecutorContext,
  PromptState,
  PendingContextPrompt,
  PendingExistingWorktreePrompt,
  PendingUpdatePrompt,
  PendingRoutinePrompt,
  PendingWatchPrompt,
} from './types.js';
import { BaseExecutor, type ExecutorOptions } from './base.js';

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
 * Decision type for existing worktree prompt reactions.
 */
export type ExistingWorktreeDecision = 'join' | 'skip';

/**
 * Decision type for update prompt reactions.
 */
export type UpdatePromptDecision = 'update_now' | 'defer';

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
      pendingRoutinePrompt: null,
      pendingWatchPrompt: null,
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
      pendingRoutinePrompt: this.state.pendingRoutinePrompt
        ? { ...this.state.pendingRoutinePrompt }
        : null,
      pendingWatchPrompt: this.state.pendingWatchPrompt
        ? { ...this.state.pendingWatchPrompt }
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
      // Routine/watch confirmations are transient by design — never restored.
      pendingRoutinePrompt: null,
      pendingWatchPrompt: null,
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
   * Serialize the pending context prompt for `PersistedSession`. Returns
   * `null` when there is no prompt awaiting a reaction — the persistence
   * writer treats absent and null identically.
   */
  serialize(): PendingContextPrompt | null {
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
  handleContextPromptResponse(
    postId: string,
    selection: ContextPromptSelection,
    username: string,
    ctx: ExecutorContext
  ): Promise<boolean> {
    return completePendingPrompt({
      pending: this.state.pendingContextPrompt,
      postId,
      ctx,
      label: 'context prompt',
      statusMessage: () => {
        if (selection === 'timeout') {
          ctx.logger.info(`Context prompt timed out, continuing without context`);
          return `⏱️ Continuing without context (no response)`;
        }
        if (selection === 0) {
          ctx.logger.info(`Context skipped by @${username}`);
          return `✅ Continuing without context (skipped by ${ctx.formatter.formatUserMention(username)})`;
        }
        ctx.logger.info(`Context selection: last ${selection} messages by @${username}`);
        return `✅ Including last ${selection} messages (selected by ${ctx.formatter.formatUserMention(username)})`;
      },
      clear: () => { this.state.pendingContextPrompt = null; },
      emit: ({ queuedPrompt, queuedFiles, queuedByUsername, threadMessageCount }) =>
        this.events?.emit('context-prompt:complete', {
          selection,
          queuedPrompt,
          queuedFiles,
          queuedByUsername,
          threadMessageCount,
        }),
    });
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
  handleExistingWorktreeResponse(
    postId: string,
    decision: ExistingWorktreeDecision,
    username: string,
    ctx: ExecutorContext
  ): Promise<boolean> {
    return completePendingPrompt({
      pending: this.state.pendingExistingWorktreePrompt,
      postId,
      ctx,
      label: 'existing worktree prompt',
      statusMessage: ({ branch }) => {
        if (decision === 'join') {
          ctx.logger.info(`Joining existing worktree ${branch} by @${username}`);
          return `✅ Joining existing worktree ${ctx.formatter.formatBold(branch)} (${ctx.formatter.formatUserMention(username)})`;
        }
        ctx.logger.info(`Skipped joining existing worktree ${branch} by @${username}`);
        return `✅ Continuing in current directory (skipped by ${ctx.formatter.formatUserMention(username)})`;
      },
      clear: () => { this.state.pendingExistingWorktreePrompt = null; },
      emit: ({ branch, worktreePath }) =>
        this.events?.emit('worktree-prompt:complete', { decision, branch, worktreePath, username }),
    });
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
  handleUpdatePromptResponse(
    postId: string,
    decision: UpdatePromptDecision,
    username: string,
    ctx: ExecutorContext
  ): Promise<boolean> {
    return completePendingPrompt({
      pending: this.state.pendingUpdatePrompt,
      postId,
      ctx,
      label: 'update prompt',
      statusMessage: () => {
        if (decision === 'update_now') {
          ctx.logger.info(`Update prompt: forcing update now by @${username}`);
          return `🔄 ${ctx.formatter.formatBold('Forcing update')} - restarting shortly...`;
        }
        ctx.logger.info(`Update prompt: update deferred by @${username}`);
        return `⏸️ ${ctx.formatter.formatBold('Update deferred')} for 1 hour`;
      },
      clear: () => { this.state.pendingUpdatePrompt = null; },
      emit: () => this.events?.emit('update-prompt:complete', { decision }),
    });
  }

  // ---------------------------------------------------------------------------
  // Routine-creation confirmation methods
  // ---------------------------------------------------------------------------

  /**
   * Set the pending routine-creation confirmation. One at a time per session;
   * a newer request replaces an unanswered older one.
   */
  setPendingRoutinePrompt(prompt: PendingRoutinePrompt): void {
    this.state.pendingRoutinePrompt = prompt;
  }

  hasPendingRoutinePrompt(): boolean {
    return this.state.pendingRoutinePrompt !== null;
  }

  /**
   * Shared body of the routine/watch creation-confirmation handlers: match
   * the pending prompt to the reacted post, update the confirmation card,
   * clear the pending state, and hand the typed payload to `emit`. The
   * public wrappers below keep the per-flavor typed events — those are
   * load-bearing for the lifecycle listeners.
   */
  private async completeCreationPrompt<P extends { name: string }>(
    pending: { postId: string; parsed: P; requestedBy: string; proposedByAgent?: boolean } | null,
    label: string,
    clear: () => void,
    emit: (payload: { approved: boolean; parsed: P; requestedBy: string; decidedBy: string; postId: string; proposedByAgent?: boolean; requireApproval: boolean }) => void,
    postId: string,
    approved: boolean,
    requireApproval: boolean,
    username: string,
    ctx: ExecutorContext,
  ): Promise<boolean> {
    // Agent proposals skip the owner gate the `!routine`/`!watch` commands
    // apply at request time, so the DECISION is owner-gated here instead —
    // and gated BEFORE the pending prompt is consumed: an unauthorized
    // participant's reaction (either way) must not burn the one pending
    // slot, or any invited guest could veto every proposal. The pending
    // stays parked; the owner's later reaction still decides it.
    // (requestedBy is the session owner for agent proposals by contract;
    // lifecycle re-checks the same rule at save time as defense in depth.)
    if (
      pending?.proposedByAgent &&
      pending.postId === postId &&
      username !== pending.requestedBy &&
      !ctx.platform.isUserAllowed(username)
    ) {
      // Warn once per pending proposal: a guest toggling reactions must
      // not be able to spam the thread with one warning per toggle.
      if (!(pending as { unauthorizedWarned?: boolean }).unauthorizedWarned) {
        (pending as { unauthorizedWarned?: boolean }).unauthorizedWarned = true;
        await ctx.createPost(
          `⚠️ Only ${ctx.formatter.formatUserMention(pending.requestedBy)} or allowed users can decide a ${label.toLowerCase()} Claude proposed.`,
          { type: 'system' },
        );
      }
      return true;
    }
    return completePendingPrompt({
      pending,
      postId,
      ctx,
      label: `${label.toLowerCase()} prompt`,
      statusMessage: ({ parsed }) => approved
        ? `✅ ${ctx.formatter.formatBold(`${label} "${parsed.name}" confirmed`)} by ${ctx.formatter.formatUserMention(username)} — saving...`
        : `❌ ${ctx.formatter.formatBold(`${label} "${parsed.name}" discarded`)} by ${ctx.formatter.formatUserMention(username)}`,
      clear,
      emit: ({ parsed, requestedBy }) => emit({ approved, parsed, requestedBy, decidedBy: username, postId, proposedByAgent: pending?.proposedByAgent, requireApproval }),
    });
  }

  /**
   * Handle a routine confirmation reaction. Emits 'routine-prompt:complete';
   * the lifecycle listener does the actual store write on approval.
   */
  handleRoutinePromptResponse(
    postId: string,
    approved: boolean,
    requireApproval: boolean,
    username: string,
    ctx: ExecutorContext
  ): Promise<boolean> {
    return this.completeCreationPrompt(
      this.state.pendingRoutinePrompt,
      'Routine',
      () => { this.state.pendingRoutinePrompt = null; },
      (payload) => this.events?.emit('routine-prompt:complete', payload),
      postId, approved, requireApproval, username, ctx,
    );
  }

  // ---------------------------------------------------------------------------
  // Watch-creation confirmation methods
  // ---------------------------------------------------------------------------

  /**
   * Set the pending watch-creation confirmation. One at a time per session;
   * a newer request replaces an unanswered older one.
   */
  setPendingWatchPrompt(prompt: PendingWatchPrompt): void {
    this.state.pendingWatchPrompt = prompt;
  }

  hasPendingWatchPrompt(): boolean {
    return this.state.pendingWatchPrompt !== null;
  }

  /**
   * Handle a watch confirmation reaction. Emits 'watch-prompt:complete';
   * the lifecycle listener does the actual store write on approval.
   */
  handleWatchPromptResponse(
    postId: string,
    approved: boolean,
    requireApproval: boolean,
    username: string,
    ctx: ExecutorContext
  ): Promise<boolean> {
    return this.completeCreationPrompt(
      this.state.pendingWatchPrompt,
      'Watch',
      () => { this.state.pendingWatchPrompt = null; },
      (payload) => this.events?.emit('watch-prompt:complete', payload),
      postId, approved, requireApproval, username, ctx,
    );
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
    ctx.logger.debug(`PromptExecutor.handleReaction: postId=${postId.substring(0, 8)}, emoji=${emoji}, user=${user}, action=${action}`);

    // Only handle 'added' reactions
    if (action !== 'added') {
      ctx.logger.debug(`PromptExecutor: ignoring ${action} reaction (only handling 'added')`);
      return false;
    }

    // Check pending context prompt
    if (this.state.pendingContextPrompt?.postId === postId) {
      // Check for number emoji (to include N messages)
      const index = getNumberEmojiIndex(emoji);
      if (index >= 0) {
        // Number emojis are 1-indexed in context prompts (1 = 1 message, etc.)
        const { availableOptions } = this.state.pendingContextPrompt;
        if (index < availableOptions.length) {
          const selection = availableOptions[index];
          ctx.logger.debug(`Context prompt reaction from @${user}: ${selection} messages`);
          const handled = await this.handleContextPromptResponse(postId, selection, user, ctx);
          ctx.logger.debug(`PromptExecutor: context prompt outcome=${selection} messages, handled=${handled}`);
          return handled;
        }
        ctx.logger.debug(`PromptExecutor: number index ${index} out of range for available options`);
      }
      // Check for skip emoji (x or similar denial emoji means skip)
      if (isDenialEmoji(emoji)) {
        ctx.logger.debug(`Context prompt reaction from @${user}: skip`);
        const handled = await this.handleContextPromptResponse(postId, 0, user, ctx);
        ctx.logger.debug(`PromptExecutor: context prompt outcome=skip, handled=${handled}`);
        return handled;
      }
      ctx.logger.debug(`PromptExecutor: emoji ${emoji} not valid for context prompt, ignoring`);
      return false;
    }

    // Check pending existing worktree prompt
    if (this.state.pendingExistingWorktreePrompt?.postId === postId) {
      if (isApprovalEmoji(emoji)) {
        ctx.logger.debug(`Existing worktree reaction from @${user}: join`);
        const handled = await this.handleExistingWorktreeResponse(postId, 'join', user, ctx);
        ctx.logger.debug(`PromptExecutor: worktree prompt outcome=join, handled=${handled}`);
        return handled;
      }
      if (isDenialEmoji(emoji)) {
        ctx.logger.debug(`Existing worktree reaction from @${user}: skip`);
        const handled = await this.handleExistingWorktreeResponse(postId, 'skip', user, ctx);
        ctx.logger.debug(`PromptExecutor: worktree prompt outcome=skip, handled=${handled}`);
        return handled;
      }
      ctx.logger.debug(`PromptExecutor: emoji ${emoji} not valid for worktree prompt, ignoring`);
      return false;
    }

    // Check pending update prompt
    if (this.state.pendingUpdatePrompt?.postId === postId) {
      if (isApprovalEmoji(emoji)) {
        ctx.logger.debug(`Update prompt reaction from @${user}: update_now`);
        const handled = await this.handleUpdatePromptResponse(postId, 'update_now', user, ctx);
        ctx.logger.debug(`PromptExecutor: update prompt outcome=update_now, handled=${handled}`);
        return handled;
      }
      if (isDenialEmoji(emoji)) {
        ctx.logger.debug(`Update prompt reaction from @${user}: defer`);
        const handled = await this.handleUpdatePromptResponse(postId, 'defer', user, ctx);
        ctx.logger.debug(`PromptExecutor: update prompt outcome=defer, handled=${handled}`);
        return handled;
      }
      ctx.logger.debug(`PromptExecutor: emoji ${emoji} not valid for update prompt, ignoring`);
      return false;
    }

    // Check pending routine-creation confirmation.
    //   👍  save, approvals required (safe default)
    //   ✅  save, run autonomously (no per-action approval) — human creations only
    //   👎  discard
    // Agent-proposed items never offer the autonomous option: an autonomous
    // unattended item is a deliberate human choice, so a ✅ on an agent
    // proposal is treated as the safe "approvals required" save.
    if (this.state.pendingRoutinePrompt?.postId === postId) {
      const agentProposed = this.state.pendingRoutinePrompt.proposedByAgent === true;
      if (isApprovalEmoji(emoji)) {
        ctx.logger.debug(`Routine prompt reaction from @${user}: approve (approvals required)`);
        return this.handleRoutinePromptResponse(postId, true, true, user, ctx);
      }
      if (isAllowAllEmoji(emoji)) {
        ctx.logger.debug(`Routine prompt reaction from @${user}: approve (autonomous=${!agentProposed})`);
        return this.handleRoutinePromptResponse(postId, true, agentProposed, user, ctx);
      }
      if (isDenialEmoji(emoji)) {
        ctx.logger.debug(`Routine prompt reaction from @${user}: discard`);
        return this.handleRoutinePromptResponse(postId, false, true, user, ctx);
      }
      ctx.logger.debug(`PromptExecutor: emoji ${emoji} not valid for routine prompt, ignoring`);
      return false;
    }

    if (this.state.pendingWatchPrompt?.postId === postId) {
      const agentProposed = this.state.pendingWatchPrompt.proposedByAgent === true;
      if (isApprovalEmoji(emoji)) {
        ctx.logger.debug(`Watch prompt reaction from @${user}: approve (approvals required)`);
        return this.handleWatchPromptResponse(postId, true, true, user, ctx);
      }
      if (isAllowAllEmoji(emoji)) {
        ctx.logger.debug(`Watch prompt reaction from @${user}: approve (autonomous=${!agentProposed})`);
        return this.handleWatchPromptResponse(postId, true, agentProposed, user, ctx);
      }
      if (isDenialEmoji(emoji)) {
        ctx.logger.debug(`Watch prompt reaction from @${user}: discard`);
        return this.handleWatchPromptResponse(postId, false, true, user, ctx);
      }
      ctx.logger.debug(`PromptExecutor: emoji ${emoji} not valid for watch prompt, ignoring`);
      return false;
    }

    // No pending state matched
    ctx.logger.debug(`PromptExecutor: no pending prompt state matches postId=${postId.substring(0, 8)}`);
    return false;
  }
}
