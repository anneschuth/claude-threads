import { describe, it, expect, mock } from 'bun:test';

import { isAuthorizedForSession } from './authorization.js';
import type { PlatformClient } from '../platform/index.js';

/**
 * Build a minimal platform whose `isUserAllowed` mirrors the real base-client
 * behavior: an empty allowlist allows everyone, otherwise membership decides.
 */
function platformWithAllowlist(allowed: string[]): PlatformClient {
  return {
    isUserAllowed: mock((username: string) =>
      allowed.length === 0 ? true : allowed.includes(username),
    ),
  } as unknown as PlatformClient;
}

describe('isAuthorizedForSession', () => {
  it('allows a user in the platform global allowlist', () => {
    const platform = platformWithAllowlist(['alice', 'bob']);
    expect(isAuthorizedForSession({ username: 'alice', platform })).toBe(true);
  });

  it('allows everyone when the global allowlist is empty (allow-all)', () => {
    const platform = platformWithAllowlist([]);
    expect(isAuthorizedForSession({ username: 'anyone', platform })).toBe(true);
  });

  it('allows a per-session collaborator not in the global allowlist', () => {
    const platform = platformWithAllowlist(['alice']);
    expect(
      isAuthorizedForSession({
        username: 'invited',
        platform,
        sessionAllowedUsers: new Set(['alice', 'invited']),
      }),
    ).toBe(true);
  });

  it('denies a user in neither allowlist', () => {
    const platform = platformWithAllowlist(['alice']);
    expect(
      isAuthorizedForSession({
        username: 'jonas.gn',
        platform,
        sessionAllowedUsers: new Set(['alice']),
      }),
    ).toBe(false);
  });

  it('denies the "unknown" sentinel even with an empty allowlist', () => {
    const platform = platformWithAllowlist([]);
    expect(isAuthorizedForSession({ username: 'unknown', platform })).toBe(false);
  });

  it('denies an empty or missing username (fail closed)', () => {
    const platform = platformWithAllowlist([]);
    expect(isAuthorizedForSession({ username: '', platform })).toBe(false);
    expect(isAuthorizedForSession({ username: undefined, platform })).toBe(false);
  });
});
