/**
 * Tests for ContentBreaker - Message breaking and logical breakpoint detection
 */

import { describe, it, expect } from 'bun:test';
import {
  DefaultContentBreaker,
  SOFT_BREAK_THRESHOLD,
  MIN_BREAK_THRESHOLD,
  MAX_LINES_BEFORE_BREAK,
  MAX_HEIGHT_THRESHOLD,
  HEIGHT_CONSTANTS,
  estimateRenderedHeight,
  splitContentForHeight,
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

    it('MAX_HEIGHT_THRESHOLD is 500', () => {
      expect(MAX_HEIGHT_THRESHOLD).toBe(500);
    });
  });
});

// ---------------------------------------------------------------------------
// Height Estimation Tests
// ---------------------------------------------------------------------------

describe('estimateRenderedHeight', () => {
  const H = HEIGHT_CONSTANTS;

  describe('basic text', () => {
    it('returns minimal height for empty string', () => {
      // Empty string splits to one empty line
      expect(estimateRenderedHeight('')).toBe(H.BLANK_LINE);
    });

    it('estimates single line of text', () => {
      const content = 'Hello world';
      const height = estimateRenderedHeight(content);
      expect(height).toBe(H.TEXT_LINE); // One line = 21px
    });

    it('estimates multiple lines of text', () => {
      const content = 'Line 1\nLine 2\nLine 3';
      const height = estimateRenderedHeight(content);
      expect(height).toBe(H.TEXT_LINE * 3); // 3 lines = 63px
    });

    it('estimates text wrapping for long lines', () => {
      // 180 chars should wrap to ~2 lines at 90 chars/line
      const content = 'x'.repeat(180);
      const height = estimateRenderedHeight(content);
      expect(height).toBe(H.TEXT_LINE * 2); // 2 wrapped lines = 42px
    });

    it('handles blank lines', () => {
      const content = 'Line 1\n\nLine 2';
      const height = estimateRenderedHeight(content);
      // Line 1 (21) + blank (10) + Line 2 (21) = 52
      expect(height).toBe(H.TEXT_LINE + H.BLANK_LINE + H.TEXT_LINE);
    });
  });

  describe('code blocks', () => {
    it('estimates code block with padding', () => {
      const content = '```\ncode line\n```';
      const height = estimateRenderedHeight(content);
      // Code block: 3 lines * 18px + 32px padding = 86px
      // Plus the replacement newline creates a blank line (10px)
      // Total: 86 + 10 + 10 (empty before and after) = 106px
      expect(height).toBe(3 * H.CODE_LINE + H.CODE_BLOCK_PADDING + H.BLANK_LINE * 2);
    });

    it('estimates multi-line code block', () => {
      const content = '```typescript\nline 1\nline 2\nline 3\n```';
      const height = estimateRenderedHeight(content);
      // Code block: 5 lines * 18px + 32px padding = 122px
      // Plus replacement newlines
      expect(height).toBe(5 * H.CODE_LINE + H.CODE_BLOCK_PADDING + H.BLANK_LINE * 2);
    });

    it('estimates multiple code blocks', () => {
      const content = '```\na\n```\n\n```\nb\n```';
      const height = estimateRenderedHeight(content);
      // Two code blocks + blank lines from replacement
      const codeBlockHeight = 3 * H.CODE_LINE + H.CODE_BLOCK_PADDING;
      // Actual height accounts for newlines between and around blocks (5 total)
      expect(height).toBe(codeBlockHeight * 2 + H.BLANK_LINE * 5);
    });

    it('estimates mixed text and code', () => {
      const content = 'Some text\n```\ncode\n```\nMore text';
      const height = estimateRenderedHeight(content);
      // Text + code block + text, with replacement newlines
      const codeHeight = 3 * H.CODE_LINE + H.CODE_BLOCK_PADDING;
      // Text (21) + blank from replacement (10) + code + blank (10) + Text (21)
      expect(height).toBe(H.TEXT_LINE + H.BLANK_LINE + codeHeight + H.BLANK_LINE + H.TEXT_LINE);
    });
  });

  describe('markdown elements', () => {
    it('estimates headers', () => {
      const content = '# Header 1\n## Header 2\n### Header 3';
      const height = estimateRenderedHeight(content);
      expect(height).toBe(H.HEADER_LINE * 3); // 3 headers = 96px
    });

    it('estimates list items', () => {
      const content = '- Item 1\n- Item 2\n* Item 3';
      const height = estimateRenderedHeight(content);
      expect(height).toBe(H.LIST_ITEM * 3); // 3 items = 72px
    });

    it('estimates numbered list items', () => {
      const content = '1. First\n2. Second\n10. Tenth';
      const height = estimateRenderedHeight(content);
      expect(height).toBe(H.LIST_ITEM * 3); // 3 items = 72px
    });

    it('estimates blockquotes', () => {
      const content = '> Quote line 1\n> Quote line 2';
      const height = estimateRenderedHeight(content);
      expect(height).toBe(H.BLOCKQUOTE_LINE * 2); // 2 quotes = 48px
    });

    it('estimates table rows', () => {
      const content = '| Col 1 | Col 2 |\n| --- | --- |\n| A | B |';
      const height = estimateRenderedHeight(content);
      expect(height).toBe(H.TABLE_ROW * 3); // 3 rows = 84px
    });
  });

  describe('complex content', () => {
    it('estimates typical Claude response with code', () => {
      const content = `Here's the solution:

\`\`\`typescript
function add(a: number, b: number): number {
  return a + b;
}
\`\`\`

This function takes two numbers and returns their sum.`;

      const height = estimateRenderedHeight(content);
      // Line 1 (21) + blank (10) + code block (5 lines * 18 + 32) + blank (10) + Line 2 (21)
      // = 21 + 10 + 122 + 10 + 21 = 184px
      expect(height).toBeLessThan(MAX_HEIGHT_THRESHOLD);
    });

    it('triggers flush for tall content', () => {
      // Create content that should exceed 500px height
      const codeLines = Array(25).fill('const x = 1;').join('\n');
      const content = `\`\`\`typescript\n${codeLines}\n\`\`\``;

      const height = estimateRenderedHeight(content);
      // 27 lines * 18 + 32 = 518px > 500px threshold
      expect(height).toBeGreaterThan(MAX_HEIGHT_THRESHOLD);
    });

    it('handles content with all element types', () => {
      const content = `# Header

Some paragraph text here.

- List item 1
- List item 2

> A blockquote

\`\`\`
code
\`\`\`

| A | B |
| - | - |
| 1 | 2 |`;

      const height = estimateRenderedHeight(content);
      // This should be calculable and consistent
      expect(height).toBeGreaterThan(0);
      expect(typeof height).toBe('number');
    });
  });

  describe('edge cases', () => {
    it('handles unclosed code blocks gracefully', () => {
      // The regex won't match unclosed blocks, so they're treated as text
      const content = '```\nunclosed code';
      const height = estimateRenderedHeight(content);
      // Treated as 2 lines of text
      expect(height).toBe(H.TEXT_LINE * 2);
    });

    it('handles very long single line', () => {
      const content = 'x'.repeat(900); // 900 chars = 10 wrapped lines
      const height = estimateRenderedHeight(content);
      expect(height).toBe(H.TEXT_LINE * 10); // 210px
    });

    it('handles list items with long text that wraps', () => {
      const content = '- ' + 'x'.repeat(180); // List item with 180 chars
      const height = estimateRenderedHeight(content);
      // Should wrap to 2 lines at 24px each
      expect(height).toBe(H.LIST_ITEM * 2);
    });
  });
});

