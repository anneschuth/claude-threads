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
import { MIN_BREAK_THRESHOLD, splitContentForHeight } from '../content-breaker.js';
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
  onBumpTaskList?: (content: string, ctx: ExecutorContext) => Promise<string | null>;
  /** Callback to bump task list to bottom (without repurposing) */
  onBumpTaskListToBottom?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Content Executor
// ---------------------------------------------------------------------------

/**
 * Executor for content operations.
 */
export class ContentExecutor extends BaseExecutor<ContentState> {
  private onBumpTaskList?: (content: string, ctx: ExecutorContext) => Promise<string | null>;
  private onBumpTaskListToBottom?: () => Promise<void>;

  constructor(options: ContentExecutorOptions) {
    super(options, ContentExecutor.createInitialState());
    this.onBumpTaskList = options.onBumpTaskList;
    this.onBumpTaskListToBottom = options.onBumpTaskListToBottom;
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
  closeCurrentPost(ctx?: ExecutorContext): void {
    const oldPostId = this.state.currentPostId;
    const contentLength = this.state.currentPostContent.length;
    this.state.currentPostId = null;
    this.state.currentPostContent = '';
    if (ctx?.threadLogger && oldPostId) {
      ctx.threadLogger.logExecutor('content', 'close', oldPostId, {
        contentLength,
        reason: 'closeCurrentPost'
      }, 'closeCurrentPost');
    }
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

    // Calculate combined content (what the post should contain after update)
    // This is needed for handleSplit to preserve existing post content
    let combinedContent: string;
    if (this.state.currentPostId && this.state.currentPostContent) {
      const needsSeparator = !this.state.currentPostContent.endsWith('\n') && !content.startsWith('\n');
      combinedContent = needsSeparator
        ? this.state.currentPostContent + '\n\n' + content
        : this.state.currentPostContent + content;
    } else {
      combinedContent = content;
    }

    // Check if we should break early (based on COMBINED content height)
    const shouldBreakEarly = this.state.currentPostId &&
      combinedContent.length > MIN_BREAK_THRESHOLD &&
      ctx.contentBreaker.shouldFlushEarly(combinedContent);

    // Handle message splitting - use combinedContent so existing post content is preserved
    if (this.state.currentPostId && (combinedContent.length > HARD_CONTINUATION_THRESHOLD || shouldBreakEarly)) {
      await this.handleSplit(ctx, combinedContent, pendingAtFlushStart, HARD_CONTINUATION_THRESHOLD);
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

      // Calculate combined content first to check if it would exceed limit
      let combinedContent: string;
      if (this.state.currentPostContent) {
        const needsSeparator = !this.state.currentPostContent.endsWith('\n') && !content.startsWith('\n');
        combinedContent = needsSeparator
          ? this.state.currentPostContent + '\n\n' + content
          : this.state.currentPostContent + content;
      } else {
        combinedContent = content;
      }

      // If combined content would exceed MAX_POST_LENGTH, start a new post
      // This prevents content loss when updatePost fails with msg_too_long
      if (combinedContent.length > MAX_POST_LENGTH) {
        ctx.logger.debug(`Combined content (${combinedContent.length}) would exceed max (${MAX_POST_LENGTH}), creating continuation post`);
        ctx.threadLogger?.logExecutor('content', 'create_start', 'none', {
          contentLength: content.length,
          currentPostContentLength: this.state.currentPostContent.length,
          combinedLength: combinedContent.length,
          reason: 'combined_exceeds_max',
        }, 'flush');

        // Close current post and create a new one for the new content
        this.state.currentPostId = null;
        // Don't clear currentPostContent - keep it for reference in logs
        // The new post will only contain the new content, not combined
        await this.createNewPost(ctx, content, pendingAtFlushStart);
        return;
      }

      try {
        await ctx.platform.updatePost(postId, combinedContent);
        this.state.currentPostContent = combinedContent;
        this.clearFlushedContent(pendingAtFlushStart);
        ctx.threadLogger?.logExecutor('content', 'update', postId, {
          newContentLength: content.length,
          combinedLength: combinedContent.length,
        }, 'flush');
      } catch (err) {
        ctx.logger.debug(`Update failed, will create new post on next flush: ${err}`);
        ctx.threadLogger?.logExecutor('content', 'error', postId, {
          failedOp: 'updatePost',
          error: String(err),
        }, 'flush');
        this.state.currentPostId = null;
        this.state.currentPostContent = '';
      }
    } else {
      // Create new post(s) - split if content is too tall
      const chunks = splitContentForHeight(content, ctx.contentBreaker);
      ctx.threadLogger?.logExecutor('content', 'create_start', 'none', {
        contentLength: content.length,
        chunkCount: chunks.length,
        reason: 'no_currentPostId',
      }, 'flush');

      for (let i = 0; i < chunks.length; i++) {
        await this.createNewPost(ctx, chunks[i], pendingAtFlushStart);
        // Reset for next chunk so it creates a new post
        // But keep state for the last chunk so getCurrentPostContent() works
        if (i < chunks.length - 1) {
          this.state.currentPostId = null;
          this.state.currentPostContent = '';
        }
      }
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
      // Soft break (height-based) - find a breakpoint where first part fits under height threshold
      // We need to find the LAST good breakpoint where firstPart is still under threshold
      const goodBreakpointTypes = new Set(['paragraph', 'code_block_end', 'heading', 'tool_marker']);
      let bestBreakPoint: number | null = null;

      // Iterate through breakpoints to find the best one (largest first part that fits)
      let searchStart = 0;
      while (searchStart < content.length) {
        const breakInfo = ctx.contentBreaker.findLogicalBreakpoint(content, searchStart, content.length - searchStart);
        if (!breakInfo || breakInfo.position <= searchStart || breakInfo.position >= content.length) {
          break;
        }

        // Only consider good breakpoint types
        if (!goodBreakpointTypes.has(breakInfo.type)) {
          searchStart = breakInfo.position + 1;
          continue;
        }

        const firstPart = content.substring(0, breakInfo.position).trim();
        // Use height-only check to maximize content per chunk
        if (!ctx.contentBreaker.exceedsHeightThreshold(firstPart)) {
          // This breakpoint gives us a first part that fits - remember it
          bestBreakPoint = breakInfo.position;
        }

        searchStart = breakInfo.position + 1;
      }

      if (bestBreakPoint !== null && bestBreakPoint > 0) {
        breakPoint = bestBreakPoint;
      } else {
        // No good breakpoint - just update current post with ALL content
        // We must update the post AND update state to prevent duplication on next flush
        if (this.state.currentPostId) {
          try {
            await ctx.platform.updatePost(this.state.currentPostId, content);
            // CRITICAL: Update state to match what's in the post
            this.state.currentPostContent = content;
            this.clearFlushedContent(pendingAtFlushStart);
            ctx.threadLogger?.logExecutor('content', 'update', this.state.currentPostId, {
              reason: 'soft_break_no_breakpoint',
              contentLength: content.length,
            }, 'handleSplit');
          } catch {
            ctx.logger.debug('Update failed (no breakpoint), will create new post on next flush');
            ctx.threadLogger?.logExecutor('content', 'error', this.state.currentPostId, {
              reason: 'soft_break_no_breakpoint_failed',
            }, 'handleSplit');
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
            // CRITICAL: Update state to match what's in the post to prevent duplication
            this.state.currentPostContent = content;
            this.clearFlushedContent(pendingAtFlushStart);
            ctx.threadLogger?.logExecutor('content', 'update', this.state.currentPostId, {
              reason: 'code_block_at_start',
              contentLength: content.length,
            }, 'handleSplit');
          } catch {
            ctx.logger.debug('Update failed (code block at start)');
            ctx.threadLogger?.logExecutor('content', 'error', this.state.currentPostId, {
              reason: 'code_block_at_start_failed',
            }, 'handleSplit');
            this.state.currentPostId = null;
            this.state.currentPostContent = '';
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
            // CRITICAL: Update state to match what's in the post to prevent duplication
            this.state.currentPostContent = content;
            this.clearFlushedContent(pendingAtFlushStart);
            ctx.threadLogger?.logExecutor('content', 'update', this.state.currentPostId, {
              reason: 'no_break_before_code_block',
              contentLength: content.length,
            }, 'handleSplit');
          } catch {
            ctx.logger.debug('Update failed (no break before code block)');
            ctx.threadLogger?.logExecutor('content', 'error', this.state.currentPostId, {
              reason: 'no_break_before_code_block_failed',
            }, 'handleSplit');
            this.state.currentPostId = null;
            this.state.currentPostContent = '';
          }
        }
        return;
      }
    }

    // Split content
    const firstPart = content.substring(0, breakPoint).trim();
    const remainder = content.substring(breakPoint).trim();

    // Update current post with first part
    // Note: We use firstPart directly, NOT combined with currentPostContent.
    // This is because `content` already represents all pending content, and firstPart
    // is the portion that should be in this post. Combining would cause duplication
    // since pendingContent accumulates and isn't always cleared properly.
    if (this.state.currentPostId) {
      try {
        await ctx.platform.updatePost(this.state.currentPostId, firstPart);
        ctx.threadLogger?.logExecutor('content', 'update', this.state.currentPostId, {
          reason: 'split_first_part',
          firstPartLength: firstPart.length,
          remainderLength: remainder.length,
        }, 'handleSplit');
      } catch {
        ctx.logger.debug('Update failed during split, continuing with new post');
        ctx.threadLogger?.logExecutor('content', 'error', this.state.currentPostId, {
          reason: 'split_first_part_failed',
        }, 'handleSplit');
      }
    }

    // Start new post for remainder
    // NOTE: Do NOT set pendingContent = remainder here!
    // That would overwrite any new content that arrived during the async updatePost.
    // Instead, createNewPost will call clearFlushedContent(pendingAtFlushStart) which
    // properly clears only the flushed content while preserving any new content.
    this.state.currentPostId = null;
    this.state.currentPostContent = '';

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
    // Try to bump task list first - this reuses the old task list post for content
    if (this.onBumpTaskList) {
      const bumpedPostId = await this.onBumpTaskList(content, ctx);
      if (bumpedPostId) {
        this.state.currentPostId = bumpedPostId;
        this.state.currentPostContent = content;
        this.clearFlushedContent(pendingAtFlushStart);
        ctx.threadLogger?.logExecutor('content', 'create', bumpedPostId, {
          method: 'bump_repurpose',
          contentLength: content.length,
        }, 'createNewPost');

        // ALWAYS bump task list to bottom after using repurposed post
        // This ensures task list is recreated at the bottom
        if (this.onBumpTaskListToBottom) {
          await this.onBumpTaskListToBottom();
        }
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
      ctx.threadLogger?.logExecutor('content', 'create', post.id, {
        method: 'new_post',
        contentLength: content.length,
      }, 'createNewPost');

      // Bump task list to bottom after creating content post
      // This ensures task list always stays at the bottom of the thread
      if (this.onBumpTaskListToBottom) {
        await this.onBumpTaskListToBottom();
      }
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
