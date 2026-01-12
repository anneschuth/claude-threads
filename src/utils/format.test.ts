import { describe, it, expect } from 'bun:test';
import {
  formatShortId,
  extractThreadId,
  formatDuration,
  formatRelativeTimeShort,
  truncateAtWord,
} from './format.js';

describe('formatShortId', () => {
  it('returns full ID if 8 characters or less', () => {
    expect(formatShortId('abc')).toBe('abc');
    expect(formatShortId('12345678')).toBe('12345678');
  });

  it('truncates to 8 characters with ellipsis for longer IDs', () => {
    expect(formatShortId('123456789')).toBe('12345678…');
    expect(formatShortId('abcdefghijklmnop')).toBe('abcdefgh…');
  });

  it('handles empty string', () => {
    expect(formatShortId('')).toBe('');
  });
});

describe('formatDuration', () => {
  it('formats seconds', () => {
    expect(formatDuration(5000)).toBe('5s');
    expect(formatDuration(45000)).toBe('45s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(90000)).toBe('1m 30s');
    expect(formatDuration(120000)).toBe('2m');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(3600000)).toBe('1h');
    expect(formatDuration(5400000)).toBe('1h 30m');
    expect(formatDuration(7200000)).toBe('2h');
  });

  it('handles zero', () => {
    expect(formatDuration(0)).toBe('0s');
  });
});

describe('formatRelativeTimeShort', () => {
  it('formats less than a minute as <1m ago', () => {
    const now = new Date();
    expect(formatRelativeTimeShort(now)).toBe('<1m ago');
  });

  it('formats minutes ago', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    expect(formatRelativeTimeShort(fiveMinutesAgo)).toBe('5m ago');
  });

  it('formats hours ago', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    expect(formatRelativeTimeShort(twoHoursAgo)).toBe('2h ago');
  });

  it('formats days ago', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTimeShort(threeDaysAgo)).toBe('3d ago');
  });
});

describe('truncateAtWord', () => {
  it('returns original string if within limit', () => {
    expect(truncateAtWord('hello', 10)).toBe('hello');
    expect(truncateAtWord('hello world', 20)).toBe('hello world');
  });

  it('breaks at word boundary when space is far enough', () => {
    // 'hello world foo' = 15 chars, limit 12
    // truncated to 11 chars = 'hello world', lastSpace at 5
    // 5 > 12 * 0.7 (8.4) = false, so hard truncate
    expect(truncateAtWord('hello world foo', 12)).toBe('hello world…');
  });

  it('breaks at word boundary for longer text', () => {
    // 'hello there world' at limit 15
    // truncated to 14 chars = 'hello there wo', lastSpace at 11
    // 11 > 15 * 0.7 (10.5) = true, so break at word
    const result = truncateAtWord('hello there world', 15);
    expect(result).toBe('hello there…');
  });

  it('falls back to hard truncation when space is too early', () => {
    // 'abcdefghijklmnop' has no spaces, will hard truncate
    expect(truncateAtWord('abcdefghijklmnop', 10)).toBe('abcdefghi…');
  });

  it('hard truncates when only space is very early', () => {
    // 'a bcdefghijklmnop' - space at position 1, much less than 70% of 12
    const result = truncateAtWord('a bcdefghijklmnop', 12);
    expect(result).toBe('a bcdefghij…');
  });

  it('includes ellipsis in output', () => {
    const result = truncateAtWord('hello world foo bar', 15);
    expect(result).toContain('…');
  });
});

describe('extractThreadId', () => {
  it('extracts thread ID from composite session ID', () => {
    expect(extractThreadId('platform:thread123')).toBe('thread123');
    expect(extractThreadId('mattermost-main:abc123xyz')).toBe('abc123xyz');
  });

  it('returns original ID if no colon present', () => {
    expect(extractThreadId('thread123')).toBe('thread123');
    expect(extractThreadId('abc')).toBe('abc');
  });

  it('handles multiple colons correctly', () => {
    expect(extractThreadId('platform:thread:with:colons')).toBe('thread:with:colons');
  });

  it('handles empty string', () => {
    expect(extractThreadId('')).toBe('');
  });
});

describe('formatShortId with composite IDs', () => {
  it('extracts and truncates thread ID from composite ID', () => {
    expect(formatShortId('platform:thread123456789')).toBe('thread12…');
  });
});
