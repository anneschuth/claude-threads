/**
 * ContentBreaker - Message breaking and logical breakpoint detection
 *
 * This module handles detecting logical breakpoints in streaming content
 * and deciding when/where to split long messages for chat platforms.
 *
 * Key responsibilities:
 * - Detect code blocks, headings, tool results, and paragraph breaks
 * - Find optimal split points that don't break code blocks
 * - Determine when content exceeds soft thresholds
 */

// ---------------------------------------------------------------------------
// Constants - Thresholds for message breaking
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
// Height Estimation Constants
// ---------------------------------------------------------------------------

/**
 * Mattermost collapses messages at ~600px rendered height.
 * We use a lower threshold with safety margin.
 */
export const MAX_HEIGHT_THRESHOLD = 500;

/**
 * Height in pixels for different content types.
 * Based on typical Mattermost rendering with default theme:
 * - Body text: 14px font, 1.5 line-height = ~21px per line
 * - Code: 13px monospace, 1.4 line-height = ~18px per line
 */
export const HEIGHT_CONSTANTS = {
  /** Regular text line height (14px * 1.5 line-height) */
  TEXT_LINE: 21,
  /** Code block line height (13px * 1.4 line-height) */
  CODE_LINE: 18,
  /** Padding around code blocks (top + bottom) */
  CODE_BLOCK_PADDING: 32,
  /** Header line height (larger font) */
  HEADER_LINE: 32,
  /** List item height (includes bullet spacing) */
  LIST_ITEM: 24,
  /** Blockquote line height */
  BLOCKQUOTE_LINE: 24,
  /** Blank line height */
  BLANK_LINE: 10,
  /** Table row height */
  TABLE_ROW: 28,
  /** Approximate characters per line before text wraps */
  CHARS_PER_LINE: 90,
};

// ---------------------------------------------------------------------------
// Types
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
 * Result of finding a logical breakpoint.
 */
export interface BreakpointResult {
  /** Position to break at */
  position: number;
  /** Type of breakpoint found */
  type: BreakpointType;
}

// ---------------------------------------------------------------------------
// ContentBreaker Interface
// ---------------------------------------------------------------------------

/**
 * Interface for content breaking logic.
 * Allows for different implementations (e.g., platform-specific).
 */
export interface ContentBreaker {
  /**
   * Check if a position is inside an open code block.
   * Counts ``` markers from the start to determine if we're inside a block.
   *
   * @param content - The full content string
   * @param position - Position to check
   * @returns Information about code block state at that position
   */
  getCodeBlockState(content: string, position: number): CodeBlockInfo;

  /**
   * Find the best logical breakpoint in content near or after a position.
   *
   * IMPORTANT: This function checks if we're inside a code block and
   * prioritizes finding the end of that block before breaking.
   *
   * @param content - The full content string
   * @param startPos - Position to start looking from
   * @param maxLookAhead - How far ahead to look for a breakpoint (default 500 chars)
   * @returns Object with break position and type, or null if not found
   */
  findLogicalBreakpoint(
    content: string,
    startPos: number,
    maxLookAhead?: number
  ): BreakpointResult | null;

  /**
   * Check if content should be flushed early based on logical breakpoints.
   * Returns true if we should flush now to avoid "Show More" collapse.
   *
   * @param content - Current pending content
   * @returns Whether to flush early
   */
  shouldFlushEarly(content: string): boolean;

  /**
   * Check if content ends at a logical breakpoint.
   * Used to detect when incoming content creates a natural break.
   *
   * @param content - Content to check
   * @returns The type of breakpoint at the end, or 'none'
   */
  endsAtBreakpoint(content: string): BreakpointType;
}

// ---------------------------------------------------------------------------
// Height Estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the rendered pixel height of markdown content.
 *
 * Mattermost collapses messages based on rendered height (~600px), not character count.
 * This function analyzes the content structure to estimate how tall it will render:
 * - Code blocks: each line ~18px + 32px padding per block
 * - Regular text: ~21px per line, wrapping at ~90 chars
 * - Headers, lists, blockquotes: taller line heights
 *
 * @param content - The markdown content to estimate
 * @returns Estimated height in pixels
 */
