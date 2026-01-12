/**
 * Tests for ContentBreaker - Message breaking and logical breakpoint detection
 */

import { describe, it, expect } from 'bun:test';
import {
  DefaultContentBreaker,
  SOFT_BREAK_THRESHOLD,
  MIN_BREAK_THRESHOLD,
  MAX_LINES_BEFORE_BREAK,
} from './content-breaker.js';

describe('ContentBreaker', () => {
  const breaker = new DefaultContentBreaker();

  // ---------------------------------------------------------------------------
  // Code Block State Detection
  // ---------------------------------------------------------------------------

  describe('getCodeBlockState', () => {
    it('returns not inside for empty content', () => {
      const result = breaker.getCodeBlockState('', 0);
      expect(result.isInside).toBe(false);
    });

    it('returns not inside for content without code blocks', () => {
      const content = 'Hello world\nThis is a test';
      const result = breaker.getCodeBlockState(content, content.length);
      expect(result.isInside).toBe(false);
    });

    it('detects being inside an open code block', () => {
      const content = '```typescript\nconst x = 1;\n';
      const result = breaker.getCodeBlockState(content, content.length);
      expect(result.isInside).toBe(true);
      expect(result.language).toBe('typescript');
      expect(result.openPosition).toBe(0);
    });

    it('returns not inside after code block is closed', () => {
      const content = '```typescript\nconst x = 1;\n```\n';
      const result = breaker.getCodeBlockState(content, content.length);
      expect(result.isInside).toBe(false);
    });

    it('handles multiple code blocks', () => {
      const content = '```js\ncode1\n```\n\n```python\ncode2\n';
      const result = breaker.getCodeBlockState(content, content.length);
      expect(result.isInside).toBe(true);
      expect(result.language).toBe('python');
    });

    it('detects position inside vs outside code block', () => {
      const content = 'Before\n```\ncode\n```\nAfter';

      // Before code block
      expect(breaker.getCodeBlockState(content, 3).isInside).toBe(false);

      // Inside code block (after opening ```)
      expect(breaker.getCodeBlockState(content, 12).isInside).toBe(true);

      // After code block
      expect(breaker.getCodeBlockState(content, 20).isInside).toBe(false);
    });

    it('handles code blocks without language specifier', () => {
      const content = '```\nplain code\n';
      const result = breaker.getCodeBlockState(content, content.length);
      expect(result.isInside).toBe(true);
      // Language is undefined when no language specifier (empty capture group)
      expect(result.language).toBeUndefined();
    });

    it('handles inline backticks (not code blocks)', () => {
      const content = 'Use `const` keyword';
      const result = breaker.getCodeBlockState(content, content.length);
      expect(result.isInside).toBe(false);
    });

    it('tracks openPosition correctly', () => {
      const content = 'Some text\n```diff\n- old\n+ new\n';
      const result = breaker.getCodeBlockState(content, content.length);
      expect(result.isInside).toBe(true);
      expect(result.openPosition).toBe(10); // Position of ```
    });
  });

  // ---------------------------------------------------------------------------
  // Logical Breakpoint Finding
  // ---------------------------------------------------------------------------

  describe('findLogicalBreakpoint', () => {
    describe('tool result markers', () => {
      it('finds tool result success marker', () => {
        const content = 'Some output\n  ↳ ✓ Success\nMore content';
        const result = breaker.findLogicalBreakpoint(content, 0, 100);
        expect(result).not.toBeNull();
        expect(result!.type).toBe('tool_marker');
      });

      it('finds tool result error marker', () => {
        const content = 'Some output\n  ↳ ❌ Error: failed\nMore content';
        const result = breaker.findLogicalBreakpoint(content, 0, 100);
        expect(result).not.toBeNull();
        expect(result!.type).toBe('tool_marker');
      });
    });

    describe('headings', () => {
      it('finds h2 heading', () => {
        const content = 'Some content\n\n## Section\n\nMore content';
        const result = breaker.findLogicalBreakpoint(content, 0, 100);
        expect(result).not.toBeNull();
        expect(result!.type).toBe('heading');
      });

      it('finds h3 heading', () => {
        const content = 'Some content\n\n### Subsection\n\nMore content';
        const result = breaker.findLogicalBreakpoint(content, 0, 100);
        expect(result).not.toBeNull();
        expect(result!.type).toBe('heading');
      });

      it('does not find h1 heading (not in pattern)', () => {
        // The pattern is /{2,3} so h1 (#) won't match
        const content = 'Some content\n\n# Title\n\nMore content';
        const result = breaker.findLogicalBreakpoint(content, 0, 100);
        // Should find paragraph break instead
        expect(result).not.toBeNull();
        expect(result!.type).toBe('paragraph');
      });

      it('ignores headings inside code blocks', () => {
        const content = '```\n## Not a heading\n```\n\nReal content';
        // Start after the code block
        const result = breaker.findLogicalBreakpoint(content, 0, 100);
        // Should find code_block_end, not heading
        expect(result).not.toBeNull();
        expect(result!.type).toBe('code_block_end');
      });
    });

    describe('code blocks', () => {
      it('finds end of code block', () => {
        const content = '```typescript\nconst x = 1;\n```\nMore content';
        const result = breaker.findLogicalBreakpoint(content, 0, 100);
        expect(result).not.toBeNull();
        expect(result!.type).toBe('code_block_end');
        // Position should be after the ``` and newline
        expect(content.substring(result!.position).startsWith('More')).toBe(true);
      });

      it('waits for code block end when inside', () => {
        const content = '```typescript\nconst x = 1;\nconst y = 2;\n```\n';
        // Start from inside the code block
        const result = breaker.findLogicalBreakpoint(content, 15, 100);
        expect(result).not.toBeNull();
        expect(result!.type).toBe('code_block_end');
      });

      it('returns null when inside code block with no end in window', () => {
        const content = '```typescript\nconst x = 1;\nconst y = 2;\nconst z = 3;';
        // Start from inside the code block, with no closing ```
        const result = breaker.findLogicalBreakpoint(content, 15, 30);
        expect(result).toBeNull();
      });
    });

    describe('paragraph breaks', () => {
      it('finds paragraph break (double newline)', () => {
        const content = 'First paragraph.\n\nSecond paragraph.';
        const result = breaker.findLogicalBreakpoint(content, 0, 100);
        expect(result).not.toBeNull();
        expect(result!.type).toBe('paragraph');
      });

      it('ignores paragraph breaks inside code blocks', () => {
        const content = '```\nline1\n\nline2\n```\nAfter';
        const result = breaker.findLogicalBreakpoint(content, 0, 100);
        // Should find code_block_end, not paragraph
        expect(result).not.toBeNull();
        expect(result!.type).toBe('code_block_end');
      });
    });

    describe('fallback to line breaks', () => {
      it('falls back to line break when no better option', () => {
        const content = 'Line 1\nLine 2\nLine 3';
        const result = breaker.findLogicalBreakpoint(content, 0, 100);
        expect(result).not.toBeNull();
        expect(result!.type).toBe('none');
      });
    });

    describe('priority order', () => {
      it('prefers tool markers over headings', () => {
        const content = '  ↳ ✓ Done\n## Heading\n';
        const result = breaker.findLogicalBreakpoint(content, 0, 100);
        expect(result).not.toBeNull();
        expect(result!.type).toBe('tool_marker');
      });

      it('prefers headings over paragraphs', () => {
        const content = 'Text\n## Heading\n\nParagraph';
        const result = breaker.findLogicalBreakpoint(content, 0, 100);
        expect(result).not.toBeNull();
        expect(result!.type).toBe('heading');
      });
    });

    describe('maxLookAhead', () => {
      it('respects maxLookAhead limit', () => {
        const content = 'Short\n' + 'x'.repeat(100) + '\n\nParagraph';
        const result = breaker.findLogicalBreakpoint(content, 0, 20);
        // Paragraph break is beyond the 20 char lookahead
        // Should find line break instead
        expect(result).not.toBeNull();
        expect(result!.type).toBe('none');
      });

      it('uses default maxLookAhead of 500', () => {
        const content = 'Start' + 'x'.repeat(400) + '\n\nEnd';
        const result = breaker.findLogicalBreakpoint(content, 0);
        expect(result).not.toBeNull();
        expect(result!.type).toBe('paragraph');
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Early Flush Detection
  // ---------------------------------------------------------------------------

  describe('shouldFlushEarly', () => {
    it('returns false for short content', () => {
      const content = 'Short content';
      expect(breaker.shouldFlushEarly(content)).toBe(false);
    });

    it('returns true when content exceeds soft threshold', () => {
      const content = 'x'.repeat(SOFT_BREAK_THRESHOLD + 1);
      expect(breaker.shouldFlushEarly(content)).toBe(true);
    });

    it('returns true at exactly soft threshold', () => {
      const content = 'x'.repeat(SOFT_BREAK_THRESHOLD);
      expect(breaker.shouldFlushEarly(content)).toBe(true);
    });

    it('returns true when lines exceed max', () => {
      const content = Array(MAX_LINES_BEFORE_BREAK + 1).fill('line').join('\n');
      expect(breaker.shouldFlushEarly(content)).toBe(true);
    });

    it('returns false just under line limit', () => {
      const content = Array(MAX_LINES_BEFORE_BREAK - 1).fill('short').join('\n');
      expect(breaker.shouldFlushEarly(content)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // End Breakpoint Detection
  // ---------------------------------------------------------------------------

  describe('endsAtBreakpoint', () => {
    it('detects tool result marker at end', () => {
      const content = 'Output\n  ↳ ✓ Success';
      expect(breaker.endsAtBreakpoint(content)).toBe('tool_marker');
    });

    it('detects tool error marker at end', () => {
      const content = 'Output\n  ↳ ❌ Failed';
      expect(breaker.endsAtBreakpoint(content)).toBe('tool_marker');
    });

    it('detects code block end', () => {
      const content = '```typescript\ncode\n```';
      expect(breaker.endsAtBreakpoint(content)).toBe('code_block_end');
    });

    it('detects paragraph break', () => {
      const content = 'Some text\n\n';
      expect(breaker.endsAtBreakpoint(content)).toBe('paragraph');
    });

    it('returns none for no breakpoint', () => {
      const content = 'Some text without break';
      expect(breaker.endsAtBreakpoint(content)).toBe('none');
    });

    it('handles trailing whitespace', () => {
      const content = '```\ncode\n```  ';
      expect(breaker.endsAtBreakpoint(content)).toBe('code_block_end');
    });
  });

  // ---------------------------------------------------------------------------
  // Edge Cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles empty string', () => {
      expect(breaker.getCodeBlockState('', 0).isInside).toBe(false);
      expect(breaker.findLogicalBreakpoint('', 0)).toBeNull();
      expect(breaker.shouldFlushEarly('')).toBe(false);
      expect(breaker.endsAtBreakpoint('')).toBe('none');
    });

    it('handles single character', () => {
      expect(breaker.shouldFlushEarly('x')).toBe(false);
      expect(breaker.endsAtBreakpoint('x')).toBe('none');
    });

    it('handles position beyond content length', () => {
      const content = 'short';
      const result = breaker.getCodeBlockState(content, 100);
      expect(result.isInside).toBe(false);
    });

    it('handles content exactly at MIN_BREAK_THRESHOLD', () => {
      const content = 'x'.repeat(MIN_BREAK_THRESHOLD);
      // MIN_BREAK_THRESHOLD alone doesn't trigger flush (need SOFT_BREAK_THRESHOLD)
      expect(breaker.shouldFlushEarly(content)).toBe(false);
    });

    it('handles nested-looking code in code blocks', () => {
      const content = '```markdown\n```nested```\n```\n';
      const result = breaker.getCodeBlockState(content, content.length);
      // The outer block should be closed
      expect(result.isInside).toBe(false);
    });

    it('handles diff code blocks', () => {
      const content = '```diff\n- removed\n+ added\n```\n';
      expect(breaker.getCodeBlockState(content, 10).language).toBe('diff');
      expect(breaker.getCodeBlockState(content, content.length).isInside).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  describe('constants', () => {
    it('has reasonable threshold values', () => {
      expect(SOFT_BREAK_THRESHOLD).toBeGreaterThan(MIN_BREAK_THRESHOLD);
      expect(MIN_BREAK_THRESHOLD).toBeGreaterThan(0);
      expect(MAX_LINES_BEFORE_BREAK).toBeGreaterThan(0);
    });

    it('SOFT_BREAK_THRESHOLD is 2000', () => {
      expect(SOFT_BREAK_THRESHOLD).toBe(2000);
    });

    it('MIN_BREAK_THRESHOLD is 500', () => {
      expect(MIN_BREAK_THRESHOLD).toBe(500);
    });

    it('MAX_LINES_BEFORE_BREAK is 15', () => {
      expect(MAX_LINES_BEFORE_BREAK).toBe(15);
    });
  });
});
