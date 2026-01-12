/**
 * Content Executor - Handles AppendContentOp and FlushOp
 *
 * Responsible for:
 * - Accumulating content in pendingContent
 * - Flushing content to posts at appropriate times
 * - Splitting long messages across multiple posts
 * - Managing currentPostId and currentPostContent
 */

import { truncateMessageSafely } from '../../platform/utils.js';
import { MIN_BREAK_THRESHOLD } from '../content-breaker.js';
import type { AppendContentOp, FlushOp } from '../types.js';
import type { ExecutorContext, ContentState, RegisterPostCallback, UpdateLastMessageCallback } from './types.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('content-executor');

// ---------------------------------------------------------------------------
// Content Executor
// ---------------------------------------------------------------------------

/**
 * Executor for content operations.
 */
export class ContentExecutor {
  private state: ContentState;
  private registerPost: RegisterPostCallback;
  private updateLastMessage: UpdateLastMessageCallback;
  private onBumpTaskList?: () => Promise<string | null>;

  constructor(options: {
    registerPost: RegisterPostCallback;
    updateLastMessage: UpdateLastMessageCallback;
    onBumpTaskList?: () => Promise<string | null>;
  }) {
    this.state = {
      currentPostId: null,
      currentPostContent: '',
      pendingContent: '',
      updateTimer: null,
    };
    this.registerPost = options.registerPost;
    this.updateLastMessage = options.updateLastMessage;
    this.onBumpTaskList = options.onBumpTaskList;
  }

  /**
   * Get the current state (for inspection/testing).
   */
  getState(): Readonly<ContentState> {
    return { ...this.state };
  }

  /**
   * Reset state (for session restart).
   */
  reset(): void {
    if (this.state.updateTimer) {
      clearTimeout(this.state.updateTimer);
    }
    this.state = {
      currentPostId: null,
      currentPostContent: '',
      pendingContent: '',
      updateTimer: null,
    };
  }

  /**
   * Reset content post state to start next content in a new post.
   * Called after compaction or before sending follow-up messages.
   */
  resetContentPost(): void {
    this.state.currentPostId = null;
    this.state.currentPostContent = '';
  }

  /**
   * Execute an append content operation.
   */
  async executeAppend(op: AppendContentOp, _ctx: ExecutorContext): Promise<void> {
    this.state.pendingContent += op.content;
  }

  /**
   * Execute a flush operation.
   */
  async executeFlush(op: FlushOp, ctx: ExecutorContext): Promise<void> {
    await this.flush(ctx, op.reason);
  }

  /**
   * Schedule a delayed flush.
   */
  scheduleFlush(ctx: ExecutorContext, delayMs: number = 500): void {
    if (this.state.updateTimer) return;

    this.state.updateTimer = setTimeout(() => {
      this.state.updateTimer = null;
      this.flush(ctx, 'soft_threshold');
    }, delayMs);
  }

  /**
   * Flush pending content to the platform.
   */
  async flush(ctx: ExecutorContext, _reason: FlushOp['reason']): Promise<void> {
    const logger = log.forSession(ctx.sessionId);

    if (!this.state.pendingContent.trim()) {
      return; // Nothing to flush
    }

    // Capture content at start of flush
    const pendingAtFlushStart = this.state.pendingContent;

    // Format for target platform
    const formatter = ctx.platform.getFormatter();
    let content = formatter.formatMarkdown(pendingAtFlushStart).trim();

    // Get platform limits
    const { maxLength: MAX_POST_LENGTH, hardThreshold: HARD_CONTINUATION_THRESHOLD } =
      ctx.platform.getMessageLimits();

    // Check if we should break early
    const shouldBreakEarly = this.state.currentPostId &&
      content.length > MIN_BREAK_THRESHOLD &&
      ctx.contentBreaker.shouldFlushEarly(content);

    // Handle message splitting
    if (this.state.currentPostId && (content.length > HARD_CONTINUATION_THRESHOLD || shouldBreakEarly)) {
      await this.handleSplit(ctx, content, pendingAtFlushStart, HARD_CONTINUATION_THRESHOLD);
      return;
    }

    // Normal case: content fits in current post
    if (content.length > MAX_POST_LENGTH) {
      logger.warn(`Content too long (${content.length}), truncating`);
      content = truncateMessageSafely(
        content,
        MAX_POST_LENGTH,
        formatter.formatItalic('... (truncated)')
      );
    }

    if (this.state.currentPostId) {
      // Update existing post
      const postId = this.state.currentPostId;
      try {
        const combinedContent = this.state.currentPostContent
          ? this.state.currentPostContent + content
          : content;
        await ctx.platform.updatePost(postId, combinedContent);
        this.state.currentPostContent = combinedContent;
        this.clearFlushedContent(pendingAtFlushStart);
      } catch (err) {
        logger.debug(`Update failed, will create new post on next flush: ${err}`);
        this.state.currentPostId = null;
        this.state.currentPostContent = '';
      }
    } else {
      // Create new post
      await this.createNewPost(ctx, content, pendingAtFlushStart);
    }
  }

