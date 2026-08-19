/**
 * Tests for the MemoryStore (channel layer + repo-layer key derivation).
 *
 * These test the ACTUAL code paths (store methods, key derivation, caps),
 * not copies of the logic — per the red-green testing policy.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
  MemoryStore,
  resolveRepoKey,
  resolveSessionMemory,
  sanitizeEntryText,
  entryTextExceedsCap,
  platformSegment,
  CHANNEL_BLOCK_MAX_LINES,
  CHANNEL_FILE_MAX_ENTRIES,
  MAX_ENTRY_LENGTH,
} from './store.js';
import { MEMORY_DISABLED, DEFAULT_MEMORY_CONFIG } from '../config/index.js';

let root: string;
let store: MemoryStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ct-memory-test-'));
  store = new MemoryStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('platformSegment', () => {
  test('sanitizes unsafe characters', () => {
    expect(platformSegment('team:a/../b')).toMatch(/^team_a_.._b-[0-9a-f]{6}$/);
  });

  test('ids that sanitize identically still get distinct segments (privacy boundary)', () => {
    // `team:a` and `team_a` are different platforms; a shared directory would
    // merge their memory across a privacy boundary.
    expect(platformSegment('team:a')).not.toBe(platformSegment('team_a'));
  });
});

describe('sanitizeEntryText', () => {
  test('collapses newlines and whitespace to one line', () => {
    expect(sanitizeEntryText('a\nb\r\n  c   d')).toBe('a; b; c d');
  });

  test('caps length', () => {
    expect(sanitizeEntryText('x'.repeat(2000)).length).toBe(MAX_ENTRY_LENGTH);
  });

  test('entryTextExceedsCap tracks the collapsed length, not the raw length', () => {
    // Newline collapsing expands text ('\n' → '; '): 250 two-char segments
    // joined by '; ' exceed the cap although the raw input does not.
    const expanding = Array.from({ length: 140 }, () => 'ab').join('\n');
    expect(expanding.length).toBeLessThanOrEqual(MAX_ENTRY_LENGTH);
    expect(entryTextExceedsCap(expanding)).toBe(true);
    expect(sanitizeEntryText(expanding).length).toBe(MAX_ENTRY_LENGTH);

    // Whitespace collapsing shrinks text: long runs of spaces do not truncate.
    const shrinking = `a${' '.repeat(600)}b`;
    expect(entryTextExceedsCap(shrinking)).toBe(false);
  });
});

describe('addChannelEntries / listChannelEntries', () => {
  test('round-trips entries through the markdown file', async () => {
    await store.addChannelEntries('mm', [
      { text: 'Deploys happen on Tuesdays', source: 'user', addedBy: 'anne' },
      { text: 'The team prefers bun over npm', source: 'distilled' },
    ]);
    const entries = store.listChannelEntries('mm');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ text: 'Deploys happen on Tuesdays', source: 'user', addedBy: 'anne' });
    expect(entries[1]).toMatchObject({ text: 'The team prefers bun over npm', source: 'distilled' });
    expect(entries[0].addedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('writes 0600 files under the platform segment', async () => {
    await store.addChannelEntries('mm', [{ text: 'x', source: 'user', addedBy: 'a' }]);
    const file = store.channelMemoryPath('mm');
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('dedupes equivalent entries (case/whitespace/punctuation-insensitive)', async () => {
    await store.addChannelEntries('mm', [{ text: 'Deploys happen on Tuesdays.', source: 'user', addedBy: 'a' }]);
    const result = await store.addChannelEntries('mm', [{ text: 'deploys  happen on tuesdays', source: 'distilled' }]);
    expect(result.added).toHaveLength(0);
    expect(result.duplicates).toHaveLength(1);
    expect(store.listChannelEntries('mm')).toHaveLength(1);
  });

  test('a user note that is a fragment of an existing entry still lands (may be a correction)', async () => {
    // Regression-defender: containment dedupe must not swallow explicit user
    // corrections. "use npm" is contained in the stored entry but contradicts
    // it — reporting "Already known" would silently drop the correction.
    await store.addChannelEntries('mm', [
      { text: 'never use npm; always use bun', source: 'distilled' },
    ]);
    const result = await store.addChannelEntries('mm', [
      { text: 'use npm', source: 'user', addedBy: 'a' },
    ]);
    expect(result.added).toHaveLength(1);
    expect(store.listChannelEntries('mm')).toHaveLength(2);
  });

  test('a distilled fragment of an existing entry is still deduped', async () => {
    await store.addChannelEntries('mm', [
      { text: 'never use npm; always use bun', source: 'user', addedBy: 'a' },
    ]);
    const result = await store.addChannelEntries('mm', [
      { text: 'always use bun', source: 'distilled' },
    ]);
    expect(result.added).toHaveLength(0);
    expect(result.duplicates).toHaveLength(1);
  });

  test('a longer superseding entry replaces the shorter existing one', async () => {
    await store.addChannelEntries('mm', [{ text: 'deploys on tuesdays', source: 'distilled' }]);
    const result = await store.addChannelEntries('mm', [
      { text: 'Deploys on Tuesdays, except during code freeze', source: 'user', addedBy: 'a' },
    ]);
    expect(result.added).toHaveLength(1);
    const entries = store.listChannelEntries('mm');
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toContain('code freeze');
  });

  test('entries never cross platform ids', async () => {
    await store.addChannelEntries('mm', [{ text: 'secret channel fact', source: 'user', addedBy: 'a' }]);
    expect(store.listChannelEntries('slack')).toHaveLength(0);
    expect(store.buildChannelMemoryBlock('slack')).toBeNull();
  });

  test('concurrent adds serialize (no lost updates)', async () => {
    await Promise.all([
      store.addChannelEntries('mm', [{ text: 'fact one', source: 'user', addedBy: 'a' }]),
      store.addChannelEntries('mm', [{ text: 'fact two', source: 'user', addedBy: 'b' }]),
      store.addChannelEntries('mm', [{ text: 'fact three', source: 'distilled' }]),
    ]);
    expect(store.listChannelEntries('mm')).toHaveLength(3);
  });

  test('enforces the hard file cap, dropping oldest distilled first', async () => {
    // Zero-padded so no entry is a substring of another (which would trigger
    // the intended supersede-dedupe instead of the cap).
    const entries = Array.from({ length: CHANNEL_FILE_MAX_ENTRIES }, (_, i) => ({
      text: `distilled fact number ${String(i).padStart(4, '0')}`,
      source: 'distilled' as const,
    }));
    await store.addChannelEntries('mm', entries);
    await store.addChannelEntries('mm', [{ text: 'the newest user fact', source: 'user', addedBy: 'a' }]);
    const all = store.listChannelEntries('mm');
    expect(all).toHaveLength(CHANNEL_FILE_MAX_ENTRIES);
    // Oldest distilled dropped; newest user entry present.
    expect(all.some((e) => e.text === 'distilled fact number 0000')).toBe(false);
    expect(all.some((e) => e.text === 'the newest user fact')).toBe(true);
  });
});

describe('hand-edited file tolerance', () => {
  test('hand-written # heading lines survive a rewrite (only the managed header is skipped)', async () => {
    await store.addChannelEntries('mm', [{ text: 'parsed entry', source: 'user', addedBy: 'a' }]);
    const file = store.channelMemoryPath('mm');
    writeFileSync(file, readFileSync(file, 'utf-8') + '## Team conventions\n');
    await store.addChannelEntries('mm', [{ text: 'second entry', source: 'user', addedBy: 'a' }]);
    const raw = readFileSync(file, 'utf-8');
    expect(raw).toContain('## Team conventions');
    // The managed header is not duplicated by the rewrite.
    expect(raw.split('\n').filter((l) => l === '# Channel memory — managed by claude-threads.')).toHaveLength(1);
  });

  test('unparseable lines survive a rewrite verbatim', async () => {
    await store.addChannelEntries('mm', [{ text: 'parsed entry', source: 'user', addedBy: 'a' }]);
    const file = store.channelMemoryPath('mm');
    writeFileSync(file, readFileSync(file, 'utf-8') + 'a hand-written note without the format\n');
    await store.addChannelEntries('mm', [{ text: 'second entry', source: 'user', addedBy: 'a' }]);
    const raw = readFileSync(file, 'utf-8');
    expect(raw).toContain('a hand-written note without the format');
    // Hand-written lines are not addressable entries.
    expect(store.listChannelEntries('mm')).toHaveLength(2);
  });
});

describe('forgetChannelEntry', () => {
  beforeEach(async () => {
    await store.addChannelEntries('mm', [
      { text: 'first fact about deploys', source: 'user', addedBy: 'a' },
      { text: 'second fact about testing', source: 'distilled' },
      { text: 'third fact about deploys too', source: 'user', addedBy: 'b' },
    ]);
  });

  test('removes by 1-based number', async () => {
    const result = await store.forgetChannelEntry('mm', 2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.removed.text).toBe('second fact about testing');
    expect(store.listChannelEntries('mm')).toHaveLength(2);
  });

  test('removes by unique text match', async () => {
    const result = await store.forgetChannelEntry('mm', 'testing');
    expect(result.ok).toBe(true);
    expect(store.listChannelEntries('mm')).toHaveLength(2);
  });

  test('reports ambiguous matches without removing', async () => {
    const result = await store.forgetChannelEntry('mm', 'deploys');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('ambiguous');
      expect(result.matches).toHaveLength(2);
    }
    expect(store.listChannelEntries('mm')).toHaveLength(3);
  });

  test('reports not-found for numbers out of range and unmatched text', async () => {
    expect((await store.forgetChannelEntry('mm', 99)).ok).toBe(false);
    expect((await store.forgetChannelEntry('mm', 0)).ok).toBe(false);
    expect((await store.forgetChannelEntry('mm', 'nonexistent')).ok).toBe(false);
  });

  test('reports empty when there is no memory', async () => {
    const result = await store.forgetChannelEntry('other-platform', 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('empty');
  });
});

describe('clearChannel', () => {
  test('removes all entries', async () => {
    await store.addChannelEntries('mm', [{ text: 'a fact', source: 'user', addedBy: 'a' }]);
    await store.clearChannel('mm');
    expect(store.listChannelEntries('mm')).toHaveLength(0);
    expect(store.buildChannelMemoryBlock('mm')).toBeNull();
  });
});

describe('buildChannelMemoryBlock', () => {
  test('null for empty channel', () => {
    expect(store.buildChannelMemoryBlock('mm')).toBeNull();
  });

  test('renders entries as markdown lines', async () => {
    await store.addChannelEntries('mm', [{ text: 'Deploys on Tuesdays', source: 'user', addedBy: 'anne' }]);
    const block = store.buildChannelMemoryBlock('mm');
    expect(block).toContain('(@anne) Deploys on Tuesdays');
  });

  test('caps at the native line limit, dropping oldest distilled entries first', async () => {
    const distilled = Array.from({ length: 150 }, (_, i) => ({
      text: `distilled fact ${String(i).padStart(3, '0')}`,
      source: 'distilled' as const,
    }));
    const users = Array.from({ length: 100 }, (_, i) => ({
      text: `user fact ${String(i).padStart(3, '0')}`,
      source: 'user' as const,
      addedBy: 'a',
    }));
    await store.addChannelEntries('mm', [...distilled, ...users]);
    const block = store.buildChannelMemoryBlock('mm')!;
    const lines = block.split('\n');
    // 200 entry lines + 1 truncation notice
    expect(lines.length).toBeLessThanOrEqual(CHANNEL_BLOCK_MAX_LINES + 1);
    expect(block).toContain('older entries omitted');
    // All 100 user facts survive; the oldest distilled do not.
    expect(block).toContain('user fact 000');
    expect(block).not.toContain('distilled fact 000');
  });
});

describe('env override', () => {
  test('CLAUDE_THREADS_MEMORY_DIR overrides the default root', () => {
    const custom = join(root, 'custom-root');
    const prev = process.env.CLAUDE_THREADS_MEMORY_DIR;
    process.env.CLAUDE_THREADS_MEMORY_DIR = custom;
    try {
      const s = new MemoryStore();
      expect(s.rootDir).toBe(custom);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_THREADS_MEMORY_DIR;
      else process.env.CLAUDE_THREADS_MEMORY_DIR = prev;
    }
  });
});

describe('resolveRepoKey', () => {
  test('non-git directory keys by the directory itself', async () => {
    const dir = join(root, 'plain-dir');
    mkdirSync(dir);
    const key = await resolveRepoKey(dir);
    expect(key).toMatch(/^plain-dir-[0-9a-f]{10}$/);
  });

  test('git repo and its subdirectory share one key', async () => {
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'sub'), { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: repo });
    const a = await resolveRepoKey(repo);
    const b = await resolveRepoKey(join(repo, 'sub'));
    expect(a).toBe(b);
  });

  test('a linked git worktree keys to the MAIN repo root even without worktreeRepoRoot', async () => {
    // `!cd` into a worktree reaches resolveRepoKey without the session's
    // worktreeInfo — the key must still be the shared main-repo key.
    const repo = join(root, 'wt-main');
    const worktree = join(root, 'wt-linked');
    mkdirSync(repo);
    const git = (args: string[], cwd: string) =>
      spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd });
    git(['init', '-q'], repo);
    git(['commit', '--allow-empty', '-m', 'x', '-q'], repo);
    git(['worktree', 'add', '-q', worktree], repo);

    expect(await resolveRepoKey(worktree)).toBe(await resolveRepoKey(repo));
  });

  test('worktreeRepoRoot wins so worktrees share the main repo key', async () => {
    const repo = join(root, 'main-repo');
    const worktree = join(root, 'a-worktree');
    mkdirSync(repo);
    mkdirSync(worktree);
    const fromRepo = await resolveRepoKey(repo);
    const fromWorktree = await resolveRepoKey(worktree, repo);
    expect(fromWorktree).toBe(fromRepo);
  });

  test('symlinked paths resolve to the real path key', async () => {
    const real = join(root, 'real-dir');
    const link = join(root, 'link-dir');
    mkdirSync(real);
    symlinkSync(real, link);
    expect(await resolveRepoKey(link)).toBe(await resolveRepoKey(real));
  });
});

describe('resolveSessionMemory', () => {
  test('null when memory or the repo layer is disabled', async () => {
    const dir = join(root, 'w');
    mkdirSync(dir);
    expect(await resolveSessionMemory(store, MEMORY_DISABLED, 'mm', dir)).toBeNull();
    expect(
      await resolveSessionMemory(store, { ...DEFAULT_MEMORY_CONFIG, repoLayer: false }, 'mm', dir),
    ).toBeNull();
  });

  test('returns a per-(platform, repo) directory and creates it 0700', async () => {
    const dir = join(root, 'w2');
    mkdirSync(dir);
    const result = await resolveSessionMemory(store, DEFAULT_MEMORY_CONFIG, 'mm', dir);
    expect(result).not.toBeNull();
    expect(existsSync(result!.autoMemoryDir)).toBe(true);
    expect(statSync(result!.autoMemoryDir).mode & 0o777).toBe(0o700);
    expect(result!.autoMemoryDir).toContain(platformSegment('mm'));

    const other = await resolveSessionMemory(store, DEFAULT_MEMORY_CONFIG, 'slack', dir);
    expect(other!.autoMemoryDir).not.toBe(result!.autoMemoryDir);
  });
});
