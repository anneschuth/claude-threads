import { describe, it, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { parseLimits, profileNameFor, keychainAccountFor, discoverProfiles, credentialState, loggedOutMessage } from './client.js';

describe('parseLimits', () => {
  it('maps the three limit kinds, naming the scoped one by model', () => {
    const limits = parseLimits({
      limits: [
        { kind: 'session', percent: 15, resets_at: '2026-09-01T22:50:00Z', scope: null },
        { kind: 'weekly_all', percent: 3, resets_at: '2026-09-02T02:00:00Z', scope: null },
        {
          kind: 'weekly_scoped',
          percent: 4,
          resets_at: '2026-09-02T02:00:00Z',
          scope: { model: { id: null, display_name: 'Fable' }, surface: null },
        },
      ],
    });

    expect(limits.map((l) => l.kind)).toEqual(['session', 'weekly_all', 'weekly_scoped']);
    expect(limits[2].model).toBe('Fable');
    expect(limits[0].percent).toBe(15);
    expect(limits[1].resetsAt.toISOString()).toBe('2026-09-02T02:00:00.000Z');
  });

  it('ignores limit kinds it does not know rather than throwing', () => {
    const limits = parseLimits({
      limits: [
        { kind: 'session', percent: 1, resets_at: '2026-09-01T22:50:00Z', scope: null },
        { kind: 'some_future_bucket', percent: 90, resets_at: '2026-09-01T22:50:00Z', scope: null },
      ],
    });

    expect(limits.map((l) => l.kind)).toEqual(['session']);
  });

  it('drops a limit with no usable reset timestamp instead of rendering Invalid Date', () => {
    const limits = parseLimits({
      limits: [
        { kind: 'session', percent: 5, resets_at: null, scope: null },
        { kind: 'weekly_all', percent: 5, resets_at: '2026-09-02T02:00:00Z', scope: null },
      ],
    });

    expect(limits.map((l) => l.kind)).toEqual(['weekly_all']);
  });

  it('throws on a payload with no limits array — that is a contract change, not an empty week', () => {
    // The top-level five_hour/seven_day fields and the codename buckets
    // (tangelo, iguana_necktie, nimbus_quill…) are internal and mostly null;
    // limits[] is the shape worth depending on. If it vanishes, say so loudly.
    expect(() => parseLimits({ five_hour: { utilization: 12 } })).toThrow(/limits/);
  });
});

describe('profileNameFor', () => {
  it('names the default config dir and the suffixed ones', () => {
    expect(profileNameFor('/Users/almir/.claude')).toBe('default');
    expect(profileNameFor('/Users/almir/.claude-vvs')).toBe('vvs');
    expect(profileNameFor('/home/herder/.claude-vvs2')).toBe('vvs2');
  });

  it('tolerates a trailing slash', () => {
    expect(profileNameFor('/Users/almir/.claude-almir/')).toBe('almir');
  });
});

describe('keychainAccountFor', () => {
  it('uses the plain item for the default profile and a path hash otherwise', () => {
    // Verified against the live keychain on macOS: the suffix is the first 8
    // hex chars of sha256 over the config-dir path, with no trailing slash.
    expect(keychainAccountFor('/Users/almir/.claude')).toBe('Claude Code-credentials');
    expect(keychainAccountFor('/Users/almir/.claude-vvs')).toBe(
      'Claude Code-credentials-166321ee'
    );
    expect(keychainAccountFor('/Users/almir/.claude-almir')).toBe(
      'Claude Code-credentials-892d8fd6'
    );
  });
});

describe('discoverProfiles', () => {
  it('keeps real seats and skips ~/.claude-* dirs that are not Claude profiles', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'usage-profiles-'));

    // A real seat: has the marker files Claude Code writes.
    await mkdir(path.join(home, '.claude-vvs'), { recursive: true });
    await writeFile(path.join(home, '.claude-vvs', 'history.jsonl'), '');

    // The default profile.
    await mkdir(path.join(home, '.claude', 'projects'), { recursive: true });

    // Not a seat: claude-threads keeps its bot config under the same prefix
    // and holds nothing but logs. Including it produced a spurious
    // "could not read usage" row for something that was never a profile.
    await mkdir(path.join(home, '.claude-threads', 'logs'), { recursive: true });

    // Not a directory at all.
    await writeFile(path.join(home, '.claude.json'), '{}');

    const names = (await discoverProfiles(home)).map((p) => p.name);

    expect(names).toEqual(['default', 'vvs']);
  });
});

describe('credentialState', () => {
  const NOW = new Date('2026-09-02T00:00:00Z');
  const h = (n: number) => NOW.getTime() + n * 3_600_000;

  it('is fresh while the access token is still valid', () => {
    expect(credentialState({ accessToken: 'a', refreshToken: 'r', expiresAt: h(1), refreshTokenExpiresAt: h(400) }, NOW))
      .toBe('fresh');
  });

  it('is refreshable when only the access token has expired', () => {
    // The common case on any box: access tokens live ~8h, so every profile
    // nobody ran today is here. Measured on the agent box — a seat 52h stale
    // still had 425h left on its refresh token.
    expect(credentialState({ accessToken: 'a', refreshToken: 'r', expiresAt: h(-52), refreshTokenExpiresAt: h(425) }, NOW))
      .toBe('refreshable');
  });

  it('is logged out only when the refresh token has expired too', () => {
    expect(credentialState({ accessToken: 'a', refreshToken: 'r', expiresAt: h(-52), refreshTokenExpiresAt: h(-1) }, NOW))
      .toBe('logged_out');
  });

  it('treats a missing refresh expiry as refreshable rather than giving up', () => {
    expect(credentialState({ accessToken: 'a', refreshToken: 'r', expiresAt: h(-1) }, NOW)).toBe('refreshable');
  });

  it('is logged out when there is no refresh token at all', () => {
    expect(credentialState({ accessToken: 'a', expiresAt: h(-1) }, NOW)).toBe('logged_out');
  });
});

describe('loggedOutMessage', () => {
  it('names the seat by the label the caller knows it as', () => {
    // In pool mode the credentials live at <account.home>/.claude, so a name
    // derived from the directory is "default" for EVERY account — useless in
    // the one message whose whole job is saying which seat to go fix.
    expect(loggedOutMessage('/home/herder/accounts/work/.claude', 'Work seat', 'a@b.com'))
      .toBe('logged out — run `claude` in Work seat and log in as a@b.com');
  });

  it('falls back to the directory-derived profile name when there is no label', () => {
    expect(loggedOutMessage('/home/almir/.claude-vvs', undefined, 'a@b.com'))
      .toBe('logged out — run `claude` in vvs and log in as a@b.com');
  });

  it('omits the account when it could not be read', () => {
    expect(loggedOutMessage('/home/almir/.claude-vvs', undefined, undefined))
      .toBe('logged out — run `claude` in vvs and log in');
  });
});
