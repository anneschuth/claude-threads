/**
 * Tests for the end-of-session distillation pass.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildDistillationPrompt,
  parseDistillationOutput,
  distillThread,
  MIN_THREAD_MESSAGES,
  MAX_FACTS_PER_SESSION,
} from './distiller.js';
import { MemoryStore } from './store.js';

describe('buildDistillationPrompt', () => {
  test('includes conversation, existing memory, and the exclusion rules', () => {
    const prompt = buildDistillationPrompt(
      [{ text: 'known fact', addedAt: '2026-01-01', source: 'user', addedBy: 'a' }],
      [{ username: 'anne', message: 'we decided to deploy on Tuesdays' }],
    );
    expect(prompt).toContain('anne: we decided to deploy on Tuesdays');
    expect(prompt).toContain('- known fact');
    expect(prompt).toContain('do not repeat');
    expect(prompt).toContain('secrets/tokens/credentials');
    expect(prompt).toContain('NONE');
  });

  test('says (none) when there is no existing memory', () => {
    expect(buildDistillationPrompt([], [{ username: 'a', message: 'hi' }])).toContain('(none)');
  });

  test('truncates long messages', () => {
    const prompt = buildDistillationPrompt([], [{ username: 'a', message: 'x'.repeat(5000) }]);
    expect(prompt.length).toBeLessThan(3000);
  });
});

describe('parseDistillationOutput', () => {
  test('parses bullet lines', () => {
    expect(parseDistillationOutput('- fact one\n- fact two')).toEqual(['fact one', 'fact two']);
  });

  test('NONE and empty output produce nothing', () => {
    expect(parseDistillationOutput('NONE')).toEqual([]);
    expect(parseDistillationOutput('  none  ')).toEqual([]);
    expect(parseDistillationOutput('')).toEqual([]);
  });

  test('ignores chatter around bullets', () => {
    const out = parseDistillationOutput('Sure! Here are the facts:\n- the real fact\nHope that helps!');
    expect(out).toEqual(['the real fact']);
  });

  test('caps at the per-session maximum', () => {
    const out = parseDistillationOutput(
      Array.from({ length: 10 }, (_, i) => `- fact ${i}`).join('\n'),
    );
    expect(out).toHaveLength(MAX_FACTS_PER_SESSION);
  });

  test('drops overlong and too-short lines', () => {
    expect(parseDistillationOutput(`- ${'x'.repeat(300)}`)).toEqual([]);
    expect(parseDistillationOutput('- ab')).toEqual([]);
  });
});

describe('distillThread', () => {
  let root: string;
  let store: MemoryStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ct-distill-test-'));
    store = new MemoryStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('skips short threads without any model call', async () => {
    const platform = {
      getThreadHistory: async () =>
        Array.from({ length: MIN_THREAD_MESSAGES - 1 }, (_, i) => ({
          username: 'a',
          message: `msg ${i}`,
        })),
    };
    // No CLAUDE_PATH stub needed: the quickQuery call must never happen.
    const added = await distillThread(store, 'mm', 't1', platform as never);
    expect(added).toBe(0);
    expect(store.listChannelEntries('mm')).toHaveLength(0);
  });
});
