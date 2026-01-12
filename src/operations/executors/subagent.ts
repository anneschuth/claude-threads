/**
 * Subagent Executor - Handles SubagentOp
 *
 * Responsible for:
 * - Displaying subagent status posts
 * - Updating elapsed time for active subagents
 * - Managing minimize/expand state
 * - Marking subagents as complete
 */

import type { PlatformFormatter } from '../../platform/index.js';
import { MINIMIZE_TOGGLE_EMOJIS, isMinimizeToggleEmoji } from '../../utils/emoji.js';
import { formatDuration } from '../../utils/format.js';
import type { SubagentOp } from '../types.js';
import type { ExecutorContext, SubagentState, RegisterPostCallback, UpdateLastMessageCallback } from './types.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('subagent-executor');

/** Update interval for subagent elapsed time (5 seconds) */
const SUBAGENT_UPDATE_INTERVAL_MS = 5000;

// ---------------------------------------------------------------------------
// Subagent Executor
// ---------------------------------------------------------------------------

/**
 * Active subagent metadata.
 */
interface ActiveSubagent {
  postId: string;
  startTime: number;
  description: string;
  subagentType: string;
  isMinimized: boolean;
  isComplete: boolean;
  lastUpdateTime: number;
}

/**
 * Executor for subagent operations.
 */
export class SubagentExecutor {
  private state: SubagentState;
  private registerPost: RegisterPostCallback;
  private updateLastMessage: UpdateLastMessageCallback;
  private onBumpTaskList?: () => Promise<void>;

  constructor(options: {
    registerPost: RegisterPostCallback;
    updateLastMessage: UpdateLastMessageCallback;
    onBumpTaskList?: () => Promise<void>;
  }) {
    this.state = {
      activeSubagents: new Map(),
      subagentUpdateTimer: null,
    };
    this.registerPost = options.registerPost;
    this.updateLastMessage = options.updateLastMessage;
    this.onBumpTaskList = options.onBumpTaskList;
  }

  /**
   * Get the current state (for inspection/testing).
   */
  getState(): Readonly<{
    activeSubagents: ReadonlyMap<string, Readonly<ActiveSubagent>>;
    hasUpdateTimer: boolean;
  }> {
    return {
      activeSubagents: this.state.activeSubagents,
      hasUpdateTimer: this.state.subagentUpdateTimer !== null,
    };
  }

  /**
   * Reset state (for session restart).
   */
  reset(): void {
    this.stopUpdateTimer();
    this.state = {
      activeSubagents: new Map(),
      subagentUpdateTimer: null,
    };
  }

  /**
   * Get active subagents map (for compatibility with existing code).
   */
  getActiveSubagents(): Map<string, ActiveSubagent> {
    return this.state.activeSubagents;
  }

  /**
   * Execute a subagent operation.
   */
  async execute(op: SubagentOp, ctx: ExecutorContext): Promise<void> {
    const logger = log.forSession(ctx.sessionId);

    switch (op.action) {
      case 'start':
        await this.startSubagent(op, ctx);
        break;

      case 'update':
        await this.updateSubagent(op, ctx);
        break;

      case 'complete':
        await this.completeSubagent(op, ctx);
        break;

      case 'toggle_minimize':
        await this.toggleMinimize(op.toolUseId, ctx);
        break;

      default:
        logger.warn(`Unknown subagent action: ${op.action}`);
    }
  }

