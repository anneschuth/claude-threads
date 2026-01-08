/**
 * Message streaming and flushing utilities
 *
 * Handles buffering, formatting, and posting Claude responses to the platform.
 * Implements logical message breaking to avoid content collapse on chat platforms.
 */

import type { PlatformClient, PlatformFile } from '../platform/index.js';
import { truncateMessageSafely } from '../platform/utils.js';
import type { Session } from './types.js';
import type { ContentBlock } from '../claude/cli.js';
import { createLogger } from '../utils/logger.js';
import { withErrorHandling } from './error-handler.js';
import { updateLastMessage } from './post-helpers.js';
import {
  bumpTasksToBottomWithContent,
  hasActiveTasks,
  bumpPlanApprovalToBottom,
} from './sticky-thread.js';

// Re-export for backward compatibility
export { acquireStickyLock as acquireTaskListLock } from './sticky-thread.js';
export { bumpTasksToBottom, bumpTasksToBottomWithContent } from './sticky-thread.js';

const log = createLogger('streaming');

/** Get session-scoped logger for routing to correct UI panel */
function sessionLog(session: Session) {
  return log.forSession(session.sessionId);
}

// ---------------------------------------------------------------------------
// Message breaking thresholds
// ---------------------------------------------------------------------------

/**
 * Soft threshold: when content exceeds this, we look for logical breakpoints.
 * This is lower than the hard limit to avoid content collapse on chat platforms.
 * Many platforms collapse long messages (e.g., at ~300 chars or 5 line breaks).
 */
export const SOFT_BREAK_THRESHOLD = 2000;

/**
 * Minimum content size before we consider breaking.
 * Prevents breaking very short messages unnecessarily.
 */
export const MIN_BREAK_THRESHOLD = 500;

/**
 * Maximum lines before we look for a break point.
 * Some platforms collapse at ~5 lines, so we break well before reaching that.
 */
export const MAX_LINES_BEFORE_BREAK = 15;

// ---------------------------------------------------------------------------
// Logical breakpoint detection
// ---------------------------------------------------------------------------

/**
 * Types of logical breakpoints in content.
 */
export type BreakpointType =
  | 'heading'        // Markdown heading (## or ###)
  | 'code_block_end' // End of a code block
  | 'paragraph'      // Empty line (paragraph break)
  | 'tool_marker'    // Tool result marker (  ↳ ✓ or ❌)
  | 'none';

/**
 * Information about code block state at a position.
 */
export interface CodeBlockInfo {
  /** Whether we're inside an open code block */
  isInside: boolean;
  /** The language of the code block (e.g., 'diff', 'typescript') */
  language?: string;
  /** Position of the opening ``` in the content */
  openPosition?: number;
}

/**
 * Check if a position is inside an open code block.
 * Counts ``` markers from the start to determine if we're inside a block.
 *
 * @param content - The full content string
 * @param position - Position to check
 * @returns Information about code block state at that position
 */
