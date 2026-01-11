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
    // Count lines
    const lineCount = (content.match(/\n/g) || []).length;

    // Check against thresholds
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
// Singleton instance for convenience
// ---------------------------------------------------------------------------

/**
 * Default content breaker instance.
 * Use this for standard message breaking behavior.
 */
export const defaultContentBreaker = new DefaultContentBreaker();

// ---------------------------------------------------------------------------
// Standalone functions for backward compatibility
// ---------------------------------------------------------------------------

/**
 * Check if a position is inside an open code block.
 * @see ContentBreaker.getCodeBlockState
 */
export function getCodeBlockState(content: string, position: number): CodeBlockInfo {
  return defaultContentBreaker.getCodeBlockState(content, position);
}

/**
 * Find the best logical breakpoint in content.
 * @see ContentBreaker.findLogicalBreakpoint
 */
export function findLogicalBreakpoint(
  content: string,
  startPos: number,
  maxLookAhead: number = 500
): BreakpointResult | null {
  return defaultContentBreaker.findLogicalBreakpoint(content, startPos, maxLookAhead);
}

/**
 * Check if content should be flushed early.
 * @see ContentBreaker.shouldFlushEarly
 */
export function shouldFlushEarly(content: string): boolean {
  return defaultContentBreaker.shouldFlushEarly(content);
}

/**
 * Check if content ends at a logical breakpoint.
 * @see ContentBreaker.endsAtBreakpoint
 */
export function endsAtBreakpoint(content: string): BreakpointType {
  return defaultContentBreaker.endsAtBreakpoint(content);
}