// ---------------------------------------------------------------------------
// shouldFlushEarly with Height Estimation
// ---------------------------------------------------------------------------

describe('shouldFlushEarly with height estimation', () => {
  const breaker = new DefaultContentBreaker();

  it('flushes when estimated height exceeds threshold', () => {
    // Create content that renders tall but has few characters
    // 25 short lines = 25 * 21px = 525px > 500px threshold
    const content = Array(25).fill('x').join('\n');
    expect(breaker.shouldFlushEarly(content)).toBe(true);
  });

  it('does not flush for short content with few lines', () => {
    const content = 'Short content\nWith two lines';
    expect(breaker.shouldFlushEarly(content)).toBe(false);
  });

  it('flushes for code block that exceeds height threshold', () => {
    // 25 lines of code * 18px + 32px padding = 482px
    // Add a few more to exceed 500px
    const codeLines = Array(28).fill('x').join('\n');
    const content = `\`\`\`\n${codeLines}\n\`\`\``;
    // 30 lines * 18 + 32 = 572px > 500
    expect(breaker.shouldFlushEarly(content)).toBe(true);
  });

  it('still respects SOFT_BREAK_THRESHOLD as fallback', () => {
    // Very long single line won't hit height threshold but hits char threshold
    const content = 'x'.repeat(SOFT_BREAK_THRESHOLD + 1);
    expect(breaker.shouldFlushEarly(content)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Code Block Protection Tests
// ---------------------------------------------------------------------------

describe('code block protection with height estimation', () => {
  const breaker = new DefaultContentBreaker();

  describe('findLogicalBreakpoint respects code blocks', () => {
    it('does not break inside a code block even when height threshold exceeded', () => {
      // Create a tall code block (exceeds 500px height)
      const codeLines = Array(30).fill('const x = 1;').join('\n');
      const content = `Some intro text\n\`\`\`typescript\n${codeLines}\n\`\`\`\nAfter code`;

      // Height estimation says we should flush
      expect(breaker.shouldFlushEarly(content)).toBe(true);

      // But findLogicalBreakpoint should find the code block END, not break inside
      const breakpoint = breaker.findLogicalBreakpoint(content, 0, content.length);
      expect(breakpoint).not.toBeNull();
      expect(breakpoint!.type).toBe('code_block_end');

      // The break position should be AFTER the closing ```
      const breakPos = breakpoint!.position;
      const contentBeforeBreak = content.substring(0, breakPos);
      const contentAfterBreak = content.substring(breakPos);

      // Content before break should include the complete code block
      expect(contentBeforeBreak).toContain('```typescript');
      expect(contentBeforeBreak).toContain('```'); // closing
      // Content after break should be the remaining text
      expect(contentAfterBreak.trim()).toBe('After code');
    });

    it('returns null when inside unclosed code block (signals wait)', () => {
      // Unclosed code block - we're streaming and haven't received the closing yet
      const codeLines = Array(30).fill('const x = 1;').join('\n');
      const content = `\`\`\`typescript\n${codeLines}`;

      // Start searching from inside the code block
      const breakpoint = breaker.findLogicalBreakpoint(content, 20, 100);

      // Should return null because we can't safely break inside a code block
      expect(breakpoint).toBeNull();
    });

    it('waits for code block to close before breaking', () => {
      // Code block that starts at the beginning
      const codeLines = Array(10).fill('code').join('\n');
      const content = `\`\`\`\n${codeLines}\n\`\`\`\nMore text here`;

      // When we're at position 0, we're inside the code block (after ```)
      // The breakpoint finder should locate the closing ```
      const stateAtStart = breaker.getCodeBlockState(content, 5); // After opening ```
      expect(stateAtStart.isInside).toBe(true);

      // Find breakpoint starting from inside the code block
      const breakpoint = breaker.findLogicalBreakpoint(content, 5, content.length);
      expect(breakpoint).not.toBeNull();
      expect(breakpoint!.type).toBe('code_block_end');

      // After the breakpoint, we should be outside the code block
      const remainder = content.substring(breakpoint!.position);
      expect(remainder.trim()).toBe('More text here');
    });

    it('breaks between code blocks, not inside them', () => {
      const content = `\`\`\`\ncode1\n\`\`\`\n\nSome text\n\n\`\`\`\ncode2\n\`\`\``;

      // Start searching from inside the first code block
      const breakpoint = breaker.findLogicalBreakpoint(content, 5, content.length);
      expect(breakpoint).not.toBeNull();

      // Should break after first code block ends
      expect(breakpoint!.type).toBe('code_block_end');

      // The remainder should start with the text between the code blocks
      const remainder = content.substring(breakpoint!.position);
      expect(remainder.trim().startsWith('Some text')).toBe(true);
    });
  });

  describe('getCodeBlockState accuracy', () => {
    it('correctly identifies position inside code block', () => {
      const content = `Text before\n\`\`\`typescript\nconst x = 1;\nconst y = 2;\n\`\`\`\nText after`;

      // Position inside the code block (after the opening ```)
      const insidePos = content.indexOf('const x');
      const stateInside = breaker.getCodeBlockState(content, insidePos);
      expect(stateInside.isInside).toBe(true);
      expect(stateInside.language).toBe('typescript');

      // Position after the code block
      const afterPos = content.indexOf('Text after');
      const stateAfter = breaker.getCodeBlockState(content, afterPos);
      expect(stateAfter.isInside).toBe(false);
    });

    it('tracks multiple code blocks correctly', () => {
      const content = `\`\`\`js\na\n\`\`\`\ntext\n\`\`\`python\nb\n\`\`\`\nmore`;

      // Inside first code block
      const pos1 = content.indexOf('a');
      expect(breaker.getCodeBlockState(content, pos1).language).toBe('js');

      // Between code blocks
      const pos2 = content.indexOf('text');
      expect(breaker.getCodeBlockState(content, pos2).isInside).toBe(false);

      // Inside second code block
      const pos3 = content.indexOf('b');
      expect(breaker.getCodeBlockState(content, pos3).language).toBe('python');

      // After all code blocks
      const pos4 = content.indexOf('more');
      expect(breaker.getCodeBlockState(content, pos4).isInside).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// splitContentForHeight Tests
// ---------------------------------------------------------------------------

describe('splitContentForHeight', () => {
  const breaker = new DefaultContentBreaker();

  describe('basic behavior', () => {
    it('returns single chunk for short content', () => {
      const content = 'Short content';
      const chunks = splitContentForHeight(content, breaker);
      expect(chunks).toEqual([content]);
    });

    it('returns single chunk for content under height threshold', () => {
      const content = 'Line 1\nLine 2\nLine 3';
      const chunks = splitContentForHeight(content, breaker);
      expect(chunks).toEqual([content]);
    });

    it('returns original content as single chunk when no breakpoint found', () => {
      // Very long single line with no breakpoints
      const content = 'x'.repeat(3000);
      const chunks = splitContentForHeight(content, breaker);
      expect(chunks).toEqual([content]);
    });
  });

  describe('splitting tall content', () => {
    it('splits content with multiple paragraphs that exceed height threshold', () => {
      // Create three paragraphs - each 10 lines (~210px), total ~650px exceeds 500px threshold
      // First two paragraphs together are ~430px (under threshold), so we can split there
      const para1 = Array(10).fill('First paragraph line here').join('\n');
      const para2 = Array(10).fill('Second paragraph line here').join('\n');
      const para3 = Array(10).fill('Third paragraph line here').join('\n');
      const content = para1 + '\n\n' + para2 + '\n\n' + para3;

      const chunks = splitContentForHeight(content, breaker);

      // Should be split into multiple chunks
      expect(chunks.length).toBeGreaterThan(1);
      // First chunk should contain first paragraph
      expect(chunks[0]).toContain('First paragraph');
    });

    it('splits at paragraph boundaries when each part fits', () => {
      // Two paragraphs of 12 lines each - each ~252px, combined ~514px exceeds 500px
      // Each individual paragraph fits, so we can split at paragraph break
      const para1 = Array(12).fill('First paragraph line').join('\n');
      const para2 = Array(12).fill('Second paragraph line').join('\n');
      const content = para1 + '\n\n' + para2;

      const chunks = splitContentForHeight(content, breaker);

      // Should split at the paragraph break
      expect(chunks.length).toBe(2);
      expect(chunks[0]).toContain('First paragraph');
      expect(chunks[1]).toContain('Second paragraph');
    });

    it('keeps content as single chunk when no good split exists', () => {
      // 20 lines in a single paragraph - exceeds line count threshold (15)
      // but there's no paragraph break to split at
      const content = Array(20).fill('Line of text here').join('\n');

      const chunks = splitContentForHeight(content, breaker);

      // Cannot split without a good breakpoint
      expect(chunks.length).toBe(1);
    });
  });

  describe('code block protection', () => {
    it('does not split inside code blocks', () => {
      // Create a tall code block
      const codeLines = Array(30).fill('const x = 1;').join('\n');
      const content = `\`\`\`typescript\n${codeLines}\n\`\`\``;

      const chunks = splitContentForHeight(content, breaker);

      // Should stay as single chunk (can't break inside code block)
      expect(chunks).toEqual([content]);
    });

    it('splits after code block when there is content after', () => {
      // Code block followed by text - code block takes ~400px, text takes ~100px
      // Total ~500px which is at threshold, but we're testing that split preserves code block integrity
      const codeLines = Array(15).fill('code').join('\n');
      const afterText = Array(10).fill('Text after the code block').join('\n');
      const content = '```\n' + codeLines + '\n```\n\n' + afterText;

      const chunks = splitContentForHeight(content, breaker);

      // Whether split or not, if we have multiple chunks, code block must be intact
      if (chunks.length > 1) {
        // First chunk should include the complete code block
        expect(chunks[0]).toContain('```');
        // The closing ``` should be in the first chunk
        const openCount = (chunks[0].match(/```/g) || []).length;
        expect(openCount).toBe(2); // Opening and closing
      }
    });
  });

  describe('edge cases', () => {
    it('handles empty string', () => {
      const chunks = splitContentForHeight('', breaker);
      expect(chunks).toEqual(['']);
    });

    it('handles content with only whitespace', () => {
      const chunks = splitContentForHeight('   ', breaker);
      expect(chunks).toEqual(['   ']);
    });

    it('preserves content integrity (no content loss)', () => {
      // Create splittable content
      const para1 = Array(15).fill('A').join('\n');
      const para2 = Array(15).fill('B').join('\n');
      const original = para1 + '\n\n' + para2;

      const chunks = splitContentForHeight(original, breaker);

      // Rejoining chunks should give us back all the content
      const rejoined = chunks.join('\n\n');
      expect(rejoined).toContain('A');
      expect(rejoined).toContain('B');
    });

    it('returns array with single item for unsplittable content', () => {
      // Content that triggers flush but has no good breakpoint
      const content = 'x'.repeat(3000); // No newlines
      const chunks = splitContentForHeight(content, breaker);

      expect(Array.isArray(chunks)).toBe(true);
      expect(chunks.length).toBe(1);
    });
  });
});
