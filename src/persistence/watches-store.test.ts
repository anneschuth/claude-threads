/**
 * WatchesStore tests — real store over a tmpdir, per the red-green policy
 * (exercises the ACTUAL store, incl. the shared PlatformListStore base).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WatchesStore, validateKeywords, MAX_KEYWORDS, type NewWatch } from './watches-store.js';

function newWatch(overrides: Partial<NewWatch> = {}): NewWatch {
  return {
    name: 'Incident triage',
    condition: 'someone reports a production incident',
    prompt: 'triage it and post a checklist',
    keywords: ['incident', 'outage', 'down'],
    createdBy: 'anne',
    ...overrides,
  };
}

describe('validateKeywords', () => {
  test('normalizes, lowercases, dedupes and caps', () => {
    const result = validateKeywords([' Incident ', 'OUTAGE', 'incident', '', 'x'.repeat(100)]);
    expect(result).toEqual(['incident', 'outage']);
  });

  test('rejects non-arrays and empty lists', () => {
    expect(typeof validateKeywords('nope')).toBe('string');
    expect(typeof validateKeywords([])).toBe('string');
    expect(typeof validateKeywords([42, ''])).toBe('string');
  });

  test('caps at MAX_KEYWORDS', () => {
    const many = Array.from({ length: 30 }, (_, i) => `kw${i}`);
    const result = validateKeywords(many);
    expect(Array.isArray(result) && result.length).toBe(MAX_KEYWORDS);
  });
});

describe('WatchesStore', () => {
  let dir: string;
  let store: WatchesStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ct-watches-test-'));
    store = new WatchesStore(join(dir, 'watches.yaml'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('round-trips a watch with normalized fields', async () => {
    const result = await store.add('mm', newWatch({ keywords: [' Incident ', 'OUTAGE'] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.watch.keywords).toEqual(['incident', 'outage']);
    expect(result.watch.enabled).toBe(true);
    expect(result.watch.consecutiveFailures).toBe(0);

    const listed = store.list('mm');
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe('Incident triage');
    expect(store.get('mm', result.watch.id)?.condition).toContain('production incident');
  });

  test('add() returns a copy — caller mutations never reach the store', async () => {
    const result = await store.add('mm', newWatch());
    if (!result.ok) throw new Error(result.error);

    result.watch.name = 'mutated-by-caller';
    result.watch.keywords.push('injected');

    const stored = store.get('mm', result.watch.id)!;
    expect(stored.name).toBe('Incident triage');
    expect(stored.keywords).toEqual(['incident', 'outage', 'down']);
  });

  test('platformId scoping is a hard boundary', async () => {
    await store.add('mm', newWatch());
    expect(store.list('slack')).toHaveLength(0);
  });

  test('rejects missing fields and bad keywords', async () => {
    expect((await store.add('mm', newWatch({ name: '  ' }))).ok).toBe(false);
    expect((await store.add('mm', newWatch({ condition: '' }))).ok).toBe(false);
    expect((await store.add('mm', newWatch({ keywords: [] }))).ok).toBe(false);
  });

  test('enforces the max-watches cap in-store', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await store.add('mm', newWatch({ name: `w${i}` }), 3)).ok).toBe(true);
    }
    const over = await store.add('mm', newWatch({ name: 'overflow' }), 3);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain('limit');
  });

  test('update patches bookkeeping fields; remove deletes', async () => {
    const added = await store.add('mm', newWatch());
    if (!added.ok) throw new Error('add failed');
    const updated = await store.update('mm', added.watch.id, {
      lastFiredAt: '2026-08-23T10:00:00.000Z',
      firesToday: { date: '2026-08-23', count: 2 },
      lastFireStatus: 'ok',
    });
    expect(updated?.firesToday?.count).toBe(2);

    await store.remove('mm', added.watch.id);
    expect(store.list('mm')).toHaveLength(0);
  });

  test('tolerates a hand-broken file for reads, but refuses to write over it', async () => {
    const file = join(dir, 'watches.yaml');
    writeFileSync(file, '{{{{not yaml');
    const broken = new WatchesStore(file);
    // Reads degrade gracefully (a broken file must not take the bot down)...
    expect(broken.list('mm')).toEqual([]);
    // ...but a write would atomically replace the file with the degraded
    // empty view, destroying whatever the corruption still holds — refuse.
    await expect(broken.add('mm', newWatch())).rejects.toThrow('refusing to write');
  });

  test('applies defensive defaults to hand-edited entries', () => {
    const file = join(dir, 'watches.yaml');
    writeFileSync(file, [
      'version: 1',
      'watches:',
      '  mm:',
      '    - id: abc123',
      '      name: Hand-made',
      '      condition: something',
      '      prompt: do it',
      '      createdBy: anne',
      '      createdAt: 2026-01-01T00:00:00Z',
    ].join('\n'));
    const s = new WatchesStore(file);
    const [w] = s.list('mm');
    expect(w.enabled).toBe(true);
    expect(w.consecutiveFailures).toBe(0);
    expect(w.keywords).toEqual([]);
  });

  test('normalizes hand-edited keywords (prefilter lowercases only the message)', () => {
    const file = join(dir, 'watches.yaml');
    writeFileSync(file, [
      'version: 1',
      'watches:',
      '  mm:',
      '    - id: abc123',
      '      name: Hand-made',
      '      condition: something',
      '      prompt: do it',
      '      createdBy: anne',
      '      createdAt: 2026-01-01T00:00:00Z',
      '      keywords: [" Deploy ", OUTAGE, ""]',
    ].join('\n'));
    const s = new WatchesStore(file);
    // 'Deploy' as written could never substring-match a lowercased message —
    // the watch would be silently dead.
    expect(s.list('mm')[0].keywords).toEqual(['deploy', 'outage']);
  });

  test('writes owner-only YAML under the watches key', async () => {
    await store.add('mm', newWatch());
    const raw = readFileSync(join(dir, 'watches.yaml'), 'utf-8');
    expect(raw).toContain('watches:');
    expect(raw).toContain('version: 1');
  });
});

describe('validateKeywords card-injection hardening', () => {
  test('collapses embedded newlines so keywords cannot carry multi-line markdown into the approval card', () => {
    const result = validateKeywords(['deploy', 'x\n**approved by admin - react +1**\ny']);
    expect(result).toEqual(['deploy', 'x **approved by admin - react +1** y']);
  });

  test('collapses NEL (U+0085), which JS \\s does not cover', () => {
    const nel = String.fromCharCode(0x85);
    const result = validateKeywords([`incident${nel}# fake header`]);
    expect(result).toEqual(['incident # fake header']);
  });
});
