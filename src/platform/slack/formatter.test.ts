import { describe, it, expect } from 'bun:test';
import { SlackFormatter } from './formatter.js';

describe('SlackFormatter', () => {
  const formatter = new SlackFormatter();

  describe('formatBold', () => {
    it('wraps text in single asterisks (Slack mrkdwn)', () => {
      expect(formatter.formatBold('hello')).toBe('*hello*');
    });

    it('handles empty strings', () => {
      expect(formatter.formatBold('')).toBe('**');
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
    it('wraps code in triple backticks (language ignored)', () => {
      const result = formatter.formatCodeBlock('const x = 1', 'javascript');
      // Slack doesn't support language hints well, so it's omitted
      expect(result).toBe('```\nconst x = 1\n```');
    });

    it('works without language', () => {
      const result = formatter.formatCodeBlock('const x = 1');
      expect(result).toBe('```\nconst x = 1\n```');
    });
  });

  describe('formatUserMention', () => {
    it('creates Slack mention with user ID when provided', () => {
      expect(formatter.formatUserMention('johndoe', 'U123ABC')).toBe('<@U123ABC>');
    });

    it('falls back to @username when no ID provided', () => {
      expect(formatter.formatUserMention('johndoe')).toBe('@johndoe');
    });
  });

  describe('formatLink', () => {
    it('creates Slack link format', () => {
      expect(formatter.formatLink('Click here', 'https://example.com'))
        .toBe('<https://example.com|Click here>');
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

  describe('formatHorizontalRule', () => {
    it('returns three dashes', () => {
      expect(formatter.formatHorizontalRule()).toBe('---');
    });
  });

  describe('formatHeading', () => {
    it('uses bold text for headings (Slack has no native headings)', () => {
      // Slack doesn't have heading syntax, so all levels use bold
      expect(formatter.formatHeading('Title', 1)).toBe('*Title*');
      expect(formatter.formatHeading('Subtitle', 2)).toBe('*Subtitle*');
      expect(formatter.formatHeading('Section', 3)).toBe('*Section*');
    });
  });

  describe('escapeText', () => {
    it('escapes ampersand', () => {
      expect(formatter.escapeText('Tom & Jerry')).toBe('Tom &amp; Jerry');
    });

    it('escapes less-than sign', () => {
      expect(formatter.escapeText('a < b')).toBe('a &lt; b');
    });

    it('escapes greater-than sign', () => {
      expect(formatter.escapeText('a > b')).toBe('a &gt; b');
    });

    it('escapes all special characters together', () => {
      expect(formatter.escapeText('<script>alert("XSS");</script>'))
        .toBe('&lt;script&gt;alert("XSS");&lt;/script&gt;');
    });

    it('preserves regular text', () => {
      expect(formatter.escapeText('hello world')).toBe('hello world');
    });

    it('does not escape asterisks or underscores (valid mrkdwn)', () => {
      // Unlike Mattermost, Slack escapeText only escapes &, <, >
      expect(formatter.escapeText('*bold* and _italic_')).toBe('*bold* and _italic_');
    });
  });

  describe('formatTable', () => {
    it('formats table as structured list (Slack has no native tables)', () => {
      const result = formatter.formatTable(
        ['Command', 'Description'],
        [
          ['!help', 'Show help'],
          ['!stop', 'Stop session'],
        ]
      );
      expect(result).toBe(
        '*Command:* !help · *Description:* Show help\n' +
        '*Command:* !stop · *Description:* Stop session'
      );
    });

    it('handles single row', () => {
      const result = formatter.formatTable(['Name'], [['Alice']]);
      expect(result).toBe('*Name:* Alice');
    });

    it('handles empty rows', () => {
      const result = formatter.formatTable(['A', 'B'], []);
      expect(result).toBe('');
    });
  });

  describe('formatKeyValueList', () => {
    it('formats key-value pairs with icons and bold labels', () => {
      const result = formatter.formatKeyValueList([
        ['📂', 'Directory', '/home/user'],
        ['👤', 'User', '@alice'],
      ]);
      expect(result).toBe(
        '📂 *Directory:* /home/user\n' +
        '👤 *User:* @alice'
      );
    });

    it('handles single item', () => {
      const result = formatter.formatKeyValueList([['🔑', 'Key', 'value']]);
      expect(result).toBe('🔑 *Key:* value');
    });

    it('handles empty list', () => {
      const result = formatter.formatKeyValueList([]);
      expect(result).toBe('');
    });
  });
});