  /**
   * Start a new subagent.
   */
  private async startSubagent(op: SubagentOp, ctx: ExecutorContext): Promise<void> {
    const logger = log.forSession(ctx.sessionId);
    const now = Date.now();
    const formatter = ctx.platform.getFormatter();

    // Create subagent metadata
    const subagent: ActiveSubagent = {
      postId: '', // Will be set after post creation
      startTime: now,
      description: op.description,
      subagentType: op.subagentType,
      isMinimized: op.isMinimized ?? false,
      isComplete: false,
      lastUpdateTime: now,
    };

    // Format and post initial message with toggle emoji
    const message = this.formatSubagentPost(subagent, formatter);
    const post = await ctx.platform.createInteractivePost(
      message,
      [MINIMIZE_TOGGLE_EMOJIS[0]],
      ctx.threadId
    );

    subagent.postId = post.id;
    this.state.activeSubagents.set(op.toolUseId, subagent);

    // Register post for reaction routing
    this.registerPost(post.id, {
      type: 'subagent',
      interactionType: 'toggle_minimize',
      toolUseId: op.toolUseId,
    });
    this.updateLastMessage(post);

    logger.debug(`Started subagent ${op.subagentType} with post ${post.id.substring(0, 8)}`);

    // Start update timer if this is the first active subagent
    this.startUpdateTimerIfNeeded(ctx);

    // Bump task list to stay below subagent messages
    if (this.onBumpTaskList) {
      await this.onBumpTaskList();
    }
  }

  /**
   * Update an existing subagent.
   */
  private async updateSubagent(op: SubagentOp, ctx: ExecutorContext): Promise<void> {
    const subagent = this.state.activeSubagents.get(op.toolUseId);
    if (!subagent) return;

    const formatter = ctx.platform.getFormatter();

    // Update subagent metadata
    subagent.description = op.description;
    if (op.isMinimized !== undefined) {
      subagent.isMinimized = op.isMinimized;
    }
    subagent.lastUpdateTime = Date.now();

    // Update the post
    const message = this.formatSubagentPost(subagent, formatter);
    try {
      await ctx.platform.updatePost(subagent.postId, message);
    } catch (err) {
      log.forSession(ctx.sessionId).debug(`Failed to update subagent post: ${err}`);
    }
  }

  /**
   * Mark a subagent as complete.
   */
  private async completeSubagent(op: SubagentOp, ctx: ExecutorContext): Promise<void> {
    const logger = log.forSession(ctx.sessionId);
    const subagent = this.state.activeSubagents.get(op.toolUseId);
    if (!subagent) return;

    const formatter = ctx.platform.getFormatter();

    // Mark as complete
    subagent.isComplete = true;
    subagent.lastUpdateTime = Date.now();

    // Update the post with final elapsed time
    const message = this.formatSubagentPost(subagent, formatter);
    try {
      await ctx.platform.updatePost(subagent.postId, message);
    } catch (err) {
      logger.debug(`Failed to update subagent completion post: ${err}`);
    }

    // Stop the update timer if no more active subagents
    this.stopUpdateTimerIfNoActive();

    logger.debug(`Completed subagent ${op.toolUseId.substring(0, 8)}`);
  }

  /**
   * Toggle minimize state for a subagent.
   */
  private async toggleMinimize(toolUseId: string, ctx: ExecutorContext): Promise<void> {
    const subagent = this.state.activeSubagents.get(toolUseId);
    if (!subagent) return;

    const formatter = ctx.platform.getFormatter();
    subagent.isMinimized = !subagent.isMinimized;
    subagent.lastUpdateTime = Date.now();

    const message = this.formatSubagentPost(subagent, formatter);
    try {
      await ctx.platform.updatePost(subagent.postId, message);
    } catch (err) {
      log.forSession(ctx.sessionId).debug(`Failed to update subagent toggle: ${err}`);
    }
  }

  /**
   * Handle a reaction on a subagent post to minimize/expand.
   * Returns true if the toggle was handled, false otherwise.
   */
  async handleToggleReaction(
    postId: string,
    action: 'added' | 'removed',
    ctx: ExecutorContext
  ): Promise<boolean> {
    // Find the subagent by postId
    for (const [_toolUseId, subagent] of this.state.activeSubagents) {
      if (subagent.postId === postId) {
        const formatter = ctx.platform.getFormatter();

        // State-based: user adds reaction = minimize, user removes = expand
        const shouldMinimize = action === 'added';

        // Skip if already in desired state
        if (subagent.isMinimized === shouldMinimize) {
          return true;
        }

        subagent.isMinimized = shouldMinimize;
        subagent.lastUpdateTime = Date.now();

        log.forSession(ctx.sessionId).debug(
          `Subagent ${shouldMinimize ? 'minimized' : 'expanded'} (user ${action} reaction)`
        );

        // Update the post with new state
        const message = this.formatSubagentPost(subagent, formatter);
        try {
          await ctx.platform.updatePost(postId, message);
        } catch (err) {
          log.forSession(ctx.sessionId).debug(`Failed to update subagent toggle: ${err}`);
        }

        return true;
      }
    }
    return false;
  }

