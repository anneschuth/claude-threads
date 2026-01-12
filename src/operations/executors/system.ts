/**
 * System Executor - Handles SystemMessageOp, StatusUpdateOp, and LifecycleOp
 *
 * Responsible for:
 * - Posting system messages (info, warning, error, success)
 * - Handling status updates (context usage, model info)
 * - Managing lifecycle events (started, idle, paused, resumed)
 *
 * Uses TypedEventEmitter for communication with Session/Lifecycle layers.
 * Events are emitted for status updates and lifecycle changes.
 */

import type { PlatformFormatter, PlatformPost } from '../../platform/index.js';
import type { SystemMessageOp, StatusUpdateOp, LifecycleOp, SystemMessageLevel } from '../types.js';
import type { ExecutorContext, RegisterPostCallback, UpdateLastMessageCallback } from './types.js';
import { createLogger } from '../../utils/logger.js';
import type { TypedEventEmitter } from '../message-manager-events.js';

const log = createLogger('system-executor');

// ---------------------------------------------------------------------------
// System Executor
// ---------------------------------------------------------------------------

/**
 * Executor for system messages and status updates.
 */
export class SystemExecutor {
  private registerPost: RegisterPostCallback;
  private updateLastMessage: UpdateLastMessageCallback;
  private events?: TypedEventEmitter;

  /** Track ephemeral posts for potential cleanup */
  private ephemeralPosts: Set<string> = new Set();

  constructor(options: {
    registerPost: RegisterPostCallback;
    updateLastMessage: UpdateLastMessageCallback;
    /**
     * Event emitter for notifying about status and lifecycle events.
     * If provided, events are emitted instead of callbacks being called.
     */
    events?: TypedEventEmitter;
  }) {
    this.registerPost = options.registerPost;
    this.updateLastMessage = options.updateLastMessage;
    this.events = options.events;
  }

  /**
   * Reset state (for session restart).
   */
  reset(): void {
    this.ephemeralPosts.clear();
  }

  /**
   * Execute a system message operation.
   */
  async executeSystemMessage(op: SystemMessageOp, ctx: ExecutorContext): Promise<void> {
    const logger = log.forSession(ctx.sessionId);
    const formatter = ctx.platform.getFormatter();

    // Format message with level indicator
    const formattedMessage = this.formatSystemMessage(op.message, op.level, formatter);

    try {
      const post = await ctx.platform.createPost(formattedMessage, ctx.threadId);

      this.registerPost(post.id, { type: 'system' });
      this.updateLastMessage(post);

      // Track ephemeral posts
      if (op.ephemeral) {
        this.ephemeralPosts.add(post.id);
      }

      logger.debug(`Posted ${op.level} message`);
    } catch (err) {
      logger.error(`Failed to post system message: ${err}`);
    }
  }

  /**
   * Execute a status update operation.
   */
  async executeStatusUpdate(op: StatusUpdateOp, ctx: ExecutorContext): Promise<void> {
    const logger = log.forSession(ctx.sessionId);

    // Emit status update event (typically updates session header)
    if (this.events) {
      this.events.emit('status:update', {
        modelId: op.modelId,
        modelDisplayName: op.modelDisplayName,
        contextWindowSize: op.contextWindowSize,
        contextTokens: op.contextTokens,
        totalCostUSD: op.totalCostUSD,
      });
    }

    logger.debug('Status update processed');
  }

  /**
   * Execute a lifecycle operation.
   */
  async executeLifecycle(op: LifecycleOp, ctx: ExecutorContext): Promise<void> {
    const logger = log.forSession(ctx.sessionId);

    // Emit lifecycle event
    if (this.events) {
      this.events.emit('lifecycle:event', { event: op.event });
    }

    logger.debug(`Lifecycle event: ${op.event}`);
  }

  /**
   * Post an info message.
   */
  async postInfo(message: string, ctx: ExecutorContext): Promise<PlatformPost | undefined> {
    const formatter = ctx.platform.getFormatter();
    const formattedMessage = this.formatSystemMessage(message, 'info', formatter);

    try {
      const post = await ctx.platform.createPost(formattedMessage, ctx.threadId);
      this.registerPost(post.id, { type: 'system' });
      this.updateLastMessage(post);
      return post;
    } catch (err) {
      log.forSession(ctx.sessionId).error(`Failed to post info message: ${err}`);
      return undefined;
    }
  }

  /**
   * Post a warning message.
   */
  async postWarning(message: string, ctx: ExecutorContext): Promise<PlatformPost | undefined> {
    const formatter = ctx.platform.getFormatter();
    const formattedMessage = this.formatSystemMessage(message, 'warning', formatter);

    try {
      const post = await ctx.platform.createPost(formattedMessage, ctx.threadId);
      this.registerPost(post.id, { type: 'system' });
      this.updateLastMessage(post);
      return post;
    } catch (err) {
      log.forSession(ctx.sessionId).error(`Failed to post warning message: ${err}`);
      return undefined;
    }
  }

  /**
   * Post an error message.
   */
  async postError(message: string, ctx: ExecutorContext): Promise<PlatformPost | undefined> {
    const formatter = ctx.platform.getFormatter();
    const formattedMessage = this.formatSystemMessage(message, 'error', formatter);

    try {
      const post = await ctx.platform.createPost(formattedMessage, ctx.threadId);
      this.registerPost(post.id, { type: 'system' });
      this.updateLastMessage(post);
      return post;
    } catch (err) {
      log.forSession(ctx.sessionId).error(`Failed to post error message: ${err}`);
      return undefined;
    }
  }

  /**
   * Post a success message.
   */
  async postSuccess(message: string, ctx: ExecutorContext): Promise<PlatformPost | undefined> {
    const formatter = ctx.platform.getFormatter();
    const formattedMessage = this.formatSystemMessage(message, 'success', formatter);

    try {
      const post = await ctx.platform.createPost(formattedMessage, ctx.threadId);
      this.registerPost(post.id, { type: 'system' });
      this.updateLastMessage(post);
      return post;
    } catch (err) {
      log.forSession(ctx.sessionId).error(`Failed to post success message: ${err}`);
      return undefined;
    }
  }

  /**
   * Clean up ephemeral posts.
   */
  async cleanupEphemeralPosts(ctx: ExecutorContext): Promise<void> {
    const logger = log.forSession(ctx.sessionId);

    for (const postId of this.ephemeralPosts) {
      try {
        await ctx.platform.deletePost(postId);
      } catch (err) {
        logger.debug(`Failed to delete ephemeral post ${postId}: ${err}`);
      }
    }

    this.ephemeralPosts.clear();
  }

  /**
   * Format a system message with level indicator.
   */
  private formatSystemMessage(
    message: string,
    level: SystemMessageLevel,
    _formatter: PlatformFormatter
  ): string {
    const levelIndicators: Record<SystemMessageLevel, string> = {
      info: 'ℹ️',
      warning: '⚠️',
      error: '❌',
      success: '✅',
    };

    const indicator = levelIndicators[level];
    return `${indicator} ${message}`;
  }
}
