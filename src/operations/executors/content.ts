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
import { formatShortId } from '../../utils/format.js';
import { MIN_BREAK_THRESHOLD } from '../content-breaker.js';
import type { AppendContentOp, FlushOp } from '../types.js';
import type { ExecutorContext, ContentState } from './types.js';
import { BaseExecutor, type ExecutorOptions } from './base.js';

// ---------------------------------------------------------------------------
// Content Executor Options
// ---------------------------------------------------------------------------

/**
 * Extended options for ContentExecutor.
 */
export interface ContentExecutorOptions extends ExecutorOptions {
  /** Callback to bump task list and get old post ID for reuse */
  onBumpTaskList?: () => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Content Executor
// ---------------------------------------------------------------------------

/**
 * Executor for content operations.
 */
export class ContentExecutor extends BaseExecutor<ContentState> {
  private onBumpTaskList?: () => Promise<string | null>;

  constructor(options: ContentExecutorOptions) {
    super(options, ContentExecutor.createInitialState());
    this.onBumpTaskList = options.onBumpTaskList;
  }

  private static createInitialState(): ContentState {
    return {
      currentPostId: null,
      currentPostContent: '',
      pendingContent: '',
      updateTimer: null,
    };
  }

  protected getInitialState(): ContentState {
    return ContentExecutor.createInitialState();
  }

  /**
   * Reset state (for session restart).
   * Override to clear timer before resetting state.
   */
  override reset(): void {
    if (this.state.updateTimer) {
      clearTimeout(this.state.updateTimer);
    }
    this.state = this.getInitialState();
  }

  /**
   * Close the current post, signaling that subsequent content should go to a new post.
   * Called when user sends a message or after compaction.
   */
  closeCurrentPost(): void {
    this.state.currentPostId = null;
    this.state.currentPostContent = '';
  }

  /**
   * Execute an append content operation.
   */
  async executeAppend(op: AppendContentOp, _ctx: ExecutorContext): Promise<void> {
    // Tool output needs spacing before and after to separate from text
    if (op.isToolOutput && this.state.pendingContent.length > 0) {
      if (!this.state.pendingContent.endsWith('\n\n')) {
        if (this.state.pendingContent.endsWith('\n')) {
          this.state.pendingContent += '\n';
        } else {
          this.state.pendingContent += '\n\n';
        }
      }
    }
    this.state.pendingContent += op.content;

    // Add spacing after tool output so next content is separated
    if (op.isToolOutput) {
      this.state.pendingContent += '\n\n';
    }
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
    if (!this.state.pendingContent.trim()) {
      return; // Nothing to flush
    }

    // Capture content at start of flush
    const pendingAtFlushStart = this.state.pendingContent;

    // Format for target platform
    let content = ctx.formatter.formatMarkdown(pendingAtFlushStart).trim();

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
      ctx.logger.warn(`Content too long (${content.length}), truncating`);
      content = truncateMessageSafely(
        content,
        MAX_POST_LENGTH,
        ctx.formatter.formatItalic('... (truncated)')
      );
    }

    if (this.state.currentPostId) {
      // Update existing post
      const postId = this.state.currentPostId;
      try {
        // Ensure proper spacing when combining content
        // The trim() removes trailing newlines, so we need to add them back when combining
        let combinedContent: string;
        if (this.state.currentPostContent) {
          const needsSeparator = !this.state.currentPostContent.endsWith('\n') && !content.startsWith('\n');
          combinedContent = needsSeparator
            ? this.state.currentPostContent + '\n\n' + content
            : this.state.currentPostContent + content;
        } else {
          combinedContent = content;
        }
        await ctx.platform.updatePost(postId, combinedContent);
        this.state.currentPostContent = combinedContent;
        this.clearFlushedContent(pendingAtFlushStart);
      } catch (err) {
        ctx.logger.debug(`Update failed, will create new post on next flush: ${err}`);
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
            ctx.logger.debug('Update failed (no breakpoint), will create new post on next flush');
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
            ctx.logger.debug('Update failed (code block at start)');
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
            ctx.logger.debug('Update failed (no break before code block)');
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
        ctx.logger.debug('Update failed during split, continuing with new post');
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
      const post = await ctx.createPost(content, { type: 'content' });
      this.state.currentPostId = post.id;
      this.state.currentPostContent = content;
      this.clearFlushedContent(pendingAtFlushStart);
      ctx.logger.debug(`Created post ${formatShortId(post.id)}`);
    } catch (err) {
      ctx.logger.error(`Failed to create post: ${err}`);
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