export function getCodeBlockState(content: string, position: number): CodeBlockInfo {
  const textUpToPosition = content.substring(0, position);

  // Find all code block markers (```) - they appear at line start or after newline
  const markers: { index: number; isOpening: boolean; language?: string }[] = [];
  const markerRegex = /^```(\w*)?$/gm;
  let match;

  while ((match = markerRegex.exec(textUpToPosition)) !== null) {
    const isOpening = markers.length === 0 || !markers[markers.length - 1].isOpening;
    markers.push({
      index: match.index,
      isOpening,
      language: isOpening ? match[1] : undefined,
    });
  }

  // If odd number of markers, we're inside a code block
  if (markers.length > 0 && markers.length % 2 === 1) {
    const lastMarker = markers[markers.length - 1];
    return {
      isInside: true,
      language: lastMarker.language,
      openPosition: lastMarker.index,
    };
  }

  return { isInside: false };
}

/**
 * Find the best logical breakpoint in content near or after a position.
 * Returns the position to break at, or -1 if no good breakpoint found.
 *
 * IMPORTANT: This function now checks if we're inside a code block and
 * prioritizes finding the end of that block before breaking.
 *
 * @param content - The full content string
 * @param startPos - Position to start looking from
 * @param maxLookAhead - How far ahead to look for a breakpoint (default 500 chars)
 * @returns Object with break position and type, or null if not found
 */
export function findLogicalBreakpoint(
  content: string,
  startPos: number,
  maxLookAhead: number = 500
): { position: number; type: BreakpointType } | null {
  const searchWindow = content.substring(startPos, startPos + maxLookAhead);

  // First, check if we're inside an open code block at startPos
  const codeBlockState = getCodeBlockState(content, startPos);

  if (codeBlockState.isInside) {
    // We're inside a code block - we MUST find its closing ``` before breaking
    // Look for the closing ``` in the search window
    const codeBlockEndMatch = searchWindow.match(/^```$/m);
    if (codeBlockEndMatch && codeBlockEndMatch.index !== undefined) {
      // Found the end - break AFTER the closing ```
      const pos = startPos + codeBlockEndMatch.index + codeBlockEndMatch[0].length;
      // Also skip any trailing newline
      const nextChar = content[pos];
      const finalPos = nextChar === '\n' ? pos + 1 : pos;
      return { position: finalPos, type: 'code_block_end' };
    }

    // No closing found in window - return null to indicate we can't safely break here
    // The caller (flush) will need to handle this by either:
    // 1. Extending the search window
    // 2. Force-breaking with proper code block closure/reopening
    return null;
  }

  // Not inside a code block - use normal breakpoint logic
  // But validate that each potential breakpoint is not inside a code block

  // Priority 1: Look for tool result markers (natural tool completion boundary)
  // These look like "  ↳ ✓" or "  ↳ ❌ Error"
  const toolMarkerMatch = searchWindow.match(/ {2}↳ [✓❌][^\n]*\n/);
  if (toolMarkerMatch && toolMarkerMatch.index !== undefined) {
    const pos = startPos + toolMarkerMatch.index + toolMarkerMatch[0].length;
    // Verify we're not inside a code block at this position
    if (!getCodeBlockState(content, pos).isInside) {
      return { position: pos, type: 'tool_marker' };
    }
  }

  // Priority 2: Look for markdown headings (section boundaries)
  const headingMatch = searchWindow.match(/\n(#{2,3} )/);
  if (headingMatch && headingMatch.index !== undefined) {
    const pos = startPos + headingMatch.index;
    // Verify we're not inside a code block at this position
    if (!getCodeBlockState(content, pos).isInside) {
      return { position: pos, type: 'heading' };
    }
  }

  // Priority 3: Look for end of code blocks
  const codeBlockEndMatch = searchWindow.match(/^```$/m);
  if (codeBlockEndMatch && codeBlockEndMatch.index !== undefined) {
    const pos = startPos + codeBlockEndMatch.index + codeBlockEndMatch[0].length;
    const nextChar = content[pos];
    const finalPos = nextChar === '\n' ? pos + 1 : pos;
    return { position: finalPos, type: 'code_block_end' };
  }

  // Priority 4: Look for paragraph breaks (double newlines)
  const paragraphMatch = searchWindow.match(/\n\n/);
  if (paragraphMatch && paragraphMatch.index !== undefined) {
    const pos = startPos + paragraphMatch.index + paragraphMatch[0].length;
    // Verify we're not inside a code block at this position
    if (!getCodeBlockState(content, pos).isInside) {
      return { position: pos, type: 'paragraph' };
    }
  }

  // Priority 5: Fallback to any line break (but not inside code blocks)
  const lineBreakMatch = searchWindow.match(/\n/);
  if (lineBreakMatch && lineBreakMatch.index !== undefined) {
    const pos = startPos + lineBreakMatch.index + 1;
    // Verify we're not inside a code block at this position
    if (!getCodeBlockState(content, pos).isInside) {
      return { position: pos, type: 'none' };
    }
  }

  return null;
}

/**
 * Check if content should be flushed early based on logical breakpoints.
 * Returns true if we should flush now to avoid "Show More" collapse.
 *
 * @param content - Current pending content
 * @returns Whether to flush early
 */
export function shouldFlushEarly(content: string): boolean {
  // Count lines
  const lineCount = (content.match(/\n/g) || []).length;

  // Check against thresholds
  if (content.length >= SOFT_BREAK_THRESHOLD) return true;
  if (lineCount >= MAX_LINES_BEFORE_BREAK) return true;

  return false;
}

/**
 * Check if content ends at a logical breakpoint.
 * Used to detect when incoming content creates a natural break.
 *
 * @param content - Content to check
 * @returns The type of breakpoint at the end, or 'none'
 */
export function endsAtBreakpoint(content: string): BreakpointType {
  const trimmed = content.trimEnd();

  // Check for tool result marker at end
  if (/ {2}↳ [✓❌][^\n]*$/.test(trimmed)) {
    return 'tool_marker';
  }

  // Check for end of code block
  if (trimmed.endsWith('```')) {
    return 'code_block_end';
  }

  // Check for paragraph break at end (double newline)
  if (content.endsWith('\n\n')) {
    return 'paragraph';
  }

  return 'none';
}

// ---------------------------------------------------------------------------
// Scheduled updates
// ---------------------------------------------------------------------------

/**
 * Schedule a delayed flush of the session's pending content.
 * If an update is already scheduled, this is a no-op.
 *
 * Used during streaming to batch updates and avoid excessive API calls.
 */
export function scheduleUpdate(session: Session, onFlush: (session: Session) => Promise<void>): void {
  if (session.updateTimer) return;
  session.updateTimer = setTimeout(() => {
    session.updateTimer = null;
    onFlush(session);
  }, 500);
}

/**
 * Build message content for Claude, including images if present.
 * Returns either a string or an array of content blocks.
 *
 * @param text - The text message
 * @param platform - Platform client for downloading images
 * @param files - Optional files attached to the message
 * @param debug - Whether to log debug info
 * @returns Plain string or content blocks array with images
 */
export async function buildMessageContent(
  text: string,
  platform: PlatformClient,
  files?: PlatformFile[],
  debug: boolean = false
): Promise<string | ContentBlock[]> {
  // Filter to only image files
  const imageFiles = files?.filter(f =>
    f.mimeType.startsWith('image/') &&
    ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(f.mimeType)
  ) || [];

  // If no images, return plain text
  if (imageFiles.length === 0) {
    return text;
  }

  // Build content blocks with images
  const blocks: ContentBlock[] = [];

  // Download and add each image
  for (const file of imageFiles) {
    try {
      if (!platform.downloadFile) {
        log.warn(`Platform does not support file downloads, skipping ${file.name}`);
        continue;
      }
      const buffer = await platform.downloadFile(file.id);
      const base64 = buffer.toString('base64');

      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: file.mimeType,
          data: base64,
        },
      });

      if (debug) {
        log.debug(`Attached image: ${file.name} (${file.mimeType}, ${Math.round(buffer.length / 1024)}KB)`);
      }
    } catch (err) {
      log.error(`Failed to download image ${file.name}: ${err}`);
    }
  }

  // Add the text message
  if (text) {
    blocks.push({
      type: 'text',
      text,
    });
  }

  return blocks;
}