export function estimateRenderedHeight(content: string): number {
  let height = 0;
  const H = HEIGHT_CONSTANTS;

  // Extract code blocks first (they have special rendering)
  const codeBlockRegex = /```[\s\S]*?```/g;
  const codeBlocks = content.match(codeBlockRegex) || [];
  let textContent = content;

  // Process code blocks
  for (const block of codeBlocks) {
    const lines = block.split('\n').length;
    // Each code line is ~18px, plus 32px padding per block
    height += lines * H.CODE_LINE + H.CODE_BLOCK_PADDING;
    // Remove from text content so we don't double-count
    textContent = textContent.replace(block, '\n');
  }

  // Process remaining text line by line
  const lines = textContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === '') {
      // Blank line
      height += H.BLANK_LINE;
    } else if (/^#{1,6}\s/.test(trimmed)) {
      // Markdown header
      height += H.HEADER_LINE;
    } else if (trimmed.startsWith('>')) {
      // Blockquote - estimate wrapping
      const textLength = trimmed.substring(1).trim().length;
      const wrappedLines = Math.ceil(textLength / H.CHARS_PER_LINE) || 1;
      height += wrappedLines * H.BLOCKQUOTE_LINE;
    } else if (/^[-*+]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
      // List item - estimate wrapping
      const textLength = trimmed.replace(/^[-*+\d.]+\s*/, '').length;
      const wrappedLines = Math.ceil(textLength / H.CHARS_PER_LINE) || 1;
      height += wrappedLines * H.LIST_ITEM;
    } else if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      // Table row
      height += H.TABLE_ROW;
    } else {
      // Regular text - estimate wrapping
      const wrappedLines = Math.ceil(line.length / H.CHARS_PER_LINE) || 1;
      height += wrappedLines * H.TEXT_LINE;
    }
  }

  return height;
}

// ---------------------------------------------------------------------------
// Default Implementation
// ---------------------------------------------------------------------------

/**
 * Default implementation of ContentBreaker.
 * Extracts logic from src/session/streaming.ts for reuse.
 */
export class DefaultContentBreaker implements ContentBreaker {
  getCodeBlockState(content: string, position: number): CodeBlockInfo {
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

  findLogicalBreakpoint(
    content: string,
    startPos: number,
    maxLookAhead: number = 500
  ): BreakpointResult | null {
    const searchWindow = content.substring(startPos, startPos + maxLookAhead);

    // First, check if we're inside an open code block at startPos
    const codeBlockState = this.getCodeBlockState(content, startPos);

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
      if (!this.getCodeBlockState(content, pos).isInside) {
        return { position: pos, type: 'tool_marker' };
      }
    }

    // Priority 2: Look for markdown headings (section boundaries)
    const headingMatch = searchWindow.match(/\n(#{2,3} )/);
    if (headingMatch && headingMatch.index !== undefined) {
      const pos = startPos + headingMatch.index;
      // Verify we're not inside a code block at this position
      if (!this.getCodeBlockState(content, pos).isInside) {
        return { position: pos, type: 'heading' };
      }
    }

    // Priority 3: Look for end of code blocks
    // We need to find a CLOSING marker, not an opening one
    // Use matchAll to find all ``` markers and identify which is a closing marker
    const codeBlockMarkerRegex = /^```$/gm;
    const matches = [...searchWindow.matchAll(codeBlockMarkerRegex)];
    for (const match of matches) {
      if (match.index !== undefined) {
        const matchPos = startPos + match.index;
        // Check if we're inside a code block at this position
        // If we are, this ``` is a closing marker; if not, it's an opening marker
        const stateAtMatch = this.getCodeBlockState(content, matchPos);
        if (stateAtMatch.isInside) {
          // This is a closing marker - break after it
          const pos = matchPos + match[0].length;
          const nextChar = content[pos];
          const finalPos = nextChar === '\n' ? pos + 1 : pos;
          return { position: finalPos, type: 'code_block_end' };
        }
        // Otherwise, this is an opening marker - continue to next match
      }
    }

    // Priority 4: Look for paragraph breaks (double newlines)
    const paragraphMatch = searchWindow.match(/\n\n/);
    if (paragraphMatch && paragraphMatch.index !== undefined) {
      const pos = startPos + paragraphMatch.index + paragraphMatch[0].length;
      // Verify we're not inside a code block at this position
      if (!this.getCodeBlockState(content, pos).isInside) {
        return { position: pos, type: 'paragraph' };
      }
    }

    // Priority 5: Fallback to any line break (but not inside code blocks)
    const lineBreakMatch = searchWindow.match(/\n/);
    if (lineBreakMatch && lineBreakMatch.index !== undefined) {
      const pos = startPos + lineBreakMatch.index + 1;
      // Verify we're not inside a code block at this position
      if (!this.getCodeBlockState(content, pos).isInside) {
        return { position: pos, type: 'none' };
      }
    }

    return null;
  }

