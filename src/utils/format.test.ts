import { describe, it, expect } from 'bun:test';
import {
  formatShortId,
  formatSessionId,
  formatDuration,
  formatRelativeTime,
  formatRelativeTimeShort,
  formatNumber,
  formatPercent,
  formatBytes,
  truncate,
  pluralize,
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

describe('formatSessionId', () => {
  it('wraps short ID in parentheses', () => {
    expect(formatSessionId('abc12345xyz')).toBe('(abc12345…)');
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

describe('formatRelativeTime', () => {
  it('formats just now', () => {
    const now = new Date();
    expect(formatRelativeTime(now)).toBe('just now');
  });

  it('formats minutes ago', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    expect(formatRelativeTime(fiveMinutesAgo)).toBe('5 minutes ago');
  });

  it('formats singular minute', () => {
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
    expect(formatRelativeTime(oneMinuteAgo)).toBe('1 minute ago');
  });

  it('formats hours ago', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    expect(formatRelativeTime(twoHoursAgo)).toBe('2 hours ago');
  });

  it('formats days ago', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(threeDaysAgo)).toBe('3 days ago');
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

describe('formatNumber', () => {
  it('formats small numbers', () => {
    expect(formatNumber(42)).toBe('42');
    expect(formatNumber(999)).toBe('999');
  });

  it('formats numbers with thousands separator', () => {
    expect(formatNumber(1000)).toBe('1,000');
    expect(formatNumber(1234567)).toBe('1,234,567');
  });
});

describe('formatPercent', () => {
  it('formats percentage value', () => {
    expect(formatPercent(75)).toBe('75%');
    expect(formatPercent(100)).toBe('100%');
  });

  it('formats decimal as percentage', () => {
    expect(formatPercent(0.75, true)).toBe('75%');
    expect(formatPercent(0.5, true)).toBe('50%');
  });

  it('rounds to nearest integer', () => {
    expect(formatPercent(33.33)).toBe('33%');
    expect(formatPercent(66.67)).toBe('67%');
  });
});

describe('formatBytes', () => {
  it('formats bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(500)).toBe('500 B');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('formats megabytes', () => {
    expect(formatBytes(1048576)).toBe('1 MB');
    expect(formatBytes(5242880)).toBe('5 MB');
  });

  it('formats gigabytes', () => {
    expect(formatBytes(1073741824)).toBe('1 GB');
  });
});

describe('truncate', () => {
  it('returns original string if within limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('truncates with ellipsis when over limit', () => {
    expect(truncate('hello world', 8)).toBe('hello w…');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });
});

describe('pluralize', () => {
  it('uses singular for count of 1', () => {
    expect(pluralize(1, 'session')).toBe('1 session');
    expect(pluralize(1, 'file')).toBe('1 file');
  });

  it('uses plural for count other than 1', () => {
    expect(pluralize(0, 'session')).toBe('0 sessions');
    expect(pluralize(2, 'session')).toBe('2 sessions');
    expect(pluralize(100, 'file')).toBe('100 files');
  });

  it('uses custom plural form', () => {
    expect(pluralize(2, 'child', 'children')).toBe('2 children');
    expect(pluralize(1, 'child', 'children')).toBe('1 child');
  });
});