  /**
   * Handle a reaction on a subagent post.
   * Returns true if handled, false otherwise.
   */
  async handleReaction(
    postId: string,
    emoji: string,
    action: 'added' | 'removed',
    ctx: ExecutorContext
  ): Promise<boolean> {
    // Only handle minimize toggle reactions
    if (!isMinimizeToggleEmoji(emoji)) {
      return false;
    }

    return this.handleToggleReaction(postId, action, ctx);
  }

  /**
   * Format a subagent post with elapsed time and collapsible prompt.
   */
  private formatSubagentPost(
    subagent: ActiveSubagent,
    formatter: PlatformFormatter
  ): string {
    const elapsed = formatDuration(Date.now() - subagent.startTime);

    // Header with elapsed time
    let header = `🤖 ${formatter.formatBold('Subagent')} ${formatter.formatItalic(`(${subagent.subagentType})`)}`;
    header += subagent.isComplete ? ` ✅ ${elapsed}` : ` ⏳ ${elapsed}`;

    if (subagent.isMinimized) {
      return `${header} 🔽`;
    }

    // Expanded: show prompt
    return `${header}\n📋 ${formatter.formatBold('Prompt:')}\n${formatter.formatBlockquote(subagent.description)}\n🔽`;
  }

  /**
   * Start the subagent update timer if not already running.
   */
  private startUpdateTimerIfNeeded(ctx: ExecutorContext): void {
    if (this.state.subagentUpdateTimer) return;

    // Check if there are any active (non-complete) subagents
    const hasActiveSubagents = Array.from(this.state.activeSubagents.values())
      .some(s => !s.isComplete);

    if (!hasActiveSubagents) return;

    this.state.subagentUpdateTimer = setInterval(() => {
      this.updateAllSubagentPosts(ctx);
    }, SUBAGENT_UPDATE_INTERVAL_MS);
  }

  /**
   * Stop the subagent update timer.
   */
  private stopUpdateTimer(): void {
    if (this.state.subagentUpdateTimer) {
      clearInterval(this.state.subagentUpdateTimer);
      this.state.subagentUpdateTimer = null;
    }
  }

  /**
   * Stop the update timer if no more active subagents.
   */
  private stopUpdateTimerIfNoActive(): void {
    const hasActiveSubagents = Array.from(this.state.activeSubagents.values())
      .some(s => !s.isComplete);

    if (!hasActiveSubagents) {
      this.stopUpdateTimer();
    }
  }

  /**
   * Update all active (non-complete) subagent posts with current elapsed time.
   */
  private async updateAllSubagentPosts(ctx: ExecutorContext): Promise<void> {
    const now = Date.now();
    const formatter = ctx.platform.getFormatter();

    for (const [_toolUseId, subagent] of this.state.activeSubagents) {
      // Skip completed subagents and recently updated ones (debounce)
      if (subagent.isComplete) continue;
      if (now - subagent.lastUpdateTime < SUBAGENT_UPDATE_INTERVAL_MS - 500) continue;

      const message = this.formatSubagentPost(subagent, formatter);
      try {
        await ctx.platform.updatePost(subagent.postId, message);
        subagent.lastUpdateTime = now;
      } catch (err) {
        log.forSession(ctx.sessionId).debug(`Failed to update subagent elapsed time: ${err}`);
      }
    }
  }
}
