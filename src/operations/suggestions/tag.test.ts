/**
 * Tests for session tag suggestion parsing and validation
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { buildTagPrompt, parseTags, isValidTag, VALID_TAGS, suggestSessionTags } from './tag.js';
import type { QuickQueryResult } from '../../claude/quick-query.js';

// Mock quickQuery for suggestSessionTags tests
const mockQuickQuery = mock(
  (): Promise<QuickQueryResult> =>
    Promise.resolve({ success: true, response: 'bug-fix', durationMs: 100 })
);
mock.module('../../claude/quick-query.js', () => ({
  quickQuery: mockQuickQuery,
}));

describe('isValidTag', () => {
  it('returns true for all valid tags', () => {
    for (const tag of VALID_TAGS) {
      expect(isValidTag(tag)).toBe(true);
    }
  });

  it('returns false for invalid tags', () => {
    expect(isValidTag('invalid')).toBe(false);
    expect(isValidTag('not-a-tag')).toBe(false);
    expect(isValidTag('bugfix')).toBe(false); // close but not exact
    expect(isValidTag('BUG-FIX')).toBe(false); // case matters before lowercasing
  });

  it('returns false for empty string', () => {
    expect(isValidTag('')).toBe(false);
  });

  it('returns false for whitespace', () => {
    expect(isValidTag(' ')).toBe(false);
    expect(isValidTag('  bug-fix  ')).toBe(false); // whitespace around valid tag
  });

  it('returns false for partial matches', () => {
    expect(isValidTag('bug')).toBe(false);
    expect(isValidTag('fix')).toBe(false);
    expect(isValidTag('doc')).toBe(false); // should be 'docs'
    expect(isValidTag('feat')).toBe(false); // should be 'feature'
  });

  it('returns true for feature tag', () => {
    // 'feature' is a valid tag in VALID_TAGS
    expect(isValidTag('feature')).toBe(true);
  });
});

describe('parseTags', () => {
  it('parses comma-separated tags', () => {
    const response = 'bug-fix, feature, refactor';
    const tags = parseTags(response);

    expect(tags).toHaveLength(3);
    expect(tags).toContain('bug-fix');
    expect(tags).toContain('feature');
    expect(tags).toContain('refactor');
  });

  it('parses newline-separated tags', () => {
    const response = 'bug-fix\nfeature\nrefactor';
    const tags = parseTags(response);

    expect(tags).toHaveLength(3);
    expect(tags).toContain('bug-fix');
    expect(tags).toContain('feature');
    expect(tags).toContain('refactor');
  });

  it('parses mixed comma and newline separators', () => {
    const response = 'bug-fix, feature\nrefactor';
    const tags = parseTags(response);

    expect(tags).toHaveLength(3);
    expect(tags).toContain('bug-fix');
    expect(tags).toContain('feature');
    expect(tags).toContain('refactor');
  });

  it('handles uppercase input by converting to lowercase', () => {
    const response = 'BUG-FIX, FEATURE, REFACTOR';
    const tags = parseTags(response);

    expect(tags).toHaveLength(3);
    expect(tags).toContain('bug-fix');
    expect(tags).toContain('feature');
    expect(tags).toContain('refactor');
  });

  it('handles mixed case input', () => {
    const response = 'Bug-Fix, Feature, Refactor';
    const tags = parseTags(response);

    expect(tags).toHaveLength(3);
    expect(tags).toContain('bug-fix');
    expect(tags).toContain('feature');
    expect(tags).toContain('refactor');
  });

  it('filters out invalid tags', () => {
    const response = 'bug-fix, invalid-tag, feature, not-valid, refactor';
    const tags = parseTags(response);

    expect(tags).toHaveLength(3);
    expect(tags).toContain('bug-fix');
    expect(tags).toContain('feature');
    expect(tags).toContain('refactor');
    expect(tags).not.toContain('invalid-tag');
    expect(tags).not.toContain('not-valid');
  });

  it('deduplicates tags', () => {
    const response = 'bug-fix, bug-fix, feature, feature, bug-fix';
    const tags = parseTags(response);

    expect(tags).toHaveLength(2);
    expect(tags).toContain('bug-fix');
    expect(tags).toContain('feature');
  });

  it('limits to maximum of 3 tags', () => {
    const response = 'bug-fix, feature, refactor, docs, test, config';
    const tags = parseTags(response);

    expect(tags).toHaveLength(3);
    expect(tags).toEqual(['bug-fix', 'feature', 'refactor']);
  });

  it('handles empty response', () => {
    const tags = parseTags('');
    expect(tags).toEqual([]);
  });

  it('handles whitespace-only response', () => {
    const tags = parseTags('   \n  \n   ');
    expect(tags).toEqual([]);
  });

  it('trims whitespace from tags', () => {
    const response = '  bug-fix  ,  feature  ,  refactor  ';
    const tags = parseTags(response);

    expect(tags).toHaveLength(3);
    expect(tags).toContain('bug-fix');
    expect(tags).toContain('feature');
    expect(tags).toContain('refactor');
  });

  it('handles response with only invalid tags', () => {
    const response = 'invalid, not-a-tag, wrong';
    const tags = parseTags(response);

    expect(tags).toEqual([]);
  });

  it('handles response with extra comma-separated text', () => {
    // If Claude adds extra text with commas, only valid tags are extracted
    const response = 'bug-fix, some extra text, performance, invalid';
    const tags = parseTags(response);

    // Only valid tags should be extracted
    expect(tags).toContain('bug-fix');
    expect(tags).toContain('performance');
    expect(tags).not.toContain('some extra text');
    expect(tags).not.toContain('invalid');
    expect(tags).toHaveLength(2);
  });

  it('filters out text that is not a valid tag', () => {
    // parseTags splits on comma/newline and trims, but won't extract tags embedded in text
    const response = 'I suggest: bug-fix\nperformance';
    const tags = parseTags(response);

    // "I suggest: bug-fix" as a whole is not a valid tag
    // "performance" on its own line is valid
    expect(tags).toContain('performance');
    expect(tags).not.toContain('bug-fix'); // embedded in "I suggest: bug-fix"
  });

  it('parses all valid tag types', () => {
    const response = VALID_TAGS.join(', ');
    const tags = parseTags(response);

    // Should get first 3 due to MAX_TAGS limit
    expect(tags).toHaveLength(3);
    expect(tags).toEqual(['bug-fix', 'feature', 'refactor']);
  });
});

describe('buildTagPrompt', () => {
  it('builds prompt with user message', () => {
    const prompt = buildTagPrompt('fix the login button not working');

    expect(prompt).toContain('fix the login button not working');
    expect(prompt).toContain('Classify this task');
    expect(prompt).toContain('1-3 tags');
  });

  it('includes all valid tags in the prompt', () => {
    const prompt = buildTagPrompt('some task');

    for (const tag of VALID_TAGS) {
      expect(prompt).toContain(tag);
    }
  });

  it('instructs to output only tags', () => {
    const prompt = buildTagPrompt('some task');

    expect(prompt).toContain('Output ONLY the tags');
    expect(prompt).toContain('comma-separated');
    expect(prompt).toContain('nothing else');
  });

  it('truncates long messages to 500 characters', () => {
    const longMessage = 'a'.repeat(600);
    const prompt = buildTagPrompt(longMessage);

    // Should contain truncated message (500 chars + ...)
    expect(prompt).toContain('a'.repeat(500) + '...');
    expect(prompt).not.toContain('a'.repeat(501));
  });

  it('does not truncate messages under 500 characters', () => {
    const shortMessage = 'a'.repeat(400);
    const prompt = buildTagPrompt(shortMessage);

    expect(prompt).toContain(shortMessage);
    expect(prompt).not.toContain('...');
  });

  it('does not truncate messages exactly 500 characters', () => {
    const exactMessage = 'a'.repeat(500);
    const prompt = buildTagPrompt(exactMessage);

    expect(prompt).toContain(exactMessage);
    expect(prompt).not.toContain('...');
  });

  it('truncates messages at 501 characters', () => {
    const message = 'a'.repeat(501);
    const prompt = buildTagPrompt(message);

    expect(prompt).toContain('a'.repeat(500) + '...');
  });

  it('handles empty message', () => {
    const prompt = buildTagPrompt('');

    expect(prompt).toContain('Task: ""');
    expect(prompt).toContain('Classify this task');
  });

  it('handles special characters in message', () => {
    const message = 'fix bug with "quotes" and <brackets>';
    const prompt = buildTagPrompt(message);

    expect(prompt).toContain(message);
  });

  it('handles newlines in message', () => {
    const message = 'fix bug\nwith multiple\nlines';
    const prompt = buildTagPrompt(message);

    expect(prompt).toContain(message);
  });

  it('wraps message in quotes', () => {
    const prompt = buildTagPrompt('fix the bug');

    expect(prompt).toContain('Task: "fix the bug"');
  });
});

describe('suggestSessionTags', () => {
  beforeEach(() => {
    mockQuickQuery.mockClear();
  });

  it('returns parsed tags on successful query', async () => {
    mockQuickQuery.mockResolvedValueOnce({
      success: true,
      response: 'bug-fix, feature',
      durationMs: 100,
    });

    const tags = await suggestSessionTags('fix the login button');

    expect(tags).toContain('bug-fix');
    expect(tags).toContain('feature');
    expect(mockQuickQuery).toHaveBeenCalledTimes(1);
  });

  it('returns empty array when query fails', async () => {
    mockQuickQuery.mockResolvedValueOnce({
      success: false,
      error: 'timeout',
      durationMs: 2000,
    });

    const tags = await suggestSessionTags('some task');

    expect(tags).toEqual([]);
  });

  it('returns empty array when response is empty', async () => {
    mockQuickQuery.mockResolvedValueOnce({
      success: true,
      response: '',
      durationMs: 100,
    });

    const tags = await suggestSessionTags('some task');

    expect(tags).toEqual([]);
  });

  it('returns empty array on exception', async () => {
    mockQuickQuery.mockRejectedValueOnce(new Error('Network error'));

    const tags = await suggestSessionTags('some task');

    expect(tags).toEqual([]);
  });

  it('passes correct parameters to quickQuery', async () => {
    mockQuickQuery.mockResolvedValueOnce({
      success: true,
      response: 'bug-fix',
      durationMs: 100,
    });

    await suggestSessionTags('fix login issue');

    expect(mockQuickQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'haiku',
        timeout: 15000,
      })
    );
    // Check prompt contains the user message
    const call = mockQuickQuery.mock.calls[0] as unknown as [{ prompt: string }];
    expect(call[0].prompt).toContain('fix login issue');
  });
});
