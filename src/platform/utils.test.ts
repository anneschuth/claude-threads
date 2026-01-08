import { describe, it, expect } from 'bun:test';
import {
  getPlatformIcon,
  truncateMessage,
  truncateMessageSafely,
  splitMessage,
  extractMentions,
  isMentioned,
  normalizeEmojiName,
  getEmojiCharacter,
  getEmojiName,
  convertUnicodeEmojiToShortcodes,
  containsCodeBlock,
  extractCodeBlocks,
  formatCodeBlock,
  extractUrls,
  isValidUrl,
  isUserAllowed,
  sanitizeForLogging,
  convertMarkdownTablesToSlack,
  convertMarkdownToSlack,
  withRetry,
} from './utils.js';

describe('getPlatformIcon', () => {
  it('returns 💬 for slack', () => {
    expect(getPlatformIcon('slack')).toBe('💬');
  });

  it('returns 📢 for mattermost', () => {
    expect(getPlatformIcon('mattermost')).toBe('📢');
  });

  it('returns 💬 as default for unknown platforms', () => {
    expect(getPlatformIcon('unknown')).toBe('💬');
    expect(getPlatformIcon('')).toBe('💬');
  });
});

describe('truncateMessage', () => {
  it('returns original if within limit', () => {
    expect(truncateMessage('hello', 10)).toBe('hello');
  });

  it('truncates with ellipsis', () => {
    expect(truncateMessage('hello world', 8)).toBe('hello...');
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

  it('splits at single newline when no paragraph break', () => {
    // Content with single newline positioned at >70% of maxLength (no double newlines)
    // maxLength=50, so newline needs to be after position 35 (0.7*50)
    // "abcdefghijklmnopqrstuvwxyz0123456789012\n" = 40 chars before newline
    const content = 'abcdefghijklmnopqrstuvwxyz0123456789012\nrest of text that continues here';
    const result = splitMessage(content, 50);
    expect(result.length).toBeGreaterThan(1);
    // Should split at the newline (position 40)
    expect(result[0]).toBe('abcdefghijklmnopqrstuvwxyz0123456789012');
  });

  it('splits at sentence break when no newline available', () => {
    // Content with sentence break at >50% of maxLength, no newlines
    // maxLength=50, so sentence break needs to be after position 25 (0.5*50)
    // The result will be trimmed, so trailing space is removed
    const content = 'abcdefghijklmnopqrstuvwxyz012. rest of text continues without any breaks';
    const result = splitMessage(content, 50);
    expect(result.length).toBeGreaterThan(1);
    // Should split at the sentence break, trimmed (no trailing space)
    expect(result[0]).toBe('abcdefghijklmnopqrstuvwxyz012.');
  });

  it('splits at word boundary when no sentence break', () => {
    // Content with space at >50% of maxLength, no newlines or sentence breaks
    // maxLength=50, so space needs to be after position 25 (0.5*50)
    // Use long words without sentence-ending punctuation (. ! ?)
    // Need the only space in the first 50 chars to be at >50% position
    const content = 'abcdefghijklmnopqrstuvwxyz012345 abcdefghijklmnopqrstuvwxyz';
    const result = splitMessage(content, 50);
    expect(result.length).toBeGreaterThan(1);
    // Should split at the space (position 32), result is trimmed
    expect(result[0]).toBe('abcdefghijklmnopqrstuvwxyz012345');
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

describe('convertUnicodeEmojiToShortcodes', () => {
  it('converts known Unicode emoji to shortcodes', () => {
    expect(convertUnicodeEmojiToShortcodes('🔄 Update available')).toBe(':arrows_counterclockwise: Update available');
    expect(convertUnicodeEmojiToShortcodes('✅ Success')).toBe(':white_check_mark: Success');
    expect(convertUnicodeEmojiToShortcodes('📦 Installing')).toBe(':package: Installing');
    expect(convertUnicodeEmojiToShortcodes('🎉 Done!')).toBe(':partying_face: Done!');
  });

  it('converts stopwatch emoji to standard shortcode', () => {
    // This is used in session timeout messages - must use :stopwatch: not :clock:
    // as Mattermost doesn't recognize :clock: as a valid emoji shortcode
    expect(convertUnicodeEmojiToShortcodes('⏱️ Session timed out')).toBe(':stopwatch: Session timed out');
    expect(convertUnicodeEmojiToShortcodes('⏱️')).toBe(':stopwatch:');
  });

  it('converts multiple emoji in one message', () => {
    expect(convertUnicodeEmojiToShortcodes('👍 or 👎')).toBe(':+1: or :-1:');
  });

  it('leaves unknown Unicode emoji unchanged', () => {
    // Unicode emoji not in our mapping should pass through unchanged
    expect(convertUnicodeEmojiToShortcodes('🦄 Unicorn')).toBe('🦄 Unicorn');
  });

  it('leaves plain text unchanged', () => {
    expect(convertUnicodeEmojiToShortcodes('Hello world')).toBe('Hello world');
  });

  it('handles empty string', () => {
    expect(convertUnicodeEmojiToShortcodes('')).toBe('');
  });

  it('handles message with existing shortcodes (leaves them alone)', () => {
    expect(convertUnicodeEmojiToShortcodes(':smile: and 👍')).toBe(':smile: and :+1:');
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
  it('formats code with language and trailing newline', () => {
    expect(formatCodeBlock('const x = 1;', 'typescript')).toBe(
      '```typescript\nconst x = 1;\n```\n'
    );
  });

  it('formats code without language', () => {
    expect(formatCodeBlock('plain code')).toBe('```\nplain code\n```\n');
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

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const result = await withRetry(async () => 'success');
    expect(result).toBe('success');
  });

  it('retries on failure and eventually succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 3) throw new Error('fail');
      return 'success';
    }, { baseDelayMs: 1, maxRetries: 3 });
    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });

  it('throws after max retries', async () => {
    let attempts = 0;
    await expect(withRetry(async () => {
      attempts++;
      throw new Error('always fails');
    }, { maxRetries: 2, baseDelayMs: 1 })).rejects.toThrow('always fails');
    expect(attempts).toBe(3); // initial + 2 retries
  });

  it('respects shouldRetry predicate', async () => {
    let attempts = 0;
    await expect(withRetry(async () => {
      attempts++;
      throw new Error('non-retryable');
    }, {
      maxRetries: 3,
      baseDelayMs: 1,
      shouldRetry: () => false
    })).rejects.toThrow('non-retryable');
    expect(attempts).toBe(1); // no retries
  });
});
