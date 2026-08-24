import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, writeFileSync, existsSync, unlinkSync, statSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GitHubEmailsStore, isValidGitHubNoreplyEmail } from './github-emails-store.js';

function uniquePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gh-emails-'));
  return join(dir, 'github-emails.yaml');
}

describe('isValidGitHubNoreplyEmail', () => {
  it('accepts the canonical ID-prefix form', () => {
    expect(isValidGitHubNoreplyEmail('12345678+anne@users.noreply.github.com')).toBe(true);
    expect(isValidGitHubNoreplyEmail('1+a@users.noreply.github.com')).toBe(true);
  });

  it('rejects the legacy username-only form (account creation date dependent)', () => {
    // Refusing this avoids supporting two formats with subtle account-age semantics.
    expect(isValidGitHubNoreplyEmail('anne@users.noreply.github.com')).toBe(false);
  });

  it('rejects real emails and other domains', () => {
    expect(isValidGitHubNoreplyEmail('anne@example.com')).toBe(false);
    expect(isValidGitHubNoreplyEmail('12345+anne@example.com')).toBe(false);
    expect(isValidGitHubNoreplyEmail('12345+anne@noreply.github.com')).toBe(false);
  });

  it('rejects malformed input (case / whitespace / empty)', () => {
    expect(isValidGitHubNoreplyEmail('')).toBe(false);
    expect(isValidGitHubNoreplyEmail('  12345+anne@users.noreply.github.com')).toBe(false);
    expect(isValidGitHubNoreplyEmail('12345+anne@users.noreply.github.com  ')).toBe(false);
    expect(isValidGitHubNoreplyEmail('12345-anne@users.noreply.github.com')).toBe(false);
  });
});

describe('GitHubEmailsStore', () => {
  let path: string;

  beforeEach(() => {
    path = uniquePath();
  });

  afterEach(() => {
    if (existsSync(path)) {
      unlinkSync(path);
    }
    // Best-effort cleanup of the temp dir.
    try { rmSync(join(path, '..'), { recursive: true, force: true }); } catch { /* */ }
  });

  it('returns undefined for unknown (platform, user)', () => {
    const store = new GitHubEmailsStore(path);
    expect(store.get('mm', 'alice')).toBeUndefined();
  });

  it('stores and retrieves an email per (platform, user)', () => {
    const store = new GitHubEmailsStore(path);
    store.set('mm', 'alice', '111+alice@users.noreply.github.com');
    expect(store.get('mm', 'alice')).toBe('111+alice@users.noreply.github.com');
  });

  it('keeps platforms isolated (same username on different platforms)', () => {
    // Per CLAUDE.md decision: scope is per platform — `bob` on Mattermost may
    // be a different human than `bob` on Slack.
    const store = new GitHubEmailsStore(path);
    store.set('mm', 'bob', '111+bob@users.noreply.github.com');
    store.set('slack', 'bob', '222+bob@users.noreply.github.com');
    expect(store.get('mm', 'bob')).toBe('111+bob@users.noreply.github.com');
    expect(store.get('slack', 'bob')).toBe('222+bob@users.noreply.github.com');
  });

  it('overwrites on second set for the same (platform, user)', () => {
    const store = new GitHubEmailsStore(path);
    store.set('mm', 'alice', '111+alice@users.noreply.github.com');
    store.set('mm', 'alice', '222+alice@users.noreply.github.com');
    expect(store.get('mm', 'alice')).toBe('222+alice@users.noreply.github.com');
  });

  it('delete removes the entry and reports whether anything was there', () => {
    const store = new GitHubEmailsStore(path);
    expect(store.delete('mm', 'ghost')).toBe(false);
    store.set('mm', 'alice', '111+alice@users.noreply.github.com');
    expect(store.delete('mm', 'alice')).toBe(true);
    expect(store.get('mm', 'alice')).toBeUndefined();
  });

  it('rejects an invalid email at set() time so we never persist bad data', () => {
    const store = new GitHubEmailsStore(path);
    expect(() => store.set('mm', 'alice', 'alice@example.com')).toThrow(/noreply/);
    expect(store.get('mm', 'alice')).toBeUndefined();
  });

  it('persists across instances (a fresh store reads what the previous wrote)', () => {
    const a = new GitHubEmailsStore(path);
    a.set('mm', 'alice', '111+alice@users.noreply.github.com');
    const b = new GitHubEmailsStore(path);
    expect(b.get('mm', 'alice')).toBe('111+alice@users.noreply.github.com');
  });

  it('writes the file with 0600 permissions to keep mappings local-user-readable only', () => {
    const store = new GitHubEmailsStore(path);
    store.set('mm', 'alice', '111+alice@users.noreply.github.com');
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('handles a malformed YAML file by starting empty for reads, refusing writes', () => {
    writeFileSync(path, '::: not yaml :::', 'utf-8');
    const store = new GitHubEmailsStore(path);
    expect(store.get('mm', 'alice')).toBeUndefined();
    // A set over unreadable-but-existing content refuses (no throw): the
    // atomic write would destroy whatever the corruption still holds.
    store.set('mm', 'alice', '111+alice@users.noreply.github.com');
    expect(readFileSync(path, 'utf-8')).toBe('::: not yaml :::');
    // Once the file is removed/repaired, writes resume.
    rmSync(path);
    store.set('mm', 'alice', '111+alice@users.noreply.github.com');
    expect(store.get('mm', 'alice')).toBe('111+alice@users.noreply.github.com');
  });

  it('an empty file is a writable empty store, not a degraded read', () => {
    // Zero-length file: provably nothing to lose — must not trip the
    // write-refusing degraded path, or the store is read-only forever.
    writeFileSync(path, '', 'utf-8');
    const store = new GitHubEmailsStore(path);
    expect(store.get('mm', 'alice')).toBeUndefined();
    store.set('mm', 'alice', '111+alice@users.noreply.github.com');
    expect(store.get('mm', 'alice')).toBe('111+alice@users.noreply.github.com');

    writeFileSync(path, '  \n\n', 'utf-8');
    const store2 = new GitHubEmailsStore(path);
    store2.set('mm', 'bob', '222+bob@users.noreply.github.com');
    expect(store2.get('mm', 'bob')).toBe('222+bob@users.noreply.github.com');
  });
});