  shouldFlushEarly(content: string): boolean {
    // Primary check: estimated rendered height
    // Mattermost collapses at ~600px, we flush at 500px for safety margin
    const estimatedHeight = estimateRenderedHeight(content);
    if (estimatedHeight >= MAX_HEIGHT_THRESHOLD) return true;

    // Fallback checks for edge cases
    const lineCount = (content.match(/\n/g) || []).length;
    if (content.length >= SOFT_BREAK_THRESHOLD) return true;
    if (lineCount >= MAX_LINES_BEFORE_BREAK) return true;

    return false;
  }

  endsAtBreakpoint(content: string): BreakpointType {
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
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Split content into chunks that won't trigger "Show more" collapse.
 *
 * This is a pure utility function for pre-splitting content before posting.
 * Used when creating NEW posts (no existing post to update).
 *
 * Only splits at "good" breakpoints (paragraphs, code block ends, headings, tool markers).
 * Does NOT split at arbitrary line breaks to avoid fragmenting content unnecessarily.
 *
 * @param content - The content to split
 * @param contentBreaker - ContentBreaker instance for height checks and breakpoints
 * @returns Array of content chunks, each safe to post without collapse
 */
export function splitContentForHeight(
  content: string,
  contentBreaker: ContentBreaker
): string[] {
  const chunks: string[] = [];
  let remaining = content;

  // Breakpoint types that are good for splitting (not arbitrary line breaks)
  const goodBreakpointTypes = new Set(['paragraph', 'code_block_end', 'heading', 'tool_marker']);

  // Keep splitting while content is too tall
  while (remaining && contentBreaker.shouldFlushEarly(remaining)) {
    // Look for a logical breakpoint starting from position 0
    // Use a larger search window to find good breakpoints
    const breakpoint = contentBreaker.findLogicalBreakpoint(remaining, 0, remaining.length);

    if (!breakpoint || breakpoint.position <= 0 || breakpoint.position >= remaining.length) {
      // No breakpoint found, keep as single chunk
      break;
    }

    // Only split at "good" breakpoints - not arbitrary line breaks
    if (!goodBreakpointTypes.has(breakpoint.type)) {
      // Found only a line break, not a good place to split
      break;
    }

    const firstPart = remaining.substring(0, breakpoint.position).trim();
    const secondPart = remaining.substring(breakpoint.position).trim();

    // Split if the first part is safe to post (won't trigger collapse)
    // and we actually have content in the second part
    if (!contentBreaker.shouldFlushEarly(firstPart) && secondPart.length > 0) {
      chunks.push(firstPart);
      remaining = secondPart;
    } else {
      // First chunk is still too tall, can't split effectively
      break;
    }
  }

  // Add whatever remains
  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.length ? chunks : [content];
}