/**
 * Start sending typing indicators to the platform.
 * Sends immediately, then every 3 seconds until stopped.
 */
export function startTyping(session: Session): void {
  if (session.typingTimer) return;
  // Send typing immediately, then every 3 seconds
  session.platform.sendTyping(session.threadId);
  session.typingTimer = setInterval(() => {
    session.platform.sendTyping(session.threadId);
  }, 3000);
}

/**
 * Stop sending typing indicators.
 */
export function stopTyping(session: Session): void {
  if (session.typingTimer) {
    clearInterval(session.typingTimer);
    session.typingTimer = null;
  }
}

/**
 * Flush pending content to the platform.
 *
 * Handles:
 * - Logical message breaking (headings, tool results, code blocks)
 * - Soft threshold breaking to avoid "Show More" collapse
 * - Hard message length limits (splits into multiple posts if needed)
 * - Creating vs updating posts
 * - Post registration for reaction routing
 * - Keeping task list at the bottom (sticky tasks)
 *
 * @param session - The session to flush
 * @param registerPost - Callback to register post for reaction routing
 */
export async function flush(
  session: Session,
  registerPost: (postId: string, threadId: string) => void
): Promise<void> {
  if (!session.pendingContent.trim()) {
    return;  // No content to flush - silent return
  }

  // Format markdown for the target platform
  // This converts standard markdown to the platform's native format
  const formatter = session.platform.getFormatter();
  let content = formatter.formatMarkdown(session.pendingContent).trim();

  // Get platform-specific message size limits
  const { maxLength: MAX_POST_LENGTH, hardThreshold: HARD_CONTINUATION_THRESHOLD } =
    session.platform.getMessageLimits();

  // Check if we should break early based on logical breakpoints
  // This helps avoid "Show More" collapse on some platforms
  const shouldBreakEarly = session.currentPostId &&
    content.length > MIN_BREAK_THRESHOLD &&
    shouldFlushEarly(content);

  // Check if we need to start a new message due to length or logical breakpoint
  if (session.currentPostId && (content.length > HARD_CONTINUATION_THRESHOLD || shouldBreakEarly)) {
    // Capture the post ID - we've confirmed it's truthy in the condition above
    const currentPostId = session.currentPostId;

    // Determine where to break
    let breakPoint: number;

    // Track if we're breaking inside a code block (so we can move it to next message)
    let codeBlockLanguage: string | undefined;
    let codeBlockOpenPosition: number | undefined;

    if (content.length > HARD_CONTINUATION_THRESHOLD) {
      // Hard break: we're at the limit, must break now
      // Try to find a logical breakpoint near the threshold
      const startSearchPos = Math.floor(HARD_CONTINUATION_THRESHOLD * 0.7);
      const breakInfo = findLogicalBreakpoint(
        content,
        startSearchPos,
        Math.floor(HARD_CONTINUATION_THRESHOLD * 0.3)
      );
      if (breakInfo) {
        breakPoint = breakInfo.position;
      } else {
        // findLogicalBreakpoint returned null - we might be inside a code block
        // Check if we're inside a code block at the desired break position
        const codeBlockState = getCodeBlockState(content, startSearchPos);

        if (codeBlockState.isInside) {
          // We're inside a code block and can't find its end within the lookahead
          // We'll split before the code block so it moves to the next message
          codeBlockLanguage = codeBlockState.language;
          codeBlockOpenPosition = codeBlockState.openPosition;
          // Temporary breakPoint - will be overridden below to split before code block
          breakPoint = HARD_CONTINUATION_THRESHOLD;
        } else {
          // Not inside a code block, just couldn't find a good breakpoint
          // Fallback: find any line break
          breakPoint = content.lastIndexOf('\n', HARD_CONTINUATION_THRESHOLD);
          if (breakPoint < HARD_CONTINUATION_THRESHOLD * 0.7) {
            breakPoint = HARD_CONTINUATION_THRESHOLD;
          }
        }
      }
    } else {
      // Soft break: we've exceeded soft threshold, find a good logical breakpoint
      const breakInfo = findLogicalBreakpoint(content, SOFT_BREAK_THRESHOLD);
      if (breakInfo && breakInfo.position < content.length) {
        breakPoint = breakInfo.position;
      } else {
        // No good breakpoint found, just update the current post and wait
        try {
          await session.platform.updatePost(currentPostId, content);
        } catch {
          // Update failed - post may have been deleted. Clear the post ID
          // so the next flush will create a new post instead of retrying.
          sessionLog(session).debug('Update failed (no breakpoint), will create new post on next flush');
          session.currentPostId = null;
        }
        return;
      }
    }

    // If we're inside a code block, split BEFORE the code block starts
    // so the entire code block moves to the next message
    if (codeBlockLanguage !== undefined && codeBlockOpenPosition !== undefined) {
      if (codeBlockOpenPosition === 0) {
        // Code block is at the very start, can't split before it - just update and wait
        try {
          await session.platform.updatePost(currentPostId, content);
        } catch {
          sessionLog(session).debug('Update failed (code block at start), will create new post on next flush');
          session.currentPostId = null;
        }
        return;
      }

      // Find the last newline before the code block to get a clean break
      const breakBeforeCodeBlock = content.lastIndexOf('\n', codeBlockOpenPosition);
      if (breakBeforeCodeBlock > 0) {
        breakPoint = breakBeforeCodeBlock;
      } else {
        // No good break point before the code block - just update and wait
        try {
          await session.platform.updatePost(currentPostId, content);
        } catch {
          sessionLog(session).debug('Update failed (no break before code block), will create new post on next flush');
          session.currentPostId = null;
        }
        return;
      }
    }

    // Split at the breakpoint
    const firstPart = content.substring(0, breakPoint).trim();
    const remainder = content.substring(breakPoint).trim();

    // Update the current post with the first part
    try {
      await session.platform.updatePost(currentPostId, firstPart);
    } catch {
      // Update failed - post may have been deleted. Log at debug level since
      // we're about to start a new post anyway, so this is not critical.
      sessionLog(session).debug('Update failed during split, continuing with new post');
    }

    // Start a new post for the continuation
    session.currentPostId = null;
    session.pendingContent = remainder;

    // Create the continuation post if there's content
    if (remainder) {
      // Bump plan approval first if pending (keep it at bottom)
      await bumpPlanApprovalToBottom(session, registerPost);

      // If we have an active (non-completed) task list, reuse its post and bump it to the bottom
      if (hasActiveTasks(session)) {
        const postId = await bumpTasksToBottomWithContent(session, remainder, registerPost);
        session.currentPostId = postId;
      } else {
        const post = await withErrorHandling(
          () => session.platform.createPost(remainder, session.threadId),
          { action: 'Create continuation post', session }
        );
        if (post) {
          session.currentPostId = post.id;
          registerPost(post.id, session.threadId);
          updateLastMessage(session, post);
        }
      }
    }
    return;
  }

  // Normal case: content fits in current post
  if (content.length > MAX_POST_LENGTH) {
    // Safety truncation if we somehow got content that's still too long
    sessionLog(session).warn(`Content too long (${content.length}), truncating`);
    const formatter = session.platform.getFormatter();
    content = truncateMessageSafely(
      content,
      MAX_POST_LENGTH,
      formatter.formatItalic('... (truncated)')
    );
  }

  if (session.currentPostId) {
    const postId = session.currentPostId;
    try {
      await session.platform.updatePost(postId, content);
    } catch {
      // Update failed - post may have been deleted. Clear the post ID
      // so the next flush will create a new post instead of retrying.
      sessionLog(session).debug('Update failed, will create new post on next flush');
      session.currentPostId = null;
    }
  } else {
    // Need to create a new post
    // Bump plan approval first if pending (keep it at bottom)
    await bumpPlanApprovalToBottom(session, registerPost);

    // If we have an active (non-completed) task list, reuse its post and bump it to the bottom
    if (hasActiveTasks(session)) {
      const postId = await bumpTasksToBottomWithContent(session, content, registerPost);
      session.currentPostId = postId;
    } else {
      const post = await withErrorHandling(
        () => session.platform.createPost(content, session.threadId),
        { action: 'Create new post', session }
      );
      if (post) {
        session.currentPostId = post.id;
        sessionLog(session).debug(`Created post ${post.id.substring(0, 8)}`);
        // Register post for reaction routing
        registerPost(post.id, session.threadId);
        // Track for jump-to-bottom links
        updateLastMessage(session, post);
      }
    }
  }
}
