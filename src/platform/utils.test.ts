import { describe, it, expect } from 'bun:test';
import {
  getPlatformIcon,
  truncateMessageSafely,
  normalizeEmojiName,
  getEmojiName,
  formatWebSocketError,
} from './utils.js';

describe('getPlatformIcon', () => {
  it('returns 𝓜 with space for mattermost', () => {
    expect(getPlatformIcon('mattermost')).toBe('𝓜 ');
  });

  it('returns 💬 with space as default for unknown platforms', () => {
    expect(getPlatformIcon('unknown')).toBe('💬 ');
    expect(getPlatformIcon('')).toBe('💬 ');
  });
});

describe('truncateMessageSafely', () => {
  it('returns original if within limit', () => {
    expect(truncateMessageSafely('hello', 100)).toBe('hello');
  });

  it('truncates with default indicator', () => {
    const result = truncateMessageSafely('a'.repeat(200), 100);
    expect(result).toContain('... (truncated)');
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it('uses custom truncation indicator', () => {
    const result = truncateMessageSafely('a'.repeat(200), 100, '_truncated_');
    expect(result).toContain('_truncated_');
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it('closes open code blocks when truncating', () => {
    const content = '```javascript\nconst x = 1;\nconst y = 2;\n' + 'a'.repeat(200);
    const result = truncateMessageSafely(content, 100);

    // Count ``` markers - should be even (properly closed)
    const markers = (result.match(/```/g) || []).length;
    expect(markers % 2).toBe(0);
    expect(result).toContain('... (truncated)');
  });

  it('does not add extra closing when code block is already closed', () => {
    const content = '```javascript\nconst x = 1;\n```\n\nSome text after\n' + 'a'.repeat(200);
    const result = truncateMessageSafely(content, 100);

    // Count ``` markers - should be even (properly closed)
    const markers = (result.match(/```/g) || []).length;
    expect(markers % 2).toBe(0);
  });

  it('handles multiple code blocks with last one open', () => {
    const content = '```js\ncode1\n```\n\nText\n\n```python\ncode2\n' + 'a'.repeat(200);
    const result = truncateMessageSafely(content, 120);

    // Count ``` markers - should be even (properly closed)
    const markers = (result.match(/```/g) || []).length;
    expect(markers % 2).toBe(0);
  });

  it('handles content with no code blocks', () => {
    const content = 'Just plain text without any code blocks ' + 'a'.repeat(200);
    const result = truncateMessageSafely(content, 100);

    expect(result).not.toContain('```');
    expect(result).toContain('... (truncated)');
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

describe('getEmojiName', () => {
  it('converts Unicode emoji to shortcode names', () => {
    expect(getEmojiName('👍')).toBe('+1');
    expect(getEmojiName('👎')).toBe('-1');
    expect(getEmojiName('✅')).toBe('white_check_mark');
    expect(getEmojiName('❌')).toBe('x');
    expect(getEmojiName('🔄')).toBe('arrows_counterclockwise');
    expect(getEmojiName('🎉')).toBe('partying_face');
    expect(getEmojiName('⏱️')).toBe('stopwatch');
  });

  it('returns shortcode names unchanged', () => {
    expect(getEmojiName('+1')).toBe('+1');
    expect(getEmojiName('thumbsup')).toBe('thumbsup');
    expect(getEmojiName('white_check_mark')).toBe('white_check_mark');
  });

  it('returns unknown emoji/names unchanged', () => {
    expect(getEmojiName('custom_emoji')).toBe('custom_emoji');
    expect(getEmojiName('🦄')).toBe('🦄'); // Not in our mapping
  });
});

describe('formatWebSocketError', () => {
  it('returns message from plain Error', () => {
    expect(formatWebSocketError(new Error('connection refused'))).toBe('connection refused');
  });

  it('extracts message from browser-style ErrorEvent-shaped object', () => {
    // This is the shape recent Node/undici pass to ws.onerror — a template
    // literal on this object produces the useless `[object ErrorEvent]`.
    const event = { type: 'error', message: 'socket hang up', error: new Error('socket hang up') };
    expect(formatWebSocketError(event)).toBe('socket hang up');
  });

  it('falls back to nested .error.message when .message is absent', () => {
    const event = { type: 'error', error: new Error('ECONNRESET') };
    expect(formatWebSocketError(event)).toBe('ECONNRESET');
  });

  it('uses .type with .code when only the wrapper is populated', () => {
    const event = { type: 'error', code: 1006 };
    expect(formatWebSocketError(event)).toBe('error (code: 1006)');
  });

  it('falls back to String() for truly opaque values', () => {
    expect(formatWebSocketError('raw string')).toBe('raw string');
    expect(formatWebSocketError(42)).toBe('42');
    expect(formatWebSocketError(null)).toBe('null');
  });

  it('never produces the [object ErrorEvent] sentinel', () => {
    // Regression guard: the bug was that `${event}` on a browser-style
    // ErrorEvent stringified to `[object ErrorEvent]`. Any shape we feed
    // the formatter must produce something that is not that literal.
    const shapes: unknown[] = [
      new Error('x'),
      { type: 'error', message: 'y' },
      { type: 'error', error: new Error('z') },
      { type: 'error', code: 1006 },
      'raw',
      null,
    ];
    for (const s of shapes) {
      expect(formatWebSocketError(s)).not.toContain('[object');
    }
  });
});
