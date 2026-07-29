import { describe, it, expect } from 'bun:test';
import { createMockFormatter, mockFormatter } from './mock-formatter.js';

describe('createMockFormatter (Mattermost-style)', () => {
  const formatter = createMockFormatter();

  describe('formatBold', () => {
    it('wraps text with double asterisks', () => {
      expect(formatter.formatBold('test')).toBe('**test**');
    });
  });

  describe('formatItalic', () => {
    it('wraps text with underscores', () => {
      expect(formatter.formatItalic('test')).toBe('_test_');
    });
  });

  describe('formatCode', () => {
    it('wraps text with backticks', () => {
      expect(formatter.formatCode('code')).toBe('`code`');
    });
  });

  describe('formatCodeBlock', () => {
    it('wraps code with triple backticks and trailing newline', () => {
      expect(formatter.formatCodeBlock('code')).toBe('```\ncode\n```\n');
    });

    it('includes language when provided', () => {
      expect(formatter.formatCodeBlock('code', 'typescript')).toBe('```typescript\ncode\n```\n');
    });
  });

  describe('formatUserMention', () => {
    it('adds @ prefix to username', () => {
      expect(formatter.formatUserMention('alice')).toBe('@alice');
    });
  });

  describe('formatLink', () => {
    it('creates markdown link', () => {
      expect(formatter.formatLink('Google', 'https://google.com')).toBe('[Google](https://google.com)');
    });
  });

  describe('formatListItem', () => {
    it('adds dash prefix', () => {
      expect(formatter.formatListItem('item')).toBe('- item');
    });
  });

  describe('formatNumberedListItem', () => {
    it('adds number with period', () => {
      expect(formatter.formatNumberedListItem(1, 'first')).toBe('1. first');
      expect(formatter.formatNumberedListItem(10, 'tenth')).toBe('10. tenth');
    });
  });

  describe('formatBlockquote', () => {
    it('adds > prefix', () => {
      expect(formatter.formatBlockquote('quote')).toBe('> quote');
    });
  });

  describe('formatHorizontalRule', () => {
    it('returns three dashes', () => {
      expect(formatter.formatHorizontalRule()).toBe('---');
    });
  });

  describe('formatStrikethrough', () => {
    it('wraps with double tildes', () => {
      expect(formatter.formatStrikethrough('deleted')).toBe('~~deleted~~');
    });
  });

  describe('formatHeading', () => {
    it('adds correct number of hash marks', () => {
      expect(formatter.formatHeading('Title', 1)).toBe('# Title');
      expect(formatter.formatHeading('Section', 2)).toBe('## Section');
      expect(formatter.formatHeading('Subsection', 3)).toBe('### Subsection');
    });
  });

  describe('escapeText', () => {
    it('escapes markdown special characters', () => {
      expect(formatter.escapeText('*bold*')).toBe('\\*bold\\*');
      expect(formatter.escapeText('_italic_')).toBe('\\_italic\\_');
      expect(formatter.escapeText('`code`')).toBe('\\`code\\`');
      expect(formatter.escapeText('[link](url)')).toBe('\\[link\\]\\(url\\)');
    });
  });

  describe('formatTable', () => {
    it('creates markdown table', () => {
      const headers = ['Name', 'Age'];
      const rows = [['Alice', '30'], ['Bob', '25']];

      const result = formatter.formatTable(headers, rows);

      expect(result).toContain('| Name | Age |');
      expect(result).toContain('| --- | --- |');
      expect(result).toContain('| Alice | 30 |');
      expect(result).toContain('| Bob | 25 |');
    });
  });

  describe('formatKeyValueList', () => {
    it('creates key-value table', () => {
      const items: [string, string, string][] = [
        ['📍', 'Location', 'NYC'],
        ['🕐', 'Time', '2pm'],
      ];

      const result = formatter.formatKeyValueList(items);

      expect(result).toContain('📍 **Location** | NYC');
      expect(result).toContain('🕐 **Time** | 2pm');
    });
  });

  describe('formatMarkdown', () => {
    it('collapses multiple newlines', () => {
      expect(formatter.formatMarkdown('a\n\n\n\nb')).toBe('a\n\nb');
    });
  });
});

describe('mockFormatter instance', () => {
  it('is a pre-created formatter', () => {
    expect(mockFormatter.formatBold('test')).toBe('**test**');
  });
});

