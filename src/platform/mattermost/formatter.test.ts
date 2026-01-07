import { describe, it, expect } from 'bun:test';
import { MattermostFormatter } from './formatter.js';

describe('MattermostFormatter', () => {
  const formatter = new MattermostFormatter();

  describe('formatBold', () => {
    it('wraps text in double asterisks', () => {
      expect(formatter.formatBold('hello')).toBe('**hello**');
    });

    it('handles empty strings', () => {
      expect(formatter.formatBold('')).toBe('****');
    });
  });

  describe('formatItalic', () => {
    it('wraps text in underscores', () => {
      expect(formatter.formatItalic('hello')).toBe('_hello_');
    });
  });

  describe('formatCode', () => {
    it('wraps text in backticks', () => {
      expect(formatter.formatCode('const x = 1')).toBe('`const x = 1`');
    });
  });

  describe('formatCodeBlock', () => {
    it('wraps code in triple backticks with language and trailing newline', () => {
      const result = formatter.formatCodeBlock('const x = 1', 'javascript');
      expect(result).toBe('```javascript\nconst x = 1\n```\n');
    });

    it('works without language', () => {
      const result = formatter.formatCodeBlock('const x = 1');
      expect(result).toBe('```\nconst x = 1\n```\n');
    });
  });

  describe('formatUserMention', () => {
    it('prefixes username with @', () => {
      expect(formatter.formatUserMention('johndoe')).toBe('@johndoe');
    });
  });

  describe('formatLink', () => {
    it('creates markdown link', () => {
      expect(formatter.formatLink('Click here', 'https://example.com'))
        .toBe('[Click here](https://example.com)');
    });
  });

  describe('formatListItem', () => {
    it('prefixes with dash', () => {
      expect(formatter.formatListItem('Item 1')).toBe('- Item 1');
    });
  });

  describe('formatNumberedListItem', () => {
    it('prefixes with number and period', () => {
      expect(formatter.formatNumberedListItem(1, 'First item')).toBe('1. First item');
      expect(formatter.formatNumberedListItem(10, 'Tenth item')).toBe('10. Tenth item');
    });
  });

  describe('formatBlockquote', () => {
    it('prefixes with >', () => {
      expect(formatter.formatBlockquote('quoted text')).toBe('> quoted text');
    });
  });

  describe('formatStrikethrough', () => {
    it('wraps text in double tildes', () => {
      expect(formatter.formatStrikethrough('deleted')).toBe('~~deleted~~');
    });
  });

  describe('formatTable', () => {
    it('creates markdown table with headers and rows', () => {
      const headers = ['Name', 'Age', 'City'];
      const rows = [
        ['Alice', '30', 'NYC'],
        ['Bob', '25', 'LA'],
      ];
      const result = formatter.formatTable(headers, rows);
      expect(result).toContain('| Name | Age | City |');
      expect(result).toContain('| --- | --- | --- |');
      expect(result).toContain('| Alice | 30 | NYC |');
      expect(result).toContain('| Bob | 25 | LA |');
    });

    it('handles empty rows', () => {
      const headers = ['A', 'B'];
      const rows: string[][] = [];
      const result = formatter.formatTable(headers, rows);
      expect(result).toContain('| A | B |');
      expect(result).toContain('| --- | --- |');
    });
  });

  describe('formatKeyValueList', () => {
    it('creates table with icon, label, and value', () => {
      const items: [string, string, string][] = [
        ['🔵', 'Status', 'Active'],
        ['🏷️', 'Version', '1.0.0'],
      ];
      const result = formatter.formatKeyValueList(items);
      expect(result).toContain('| 🔵 **Status** | Active |');
      expect(result).toContain('| 🏷️ **Version** | 1.0.0 |');
    });
  });

  describe('formatHorizontalRule', () => {
    it('returns three dashes', () => {
      expect(formatter.formatHorizontalRule()).toBe('---');
    });
  });

  describe('formatHeading', () => {
    it('creates headings with correct number of hashes', () => {
      expect(formatter.formatHeading('Title', 1)).toBe('# Title');
      expect(formatter.formatHeading('Subtitle', 2)).toBe('## Subtitle');
      expect(formatter.formatHeading('Section', 3)).toBe('### Section');
    });

    it('clamps heading level between 1 and 6', () => {
      expect(formatter.formatHeading('Title', 0)).toBe('# Title');
      expect(formatter.formatHeading('Title', 7)).toBe('###### Title');
    });
  });

  describe('escapeText', () => {
    it('escapes markdown special characters', () => {
      expect(formatter.escapeText('*bold* and _italic_'))
        .toBe('\\*bold\\* and \\_italic\\_');
    });

    it('escapes code backticks', () => {
      expect(formatter.escapeText('use `code` here'))
        .toBe('use \\`code\\` here');
    });

    it('escapes brackets and parentheses', () => {
      expect(formatter.escapeText('[link](url)'))
        .toBe('\\[link\\]\\(url\\)');
    });

    it('preserves regular text', () => {
      expect(formatter.escapeText('hello world')).toBe('hello world');
    });
  });

  describe('formatMarkdown', () => {
    it('normalizes excessive newlines', () => {
      const input = 'Line 1\n\n\n\nLine 2';
      expect(formatter.formatMarkdown(input)).toBe('Line 1\n\nLine 2');
    });

    it('preserves standard markdown (no conversion needed)', () => {
      const input = '**bold** and [link](url) and ## Header';
      expect(formatter.formatMarkdown(input)).toBe(input);
    });

    it('preserves code blocks', () => {
      const input = '```javascript\nconst x = 1;\n```';
      expect(formatter.formatMarkdown(input)).toBe(input);
    });
  });
});
