/**
 * Watch parser tests — validation matrix over the pure functions (no LLM
 * call), per the red-green policy.
 */

import { describe, test, expect } from 'bun:test';
import { buildWatchParsePrompt, validateParsedWatch } from './parser.js';
import { extractJsonObject } from '../claude/llm-json.js';

describe('buildWatchParsePrompt', () => {
  test('carries the request and demands strict JSON with keywords', () => {
    const prompt = buildWatchParsePrompt('when someone reports an incident, triage it');
    expect(prompt).toContain('when someone reports an incident');
    expect(prompt).toContain('"keywords"');
    expect(prompt).toContain('ONLY a JSON object');
    expect(prompt).toContain('{"error"');
    // Paraphrase coverage is part of the contract (synonyms, both languages)
    expect(prompt).toContain('synonyms');
    expect(prompt).toContain('BOTH');
  });
});

describe('extractJsonObject (shared)', () => {
  test('tolerates fences and chatter', () => {
    expect(extractJsonObject('Sure!\n```json\n{"a": 1}\n```\nDone.')).toEqual({ a: 1 });
  });
  test('rejects arrays and garbage', () => {
    expect(extractJsonObject('[1,2]')).toBeUndefined();
    expect(extractJsonObject('no json here')).toBeUndefined();
    expect(extractJsonObject('{broken')).toBeUndefined();
  });
});

describe('validateParsedWatch', () => {
  const good = {
    name: 'Incident triage',
    condition: 'someone reports a production incident',
    prompt: 'triage it',
    keywords: ['incident', 'outage'],
  };

  test('accepts a complete parse', () => {
    const result = validateParsedWatch(good);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.parsed.keywords).toEqual(['incident', 'outage']);
  });

  test('passes through the model error contract', () => {
    const result = validateParsedWatch({ error: 'not a watch request' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('not a watch request');
  });

  test('rejects missing name/condition/prompt', () => {
    expect(validateParsedWatch({ ...good, name: '' }).ok).toBe(false);
    expect(validateParsedWatch({ ...good, condition: undefined as unknown as string }).ok).toBe(false);
    expect(validateParsedWatch({ ...good, prompt: 42 as unknown as string }).ok).toBe(false);
  });

  test('rejects unusable keywords (model cannot smuggle a broken prefilter)', () => {
    expect(validateParsedWatch({ ...good, keywords: [] }).ok).toBe(false);
    expect(validateParsedWatch({ ...good, keywords: 'incident' as unknown as string[] }).ok).toBe(false);
    expect(validateParsedWatch({ ...good, keywords: [123, null] as unknown as string[] }).ok).toBe(false);
  });

  test('collapses newlines in name/condition/prompt (card-injection guard)', () => {
    const result = validateParsedWatch({
      ...good,
      name: 'Incident\n**APPROVED**\ntriage',
      condition: 'a\u0085b',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.name).toBe('Incident **APPROVED** triage');
      expect(result.parsed.condition).toBe('a b');
    }
  });

  test('normalizes keyword case and whitespace', () => {
    const result = validateParsedWatch({ ...good, keywords: ['  INCIDENT ', 'Outage'] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.parsed.keywords).toEqual(['incident', 'outage']);
  });
});
