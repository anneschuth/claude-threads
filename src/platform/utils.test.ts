import { describe, it, expect } from 'bun:test';
import {
  getPlatformIcon,
  truncateMessageSafely,
  normalizeEmojiName,
  getEmojiName,
  convertMarkdownTablesToSlack,
  convertMarkdownToSlack,
  formatWebSocketError,
} from './utils.js';

describe('getPlatformIcon', () => {
  it('returns 🆂 with space for slack', () => {
    expect(getPlatformIcon('slack')).toBe('🆂 ');
  });

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

describe('convertMarkdownTablesToSlack', () => {
  it('converts a simple markdown table to Slack list format', () => {
    const input = `| Command | Description |
|---------|-------------|
| !help | Show help |
| !stop | Stop session |`;
    const expected = `*Command:* !help · *Description:* Show help
*Command:* !stop · *Description:* Stop session`;
    expect(convertMarkdownTablesToSlack(input)).toBe(expected);
  });

  it('handles tables with colons in separator row', () => {
    const input = `| Name | Value |
|:-----|------:|
| Foo | Bar |`;
    const expected = `*Name:* Foo · *Value:* Bar`;
    expect(convertMarkdownTablesToSlack(input)).toBe(expected);
  });

  it('preserves content around tables', () => {
    const input = `Here is a table:

| A | B |
|---|---|
| 1 | 2 |

And more text.`;
    const result = convertMarkdownTablesToSlack(input);
    expect(result).toContain('Here is a table:');
    expect(result).toContain('*A:* 1 · *B:* 2');
    expect(result).toContain('And more text.');
  });

  it('handles content without tables', () => {
    const input = 'Just regular text with no tables';
    expect(convertMarkdownTablesToSlack(input)).toBe(input);
  });

  it('handles empty rows', () => {
    const input = `| Header |
|--------|`;
    expect(convertMarkdownTablesToSlack(input)).toBe(`| Header |
|--------|`);
  });

  it('handles multiple tables', () => {
    const input = `| A | B |
|---|---|
| 1 | 2 |

Some text

| C | D |
|---|---|
| 3 | 4 |`;
    const result = convertMarkdownTablesToSlack(input);
    expect(result).toContain('*A:* 1 · *B:* 2');
    expect(result).toContain('Some text');
    expect(result).toContain('*C:* 3 · *D:* 4');
  });
});

describe('convertMarkdownToSlack', () => {
  describe('bold conversion', () => {
    it('converts double asterisks to single asterisks', () => {
      const input = 'This is **bold** text';
      expect(convertMarkdownToSlack(input)).toBe('This is *bold* text');
    });

    it('handles multiple bold sections', () => {
      const input = '**Option 1** - Description **Option 2** - More';
      expect(convertMarkdownToSlack(input)).toBe('*Option 1* - Description *Option 2* - More');
    });

    it('preserves already-correct single asterisks', () => {
      const input = 'This is *already slack bold* text';
      expect(convertMarkdownToSlack(input)).toBe('This is *already slack bold* text');
    });
  });

  describe('header conversion', () => {
    it('converts h1 headers to bold', () => {
      const input = '# Main Heading';
      expect(convertMarkdownToSlack(input)).toBe('*Main Heading*');
    });

    it('converts h2 headers to bold', () => {
      const input = '## Section Heading';
      expect(convertMarkdownToSlack(input)).toBe('*Section Heading*');
    });

    it('converts h3-h6 headers to bold', () => {
      expect(convertMarkdownToSlack('### H3')).toBe('*H3*');
      expect(convertMarkdownToSlack('#### H4')).toBe('*H4*');
      expect(convertMarkdownToSlack('##### H5')).toBe('*H5*');
      expect(convertMarkdownToSlack('###### H6')).toBe('*H6*');
    });

    it('handles headers with bold text inside', () => {
      const input = '## **Bold Header**';
      expect(convertMarkdownToSlack(input)).toBe('**Bold Header**');
    });

    it('handles multiple headers', () => {
      const input = `# Title

## Section 1
Content here

## Section 2
More content`;
      const result = convertMarkdownToSlack(input);
      expect(result).toContain('*Title*');
      expect(result).toContain('*Section 1*');
      expect(result).toContain('*Section 2*');
    });
  });

  describe('link conversion', () => {
    it('converts standard markdown links to Slack format', () => {
      const input = 'Check out [Claude Code](https://claude.ai)';
      expect(convertMarkdownToSlack(input)).toBe('Check out <https://claude.ai|Claude Code>');
    });

    it('handles multiple links', () => {
      const input = '[Link1](https://a.com) and [Link2](https://b.com)';
      expect(convertMarkdownToSlack(input)).toBe('<https://a.com|Link1> and <https://b.com|Link2>');
    });
  });

  describe('horizontal rule conversion', () => {
    it('converts --- to unicode line', () => {
      const input = 'Text above\n---\nText below';
      expect(convertMarkdownToSlack(input)).toContain('━━━━━━━━━━━━━━━━━━━━');
    });

    it('converts *** to unicode line', () => {
      const input = '***';
      expect(convertMarkdownToSlack(input)).toBe('━━━━━━━━━━━━━━━━━━━━');
    });

    it('converts ___ to unicode line', () => {
      const input = '___';
      expect(convertMarkdownToSlack(input)).toBe('━━━━━━━━━━━━━━━━━━━━');
    });
  });

  describe('code block preservation', () => {
    it('does not modify content inside fenced code blocks', () => {
      const input = '```\n**bold** and ## heading\n```';
      expect(convertMarkdownToSlack(input)).toBe('```\n**bold** and ## heading\n```');
    });

    it('does not modify content inside code blocks with language', () => {
      const input = '```javascript\nconst x = **bold**;\n```';
      expect(convertMarkdownToSlack(input)).toBe('```javascript\nconst x = **bold**;\n```');
    });

    it('does not modify inline code', () => {
      const input = 'Use `**bold**` syntax for bold';
      expect(convertMarkdownToSlack(input)).toBe('Use `**bold**` syntax for bold');
    });

    it('preserves code blocks while converting surrounding text', () => {
      const input = `## Heading

\`\`\`
**not converted**
\`\`\`

**this is converted**`;
      const result = convertMarkdownToSlack(input);
      expect(result).toContain('*Heading*');
      expect(result).toContain('```\n**not converted**\n```');
      expect(result).toContain('*this is converted*');
    });
  });

  describe('table conversion', () => {
    it('converts markdown tables to Slack format', () => {
      const input = `| Command | Description |
|---------|-------------|
| !help | Show help |`;
      expect(convertMarkdownToSlack(input)).toContain('*Command:*');
    });
  });

  describe('combined conversions', () => {
    it('handles message with multiple markdown features', () => {
      const input = `## Alternative keyboard options:

1. **Shift+1-9** - Mirrors the existing 1-9 for sessions
2. **Alt/Option+1-9** - Similar pattern, uses Option key on Mac

---

I'd recommend **Shift+1-9** since it's intuitive.

Check out [the docs](https://example.com) for more info.`;

      const result = convertMarkdownToSlack(input);

      // Headers converted
      expect(result).toContain('*Alternative keyboard options:*');

      // Bold converted
      expect(result).toContain('*Shift+1-9*');
      expect(result).toContain('*Alt/Option+1-9*');

      // Horizontal rule converted
      expect(result).toContain('━━━━━━━━━━━━━━━━━━━━');

      // Links converted
      expect(result).toContain('<https://example.com|the docs>');
    });
  });

  describe('passthrough cases', () => {
    it('returns content unchanged if no markdown patterns', () => {
      const input = 'Just regular text without any special formatting';
      expect(convertMarkdownToSlack(input)).toBe(input);
    });

    it('preserves numbered lists', () => {
      const input = '1. First item\n2. Second item\n3. Third item';
      expect(convertMarkdownToSlack(input)).toBe(input);
    });

    it('preserves bullet lists', () => {
      const input = '- First item\n- Second item\n- Third item';
      expect(convertMarkdownToSlack(input)).toBe(input);
    });
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