  /**
   * Handle splitting content across multiple posts.
   */
  private async handleSplit(
    ctx: ExecutorContext,
    content: string,
    pendingAtFlushStart: string,
    hardThreshold: number
  ): Promise<void> {
    const logger = log.forSession(ctx.sessionId);

    // Determine break point
    let breakPoint: number;
    let codeBlockOpenPosition: number | undefined;

    if (content.length > hardThreshold) {
      // Hard break
      const startSearchPos = Math.floor(hardThreshold * 0.7);
      const breakInfo = ctx.contentBreaker.findLogicalBreakpoint(
        content,
        startSearchPos,
        Math.floor(hardThreshold * 0.3)
      );

      if (breakInfo) {
        breakPoint = breakInfo.position;
      } else {
        // Check if inside code block
        const codeBlockState = ctx.contentBreaker.getCodeBlockState(content, startSearchPos);
        if (codeBlockState.isInside) {
          codeBlockOpenPosition = codeBlockState.openPosition;
          breakPoint = hardThreshold;
        } else {
          breakPoint = content.lastIndexOf('\n', hardThreshold);
          if (breakPoint < hardThreshold * 0.7) {
            breakPoint = hardThreshold;
          }
        }
      }
    } else {
      // Soft break
      const breakInfo = ctx.contentBreaker.findLogicalBreakpoint(content, 2000);
      if (breakInfo && breakInfo.position < content.length) {
        breakPoint = breakInfo.position;
      } else {
        // No good breakpoint - just update current post
        if (this.state.currentPostId) {
          try {
            await ctx.platform.updatePost(this.state.currentPostId, content);
          } catch {
            logger.debug('Update failed (no breakpoint), will create new post on next flush');
            this.state.currentPostId = null;
          }
        }
        return;
      }
    }

    // Split at code block start if needed
    if (codeBlockOpenPosition !== undefined) {
      if (codeBlockOpenPosition === 0) {
        // Code block at start - just update and wait
        if (this.state.currentPostId) {
          try {
            await ctx.platform.updatePost(this.state.currentPostId, content);
          } catch {
            logger.debug('Update failed (code block at start)');
            this.state.currentPostId = null;
          }
        }
        return;
      }

      const breakBeforeCodeBlock = content.lastIndexOf('\n', codeBlockOpenPosition);
      if (breakBeforeCodeBlock > 0) {
        breakPoint = breakBeforeCodeBlock;
      } else {
        if (this.state.currentPostId) {
          try {
            await ctx.platform.updatePost(this.state.currentPostId, content);
          } catch {
            logger.debug('Update failed (no break before code block)');
            this.state.currentPostId = null;
          }
        }
        return;
      }
    }

    // Split content
    const firstPart = content.substring(0, breakPoint).trim();
    const remainder = content.substring(breakPoint).trim();

    // Update current post with first part
    if (this.state.currentPostId) {
      try {
        await ctx.platform.updatePost(this.state.currentPostId, firstPart);
      } catch {
        logger.debug('Update failed during split, continuing with new post');
      }
    }

    // Start new post
    this.state.currentPostId = null;
    this.state.pendingContent = remainder;

    // Create continuation post if there's content
    if (remainder) {
      await this.createNewPost(ctx, remainder, pendingAtFlushStart);
    }
  }

  /**
   * Create a new post.
   */
  private async createNewPost(
    ctx: ExecutorContext,
    content: string,
    pendingAtFlushStart: string
  ): Promise<void> {
    const logger = log.forSession(ctx.sessionId);

    // Try to bump task list first
    if (this.onBumpTaskList) {
      const bumpedPostId = await this.onBumpTaskList();
      if (bumpedPostId) {
        this.state.currentPostId = bumpedPostId;
        this.state.currentPostContent = content;
        this.clearFlushedContent(pendingAtFlushStart);
        return;
      }
    }

    // Create new post
    try {
      const post = await ctx.platform.createPost(content, ctx.threadId);
      this.state.currentPostId = post.id;
      this.state.currentPostContent = content;
      this.registerPost(post.id, { type: 'content' });
      this.updateLastMessage(post);
      this.clearFlushedContent(pendingAtFlushStart);
      logger.debug(`Created post ${post.id.substring(0, 8)}`);
    } catch (err) {
      logger.error(`Failed to create post: ${err}`);
    }
  }

  /**
   * Clear flushed content from pending, preserving new content added during async ops.
   */
  private clearFlushedContent(flushedContent: string): void {
    if (this.state.pendingContent.startsWith(flushedContent)) {
      this.state.pendingContent = this.state.pendingContent.slice(flushedContent.length);
    } else {
      this.state.pendingContent = '';
    }
  }
}
