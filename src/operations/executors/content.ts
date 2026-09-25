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
      header: null,
      headerDirty: false,
      headerPostId: null,
      headerBody: '',
      turnOpen: false,
      paragraphBreak: false,
    };
  }

  /**
   * Set the one-line header that rides on the first post of the current
   * turn (the tool-activity summary; docs/quiet-tools-spec.md). `null`
   * removes it. The first header of a turn adopts the current post, or the
   * next post created; the header is rendered on the next flush, which
   * happens even with nothing else pending.
   */
  setHeader(line: string | null): void {
    if (!this.state.turnOpen) {
      this.state.turnOpen = true;
      this.state.headerPostId = this.state.currentPostId;
      this.state.headerBody = this.state.currentPostContent;
    }
    this.state.header = line;
    this.state.headerDirty = true;
  }

  /** The post the current turn's header lives on, once it exists. */
  getHeaderPostId(): string | null {
    return this.state.headerPostId;
  }

  /**
   * Give up the current turn's header post. `turnOpen` and `headerPostId`
   * otherwise clear only on a `result` flush, and a Claude respawn mid-turn
   * never produces one — so the next turn's summary would edit the abandoned
   * reply and its details would thread under it (Codex review). The post
   * keeps whatever header it last rendered: the turn is dead, and rewriting
   * it during a respawn is not worth a platform call.
   */
  abandonHeaderTurn(): void {
    this.state.header = null;
    this.state.headerDirty = false;
    this.state.headerPostId = null;
    this.state.headerBody = '';
    this.state.turnOpen = false;
  }

  /**
   * The current post's text exactly as it stands on the platform, header
   * included. `currentPostContent` holds only the body; anything that re-sends
   * the post (the turn marker's metadata update) must send this instead, or it
   * strips the summary line, and blanks a post that held only the header.
   */
  getRenderedCurrentPost(): { postId: string; text: string } | null {
    const postId = this.state.currentPostId;
    if (!postId) return null;
    return { postId, text: this.renderFor(postId, this.state.currentPostContent) };
  }

  /** What a post's text is, given its body: the header is prepended on the header post only. */
  private renderFor(postId: string | null, body: string): string {
    if (this.state.header && postId !== null && postId === this.state.headerPostId) {
      return body ? `${this.state.header}\n\n${body}` : this.state.header;
    }
    return body;
  }

  /** Length the header adds to a post's text, for the platform limit checks. */
  private headerReserve(postId: string | null): number {
    const header = this.state.header;
    if (!header) return 0;
    const applies = postId === this.state.headerPostId || (postId === null && this.state.headerPostId === null && this.state.turnOpen);
    return applies ? header.length + 2 : 0;
  }

  /** Render the header post again after a header change with nothing pending. */
  private async renderHeaderOnly(ctx: ExecutorContext): Promise<void> {
    this.state.headerDirty = false;
    if (this.state.headerPostId) {
      const postId = this.state.headerPostId;
      await this.tryUpdatePost(
        ctx,
        postId,
        this.state.headerBody,
        'header',
        { reason: 'header_update', headerLength: this.state.header?.length ?? 0 },
        { reason: 'header_update_failed' },
        () => { /* body unchanged */ },
        () => { /* keep the post; a failed header edit is not a lost reply */ },
      );
      return;
    }
    if (this.state.header && this.state.turnOpen) {
      await this.createNewPost(ctx, '', '');
    }
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
   * Wrap `ctx.platform.updatePost` with the three-way outcome this file uses
   * repeatedly: (success: log + caller-supplied state update) vs (failure: log
   * + caller-supplied state reset). Shared fields — component name, postId,
   * threadLogger tag — are set here so call sites only specify what differs.
   *
   * Each call site's success and failure state mutation stays explicit via the
   * `onSuccess` / `onFailure` callbacks. Do NOT bake a single "correct" state
   * reset into this helper: the 5 original sites drifted (some clear
   * currentPostContent, some don't), and hiding those differences would be a
   * regression hazard.
   */
  private async tryUpdatePost(
    ctx: ExecutorContext,
    postId: string,
    content: string,
    logTag: string,
    successDetails: Record<string, unknown>,
    failureDetails: Record<string, unknown> | ((err: unknown) => Record<string, unknown>),
    onSuccess: () => void,
    onFailure: () => void,
  ): Promise<void> {
    try {
      await ctx.platform.updatePost(postId, this.renderFor(postId, content));
      if (postId === this.state.headerPostId) {
        this.state.headerBody = content;
        this.state.headerDirty = false;
      }
      onSuccess();
      ctx.threadLogger?.logExecutor('content', 'update', postId, successDetails, logTag);
    } catch (err) {
      // Whether the attempted body must be recorded is the CALL SITE's
      // decision, not this helper's, per the note above. It is right only
      // where the pending content is dropped regardless of the outcome (the
      // split's first part), and wrong on the plain update path, which leaves
      // pendingContent in place so the next flush re-posts it — recording the
      // attempt there puts the same text in both posts. `headerDirty` stays
      // set either way, so the retry still happens.
      ctx.logger.debug(`Update failed (${logTag}): ${err}`);
      const resolvedFailureDetails = typeof failureDetails === 'function'
        ? failureDetails(err)
        : failureDetails;
      ctx.threadLogger?.logExecutor('content', 'error', postId, resolvedFailureDetails, logTag);
      onFailure();
    }
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
  /**
   * A tool ran whose line does not go into the reply (tool activity summary
   * or hidden). Without its line the text on either side would run together:
   * `Let me search.Found it.`
   */
  markParagraphBreak(): void {
    this.state.paragraphBreak = true;
  }

  async executeAppend(op: AppendContentOp, _ctx: ExecutorContext): Promise<void> {
    const breakBefore = this.state.paragraphBreak && !op.isToolOutput;
    if (!op.isToolOutput) this.state.paragraphBreak = false;
    // Tool output needs spacing before and after to separate from text; so
    // does text after a tool that was kept out of the reply.
    if ((op.isToolOutput || breakBefore) && this.state.pendingContent.length > 0) {
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
  async flush(ctx: ExecutorContext, reason: FlushOp['reason']): Promise<void> {
    if (!this.state.pendingContent.trim()) {
      if (this.state.headerDirty) await this.renderHeaderOnly(ctx);
      if (reason === 'result') this.state.turnOpen = false;
      return; // Nothing else to flush
    }
    await this.flushPending(ctx);
    // The header rides on ONE post, and this flush may have written a
    // different one — a continuation post after a split, most often the
    // result flush carrying Claude's closing text. Every path that does write
    // the header post clears `headerDirty` (tryUpdatePost, createNewPost's
    // adoption), so a still-dirty header here means the header post was left
    // untouched and would keep a stale, still-running summary forever.
    if (this.state.headerDirty) await this.renderHeaderOnly(ctx);
    // The turn is over: the next header starts a new one. The header itself
    // stays on its post.
    if (reason === 'result') this.state.turnOpen = false;
  }

  private async flushPending(ctx: ExecutorContext): Promise<void> {

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
    const reserve = this.headerReserve(this.state.currentPostId);
    if (this.state.currentPostId && (combinedContent.length + reserve > HARD_CONTINUATION_THRESHOLD || shouldBreakEarly)) {
      await this.handleSplit(ctx, combinedContent, pendingAtFlushStart, HARD_CONTINUATION_THRESHOLD);
      return;
    }

    // Normal case: content fits in current post. With no post yet, too-long
    // content is split into several new posts below instead of truncated: a
    // long burst (tool details held until the turn ends, or a reply that
    // built up while the platform refused posts) would otherwise lose
    // everything past the limit.
    if (this.state.currentPostId && content.length + reserve > MAX_POST_LENGTH) {
      ctx.logger.warn(`Content too long (${content.length}), truncating`);
      content = truncateMessageSafely(
        content,
        MAX_POST_LENGTH - reserve,
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
      if (combinedContent.length + reserve > MAX_POST_LENGTH) {
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

      await this.tryUpdatePost(
        ctx,
        postId,
        combinedContent,
        'flush',
        { newContentLength: content.length, combinedLength: combinedContent.length },
        // Preserve the pre-refactor thread-log shape: the flush path includes
        // the exception text so operators can diagnose updatePost failures
        // without cross-referencing the debug log.
        (err) => ({ failedOp: 'updatePost', error: String(err) }),
        () => {
          this.state.currentPostContent = combinedContent;
          this.clearFlushedContent(pendingAtFlushStart);
        },
        () => {
          this.state.currentPostId = null;
          this.state.currentPostContent = '';
        },
      );
    } else {
      // Create new post(s) - split if content is too tall
      // Only a chunk that cannot fit a post at all is cut by length: below
      // the platform limit one post is what it always was, and a code block
      // must not be split just for passing the soft threshold.
      const chunks = splitContentForHeight(content, ctx.contentBreaker)
        .flatMap((chunk) => (chunk.length + reserve > MAX_POST_LENGTH
          ? splitByLength(chunk, HARD_CONTINUATION_THRESHOLD - reserve)
          : [chunk]));
      ctx.threadLogger?.logExecutor('content', 'create_start', 'none', {
        contentLength: content.length,
        chunkCount: chunks.length,
        reason: 'no_currentPostId',
      }, 'flush');

      await this.postChunks(ctx, chunks, pendingAtFlushStart, false);
    }
  }

  /**
   * Post `chunks` as consecutive new posts.
   *
   * `flushCleared` says whether this flush is already out of pending (the
   * split's first part landed in the current post, so what remains to deliver
   * is exactly these chunks). Otherwise the first successful post clears it;
   * every later one would find pending no longer starting with the flush and
   * wipe everything, including text Claude streamed meanwhile.
   *
   * Stops at the first refused chunk. Once the flush is out of pending, the
   * refused chunk and the rest go back in front of whatever arrived since, or
   * they are lost; before that, pending still holds them. Either way no post
   * is current afterwards: the next flush then takes the no-post path and
   * splits the put-back text into posts that fit, where resuming on the last
   * post sent it through the update path (Slack truncated the result,
   * Mattermost refused it and it was posted twice later).
   */
  private async postChunks(
    ctx: ExecutorContext,
    chunks: string[],
    pendingAtFlushStart: string,
    flushCleared: boolean,
  ): Promise<void> {
    let cleared = flushCleared;
    for (let i = 0; i < chunks.length; i++) {
      const created = await this.createNewPost(ctx, chunks[i], cleared ? '' : pendingAtFlushStart);
      if (!created) {
        if (cleared) {
          this.state.pendingContent = chunks.slice(i).join('\n\n')
            + (this.state.pendingContent ? `\n\n${this.state.pendingContent}` : '');
        }
        this.state.currentPostId = null;
        this.state.currentPostContent = '';
        return;
      }
      cleared = true;
      // Reset for next chunk so it creates a new post
      // But keep state for the last chunk so getCurrentPostContent() works
      if (i < chunks.length - 1) {
        this.state.currentPostId = null;
        this.state.currentPostContent = '';
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
        // No good breakpoint - just update current post with ALL content.
        // We must update the post AND update state to prevent duplication on next flush.
        // Failure branch nulls postId but deliberately leaves currentPostContent intact
        // (unlike other sites) so the existing content is preserved for the continuation.
        if (this.state.currentPostId) {
          const postId = this.state.currentPostId;
          await this.tryUpdatePost(
            ctx,
            postId,
            content,
            'handleSplit',
            { reason: 'soft_break_no_breakpoint', contentLength: content.length },
            { reason: 'soft_break_no_breakpoint_failed' },
            () => {
              // CRITICAL: Update state to match what's in the post
              this.state.currentPostContent = content;
              this.clearFlushedContent(pendingAtFlushStart);
            },
            () => {
              this.state.currentPostId = null;
            },
          );
        }
        return;
      }
    }

    // Split at code block start if needed
    if (codeBlockOpenPosition !== undefined) {
      if (codeBlockOpenPosition === 0) {
        // Code block at start - just update and wait.
        if (this.state.currentPostId) {
          const postId = this.state.currentPostId;
          await this.tryUpdatePost(
            ctx,
            postId,
            content,
            'handleSplit',
            { reason: 'code_block_at_start', contentLength: content.length },
            { reason: 'code_block_at_start_failed' },
            () => {
              // CRITICAL: Update state to match what's in the post to prevent duplication
              this.state.currentPostContent = content;
              this.clearFlushedContent(pendingAtFlushStart);
            },
            () => {
              this.state.currentPostId = null;
              this.state.currentPostContent = '';
            },
          );
        }
        return;
      }

      const breakBeforeCodeBlock = content.lastIndexOf('\n', codeBlockOpenPosition);
      if (breakBeforeCodeBlock > 0) {
        breakPoint = breakBeforeCodeBlock;
      } else {
        if (this.state.currentPostId) {
          const postId = this.state.currentPostId;
          await this.tryUpdatePost(
            ctx,
            postId,
            content,
            'handleSplit',
            { reason: 'no_break_before_code_block', contentLength: content.length },
            { reason: 'no_break_before_code_block_failed' },
            () => {
              // CRITICAL: Update state to match what's in the post to prevent duplication
              this.state.currentPostContent = content;
              this.clearFlushedContent(pendingAtFlushStart);
            },
            () => {
              this.state.currentPostId = null;
              this.state.currentPostContent = '';
            },
          );
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
    let firstPartLanded = false;
    if (this.state.currentPostId) {
      const postId = this.state.currentPostId;
      // Split first part: the caller nulls currentPostId and clears
      // currentPostContent below to start fresh for the remainder either way.
      await this.tryUpdatePost(
        ctx,
        postId,
        firstPart,
        'handleSplit',
        { reason: 'split_first_part', firstPartLength: firstPart.length, remainderLength: remainder.length },
        { reason: 'split_first_part_failed' },
        () => { firstPartLanded = true; },
        () => {
          // Record the attempted body HERE, where it is right: the caller
          // drops the pending content below whether or not this write landed,
          // so a later header render is the only chance to restore firstPart.
          // The write may also have arrived and only its response been lost,
          // and an update replaces the whole post, so restoring the attempt is
          // correct in both cases while restoring the older body would delete
          // delivered text.
          if (postId === this.state.headerPostId) {
            this.state.headerBody = firstPart;
          }
        },
      );
    }

    // Start new post for remainder
    // NOTE: Do NOT set pendingContent = remainder here!
    // That would overwrite any new content that arrived during the async updatePost.
    // The flush leaves pending through clearFlushedContent(pendingAtFlushStart),
    // which keeps anything that arrived since: below, right away when the first
    // part landed, otherwise on the first remainder post that goes through.
    this.state.currentPostId = null;
    this.state.currentPostContent = '';

    // Create continuation post(s) if there's content. A large burst can
    // leave a remainder several posts long; one post over the limit is what
    // Slack truncated and Mattermost refused (#617).
    if (remainder) {
      const MAX_POST_LENGTH = ctx.platform.getMessageLimits().maxLength;
      const reserve = this.headerReserve(null);
      const chunks = remainder.length + reserve > MAX_POST_LENGTH
        ? splitByLength(remainder, hardThreshold - reserve)
        : [remainder];
      // With the first part delivered, the flush leaves pending now, so a
      // refused remainder goes back without it: re-posting the first part
      // was the duplicate.
      if (firstPartLanded) this.clearFlushedContent(pendingAtFlushStart);
      await this.postChunks(ctx, chunks, pendingAtFlushStart, firstPartLanded);
    } else if (firstPartLanded) {
      this.clearFlushedContent(pendingAtFlushStart);
    }
  }

  /**
   * Create a new post.
   */
  /** Returns whether the post now exists; false when the platform refused it. */
  private async createNewPost(
    ctx: ExecutorContext,
    content: string,
    pendingAtFlushStart: string
  ): Promise<boolean> {
    // The first post of a turn with a header carries it (docs/quiet-tools-spec.md).
    const header = this.state.header;
    const becomesHeaderPost = this.state.turnOpen && this.state.headerPostId === null && header !== null;
    const rendered = becomesHeaderPost && header !== null ? (content ? `${header}\n\n${content}` : header) : content;
    const adoptAsHeaderPost = (postId: string) => {
      if (becomesHeaderPost) {
        this.state.headerPostId = postId;
        this.state.headerBody = content;
        this.state.headerDirty = false;
      }
    };

    // Try to bump task list first - this reuses the old task list post for content
    if (this.onBumpTaskList) {
      const bumpedPostId = await this.onBumpTaskList(rendered, ctx);
      if (bumpedPostId) {
        adoptAsHeaderPost(bumpedPostId);
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
        return true;
      }
    }

    // Create new post
    try {
      const post = await ctx.createPost(rendered, { type: 'content' });
      adoptAsHeaderPost(post.id);
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
      return true;
    } catch (err) {
      ctx.logger.error(`Failed to create post: ${err}`);
      return false;
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

const FENCE_LINE = /^```.*$/gm;
const FENCE_CLOSE = '\n```';

/**
 * Cut `text` into pieces no longer than `max`, at a line break where one is
 * reasonably close to the limit. A code block cut in two is closed at the end
 * of one piece and reopened, with its language, at the start of the next, so
 * each post renders on its own.
 */
function splitByLength(text: string, max: number): string[] {
  const room = max - FENCE_CLOSE.length;
  if (room < 1) return [text];
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', room);
    if (cut < room * 0.5) cut = room;
    let piece = rest.slice(0, cut);
    let next = rest.slice(cut).replace(/^\n+/, '');
    const fences = piece.match(FENCE_LINE) ?? [];
    const opener = fences[fences.length - 1];
    // Reopen only when that still makes progress. A fence line as long as a
    // post (a one-line fenced blob) would otherwise be re-added in full every
    // round: a synchronous loop that froze the whole bot. Such a line is cut
    // like any other text instead.
    if (fences.length % 2 === 1 && opener !== undefined && `${opener}\n${next}`.length < rest.length) {
      piece += FENCE_CLOSE;
      next = `${opener}\n${next}`;
    }
    pieces.push(piece);
    // The loop must shrink `rest` every round; anything else is a bug, and
    // shipping the remainder beats spinning forever.
    if (next.length >= rest.length) {
      rest = next;
      break;
    }
    rest = next;
  }
  if (rest) pieces.push(rest);
  return pieces;
}
