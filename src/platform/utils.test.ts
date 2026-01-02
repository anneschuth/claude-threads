import { describe, it, expect } from 'bun:test';
import {
  truncateMessage,
  splitMessage,
  extractMentions,
  isMentioned,
  normalizeEmojiName,
  getEmojiCharacter,
  containsCodeBlock,
  extractCodeBlocks,
  formatCodeBlock,
  extractUrls,
  isValidUrl,
  isUserAllowed,
  sanitizeForLogging,
} from './utils.js';

describe('truncateMessage', () => {
  it('returns original if within limit', () => {
    expect(truncateMessage('hello', 10)).toBe('hello');
  });

  it('truncates with ellipsis', () => {
    expect(truncateMessage('hello world', 8)).toBe('hello...');
  });
});

describe('splitMessage', () => {
  it('returns single chunk if within limit', () => {
    const result = splitMessage('short message', 100);
    expect(result).toEqual(['short message']);
  });

  it('splits at paragraph boundaries', () => {
    const content = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const result = splitMessage(content, 25);
    expect(result.length).toBeGreaterThan(1);
    expect(result[0]).toBe('First paragraph.');
  });

  it('handles content without natural break points', () => {
    const content = 'a'.repeat(100);
    const result = splitMessage(content, 50);
    expect(result.length).toBe(2);
    expect(result[0].length).toBe(50);
  });
});

describe('extractMentions', () => {
  it('extracts @username mentions', () => {
    expect(extractMentions('Hello @alice and @bob')).toEqual(['alice', 'bob']);
  });

  it('extracts Slack-style mentions', () => {
    expect(extractMentions('Hello <@U123ABC>')).toEqual(['U123ABC']);
  });

  it('returns empty array if no mentions', () => {
    expect(extractMentions('No mentions here')).toEqual([]);
  });

  it('deduplicates mentions', () => {
    expect(extractMentions('@alice @bob @alice')).toEqual(['alice', 'bob']);
  });
});

describe('isMentioned', () => {
  it('returns true if user is mentioned', () => {
    expect(isMentioned('Hello @alice', 'alice')).toBe(true);
  });

  it('returns false if user is not mentioned', () => {
    expect(isMentioned('Hello @bob', 'alice')).toBe(false);
  });

  it('is case insensitive', () => {
    expect(isMentioned('Hello @Alice', 'alice')).toBe(true);
    expect(isMentioned('Hello @alice', 'ALICE')).toBe(true);
  });
});

describe('normalizeEmojiName', () => {
  it('removes colons', () => {
    expect(normalizeEmojiName(':+1:')).toBe('+1');
  });

  it('normalizes common aliases', () => {
    expect(normalizeEmojiName('thumbsup')).toBe('+1');
    expect(normalizeEmojiName('thumbsdown')).toBe('-1');
  });

  it('preserves unknown emoji names', () => {
    expect(normalizeEmojiName('custom_emoji')).toBe('custom_emoji');
  });
});

describe('getEmojiCharacter', () => {
  it('returns emoji character for known names', () => {
    expect(getEmojiCharacter('+1')).toBe('👍');
    expect(getEmojiCharacter('-1')).toBe('👎');
    expect(getEmojiCharacter('white_check_mark')).toBe('✅');
    expect(getEmojiCharacter('x')).toBe('❌');
  });

  it('returns colon format for unknown names', () => {
    expect(getEmojiCharacter('unknown_emoji')).toBe(':unknown_emoji:');
  });
});

describe('containsCodeBlock', () => {
  it('returns true for code blocks', () => {
    expect(containsCodeBlock('```\ncode\n```')).toBe(true);
  });

  it('returns false for regular text', () => {
    expect(containsCodeBlock('no code here')).toBe(false);
  });
});

describe('extractCodeBlocks', () => {
  it('extracts code blocks with language', () => {
    const content = '```typescript\nconst x = 1;\n```';
    const blocks = extractCodeBlocks(content);
    expect(blocks).toEqual([{ language: 'typescript', code: 'const x = 1;' }]);
  });

  it('extracts code blocks without language', () => {
    const content = '```\nplain code\n```';
    const blocks = extractCodeBlocks(content);
    expect(blocks).toEqual([{ language: '', code: 'plain code' }]);
  });

  it('extracts multiple code blocks', () => {
    const content = '```js\na\n```\ntext\n```py\nb\n```';
    const blocks = extractCodeBlocks(content);
    expect(blocks.length).toBe(2);
    expect(blocks[0]).toEqual({ language: 'js', code: 'a' });
    expect(blocks[1]).toEqual({ language: 'py', code: 'b' });
  });
});

describe('formatCodeBlock', () => {
  it('formats code with language', () => {
    expect(formatCodeBlock('const x = 1;', 'typescript')).toBe(
      '```typescript\nconst x = 1;\n```'
    );
  });

  it('formats code without language', () => {
    expect(formatCodeBlock('plain code')).toBe('```\nplain code\n```');
  });
});

describe('extractUrls', () => {
  it('extracts URLs from text', () => {
    expect(extractUrls('Check https://example.com')).toEqual(['https://example.com']);
  });

  it('extracts multiple URLs', () => {
    expect(extractUrls('See http://a.com and https://b.com')).toEqual([
      'http://a.com',
      'https://b.com',
    ]);
  });

  it('returns empty array if no URLs', () => {
    expect(extractUrls('no urls here')).toEqual([]);
  });
});

describe('isValidUrl', () => {
  it('returns true for valid URLs', () => {
    expect(isValidUrl('https://example.com')).toBe(true);
    expect(isValidUrl('http://localhost:3000/path')).toBe(true);
  });

  it('returns false for invalid URLs', () => {
    expect(isValidUrl('not a url')).toBe(false);
    expect(isValidUrl('')).toBe(false);
  });
});

describe('isUserAllowed', () => {
  it('returns true if user is in allowed list', () => {
    const allowed = new Set(['alice', 'bob']);
    expect(isUserAllowed('alice', allowed)).toBe(true);
  });

  it('returns false if user is not in allowed list', () => {
    const allowed = new Set(['alice', 'bob']);
    expect(isUserAllowed('charlie', allowed)).toBe(false);
  });

  it('returns true if allowed list is empty (everyone allowed)', () => {
    const allowed = new Set<string>();
    expect(isUserAllowed('anyone', allowed)).toBe(true);
  });
});

describe('sanitizeForLogging', () => {
  it('redacts Bearer tokens', () => {
    const input = 'Authorization: Bearer abc123secret';
    expect(sanitizeForLogging(input)).toContain('[REDACTED]');
    expect(sanitizeForLogging(input)).not.toContain('abc123secret');
  });

  it('redacts token values', () => {
    const input = 'token=supersecret123';
    expect(sanitizeForLogging(input)).toContain('[REDACTED]');
    expect(sanitizeForLogging(input)).not.toContain('supersecret123');
  });

  it('redacts password values', () => {
    const input = 'password: "mypassword"';
    expect(sanitizeForLogging(input)).toContain('[REDACTED]');
    expect(sanitizeForLogging(input)).not.toContain('mypassword');
  });

  it('preserves non-sensitive content', () => {
    const input = 'User logged in successfully';
    expect(sanitizeForLogging(input)).toBe(input);
  });
});
