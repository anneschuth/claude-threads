/**
 * Tests for the natural-language routine parser's validation layer — the
 * pure functions the LLM output must pass through. The quickQuery call
 * itself is exercised in the live manual checklist.
 */

import { describe, test, expect } from 'bun:test';
import {
  buildParsePrompt,
  extractJsonObject,
  validateParsedRoutine,
  hostTimezone,
} from './parser.js';

describe('buildParsePrompt', () => {
  test('embeds the request and the default timezone', () => {
    const prompt = buildParsePrompt('every weekday at 9, standup', 'Europe/Amsterdam');
    expect(prompt).toContain('every weekday at 9, standup');
    expect(prompt).toContain('Europe/Amsterdam');
    expect(prompt).toContain('sub-hourly is not supported');
  });
});

describe('extractJsonObject', () => {
  test('parses a bare object', () => {
    expect(extractJsonObject('{"a": 1}')).toEqual({ a: 1 });
  });

  test('tolerates chatter and code fences around the object', () => {
    expect(extractJsonObject('Sure!\n```json\n{"a": 1}\n```\nDone.')).toEqual({ a: 1 });
  });

  test('returns undefined for garbage, arrays, and no JSON', () => {
    expect(extractJsonObject('no json here')).toBeUndefined();
    expect(extractJsonObject('{broken')).toBeUndefined();
    expect(extractJsonObject('[1,2]')).toBeUndefined();
  });
});

describe('validateParsedRoutine', () => {
  const TZ = 'Europe/Amsterdam';

  test('accepts a complete daily parse', () => {
    const result = validateParsedRoutine(
      { name: 'Standup', prompt: 'summarize threads', preset: 'weekdays', time: '09:00' },
      TZ,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.schedule).toEqual({ preset: 'weekdays', time: '09:00', timezone: TZ });
    expect(result.timezoneDefaulted).toBe(true);
  });

  test('an explicit timezone wins over the default', () => {
    const result = validateParsedRoutine(
      { name: 'X', prompt: 'y', preset: 'daily', time: '09:00', timezone: 'America/Los_Angeles' },
      TZ,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.schedule.timezone).toBe('America/Los_Angeles');
    expect(result.timezoneDefaulted).toBe(false);
  });

  test('propagates a model-reported error', () => {
    const result = validateParsedRoutine({ error: 'not a schedule request' }, TZ);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('not a schedule request');
  });

  test('rejects missing name/prompt/preset and invalid fields from the model', () => {
    expect(validateParsedRoutine({ prompt: 'y', preset: 'daily', time: '09:00' }, TZ).ok).toBe(false);
    expect(validateParsedRoutine({ name: 'X', preset: 'daily', time: '09:00' }, TZ).ok).toBe(false);
    expect(validateParsedRoutine({ name: 'X', prompt: 'y', preset: 'every-minute', time: '09:00' }, TZ).ok).toBe(false);
    expect(validateParsedRoutine({ name: 'X', prompt: 'y', preset: 'daily', time: '9am' }, TZ).ok).toBe(false);
    expect(validateParsedRoutine({ name: 'X', prompt: 'y', preset: 'weekly', time: '09:00', weekday: 9 }, TZ).ok).toBe(false);
    expect(validateParsedRoutine({ name: 'X', prompt: 'y', preset: 'daily', time: '09:00', timezone: 'Nope/Nope' }, TZ).ok).toBe(false);
  });

  test('hourly ignores time and weekday', () => {
    const result = validateParsedRoutine({ name: 'X', prompt: 'y', preset: 'hourly' }, TZ);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.schedule).toEqual({ preset: 'hourly', timezone: TZ });
  });
});

describe('hostTimezone', () => {
  test('returns a resolvable IANA zone', () => {
    const tz = hostTimezone();
    expect(typeof tz).toBe('string');
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz })).not.toThrow();
  });
});
