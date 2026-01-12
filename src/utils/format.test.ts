import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import {
  formatShortId,
  formatSessionId,
  extractThreadId,
  formatDuration,
  formatRelativeTime,
  formatRelativeTimeShort,
  formatNumber,
  formatPercent,
  formatBytes,
  truncate,
  truncateAtWord,
  pluralize,
  logSessionAction,
  sessionLogActions,
  setSessionLogHandler,
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

describe('logSessionAction', () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    setSessionLogHandler(null); // Reset handler
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    setSessionLogHandler(null);
  });

  it('logs action with emoji and short ID', () => {
    logSessionAction('✅', 'Test action', 'thread123456789');
    expect(consoleLogSpy).toHaveBeenCalledWith('✅ Test action (thread12…)');
  });

  it('logs action with username', () => {
    logSessionAction('🛑', 'Session cancelled', 'thread123', 'alice');
    expect(consoleLogSpy).toHaveBeenCalledWith('🛑 Session cancelled (thread12…) by @alice');
  });

  it('routes through custom handler when set', () => {
    const handler = mock(() => {});
    setSessionLogHandler(handler);

    logSessionAction('✅', 'Test', 'thread123');

    expect(handler).toHaveBeenCalledWith('info', '✅ Test (thread12…)', 'thread123');
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });
});

describe('sessionLogActions', () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    setSessionLogHandler(null);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    setSessionLogHandler(null);
  });

  describe('started', () => {
    it('logs session start with user and directory', () => {
      sessionLogActions.started('thread123456789', 'alice', '/home/user/project');
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '✅ Session started (thread12…) by @alice in /home/user/project'
      );
    });
  });

  describe('cancelled', () => {
    it('logs session cancellation', () => {
      sessionLogActions.cancelled('thread123', 'bob');
      expect(consoleLogSpy).toHaveBeenCalledWith('🛑 Session cancelled (thread12…) by @bob');
    });
  });

  describe('timeout', () => {
    it('logs session timeout', () => {
      sessionLogActions.timeout('thread123');
      expect(consoleLogSpy).toHaveBeenCalledWith('⏱️ Session timed out (thread12…)');
    });
  });

  describe('resumed', () => {
    it('logs session resume with user', () => {
      sessionLogActions.resumed('thread123', 'alice');
      expect(consoleLogSpy).toHaveBeenCalledWith('🔄 Session resumed (thread12…) by @alice');
    });

    it('logs session resume without user', () => {
      sessionLogActions.resumed('thread123');
      expect(consoleLogSpy).toHaveBeenCalledWith('🔄 Session resumed (thread12…)');
    });
  });

  describe('interrupted', () => {
    it('logs session interrupt', () => {
      sessionLogActions.interrupted('thread123', 'alice');
      expect(consoleLogSpy).toHaveBeenCalledWith('⏸️ Session interrupted (thread12…) by @alice');
    });
  });

  describe('exited', () => {
    it('logs successful exit with code 0', () => {
      sessionLogActions.exited('thread123', 0);
      expect(consoleLogSpy).toHaveBeenCalledWith('✅ Session (thread12…) exited with code 0');
    });

    it('logs unsuccessful exit with non-zero code', () => {
      sessionLogActions.exited('thread123', 1);
      expect(consoleLogSpy).toHaveBeenCalledWith('⚠️ Session (thread12…) exited with code 1');
    });
  });

  describe('error', () => {
    it('logs error to stderr', () => {
      sessionLogActions.error('thread123', 'Something went wrong');
      expect(consoleErrorSpy).toHaveBeenCalledWith('⚠️ Session (thread12…): Something went wrong');
    });
  });

  describe('cdChanged', () => {
    it('logs directory change', () => {
      sessionLogActions.cdChanged('thread123', '/new/path', 'alice');
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '📂 Session (thread12…) changed to /new/path by @alice'
      );
    });
  });

  describe('invited', () => {
    it('logs user invitation', () => {
      sessionLogActions.invited('thread123', 'bob', 'alice');
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '👤 @bob invited to session (thread12…) by @alice'
      );
    });
  });

  describe('kicked', () => {
    it('logs user removal', () => {
      sessionLogActions.kicked('thread123', 'bob', 'alice');
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '👤 @bob removed from session (thread12…) by @alice'
      );
    });
  });

  describe('worktreeCreated', () => {
    it('logs worktree creation', () => {
      sessionLogActions.worktreeCreated('thread123', 'feature/new-feature');
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '🌿 Worktree created for branch "feature/new-feature" (thread12…)'
      );
    });
  });

  describe('contextPrompt', () => {
    it('logs context prompt timeout', () => {
      sessionLogActions.contextPrompt('thread123', 'timeout');
      expect(consoleLogSpy).toHaveBeenCalledWith('🧵 Session (thread12…) context: timed out');
    });

    it('logs no context selected', () => {
      sessionLogActions.contextPrompt('thread123', 0, 'alice');
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '🧵 Session (thread12…) context: no context selected by @alice'
      );
    });

    it('logs message count selected', () => {
      sessionLogActions.contextPrompt('thread123', 5, 'alice');
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '🧵 Session (thread12…) context: last 5 messages selected by @alice'
      );
    });
  });

  describe('permissionMode', () => {
    it('logs interactive permission mode', () => {
      sessionLogActions.permissionMode('thread123', 'interactive', 'alice');
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '🔐 Session (thread12…) permissions set to interactive by @alice'
      );
    });

    it('logs skip permission mode', () => {
      sessionLogActions.permissionMode('thread123', 'skip', 'alice');
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '⚡ Session (thread12…) permissions set to skip by @alice'
      );
    });
  });

  describe('debug', () => {
    it('does not log debug messages when DEBUG is not set', () => {
      const originalDebug = process.env.DEBUG;
      delete process.env.DEBUG;

      sessionLogActions.debug('thread123', 'Debug message');
      expect(consoleLogSpy).not.toHaveBeenCalled();

      process.env.DEBUG = originalDebug;
    });

    it('logs debug messages when DEBUG=1', () => {
      const originalDebug = process.env.DEBUG;
      process.env.DEBUG = '1';

      sessionLogActions.debug('thread123', 'Debug message');
      expect(consoleLogSpy).toHaveBeenCalledWith('[debug] Session (thread12…): Debug message');

      process.env.DEBUG = originalDebug;
    });
  });
});

describe('setSessionLogHandler', () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    setSessionLogHandler(null);
  });

  it('routes all logs through custom handler when set', () => {
    const handler = mock(() => {});
    setSessionLogHandler(handler);

    sessionLogActions.started('thread123', 'alice', '/path');

    expect(handler).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('Session started'),
      'thread123'
    );
  });

  it('reverts to console when handler is cleared', () => {
    const handler = mock(() => {});
    setSessionLogHandler(handler);
    setSessionLogHandler(null);

    sessionLogActions.started('thread123', 'alice', '/path');

    expect(handler).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalled();
  });
});
