/**
 * Tests for AccountPool.
 */
import { describe, it, expect, setSystemTime } from 'bun:test';
import { AccountPool } from './account-pool.js';

describe('AccountPool', () => {
  describe('empty / single-account mode', () => {
    it('is empty when constructed with no accounts', () => {
      const pool = new AccountPool();
      expect(pool.isEmpty).toBe(true);
      expect(pool.size).toBe(0);
      expect(pool.acquire()).toBeNull();
    });

    it('is empty when constructed with empty array', () => {
      const pool = new AccountPool([]);
      expect(pool.isEmpty).toBe(true);
      expect(pool.acquire()).toBeNull();
    });

    it('drops accounts that have neither home nor apiKey', () => {
      const pool = new AccountPool([
        { id: 'valid', home: '/tmp/a' },
        { id: 'empty' }, // invalid
        { id: 'api', apiKey: 'sk-xxx' },
      ]);
      expect(pool.size).toBe(2);
      expect(pool.get('empty')).toBeUndefined();
      expect(pool.get('valid')).toBeDefined();
      expect(pool.get('api')).toBeDefined();
    });

    it('drops accounts that have BOTH home and apiKey (mutually exclusive)', () => {
      // home/apiKey are documented as mutually exclusive: `home` routes via
      // OAuth, `apiKey` via API billing. Silently preferring one (as the old
      // behavior did) hides misconfiguration; the pool should reject the
      // account outright so the operator notices.
      const pool = new AccountPool([
        { id: 'oauth', home: '/tmp/a' },
        { id: 'dual', home: '/tmp/b', apiKey: 'sk-ant-xxx' }, // invalid
        { id: 'api', apiKey: 'sk-ant-yyy' },
      ]);
      expect(pool.size).toBe(2);
      expect(pool.get('dual')).toBeUndefined();
      expect(pool.get('oauth')).toBeDefined();
      expect(pool.get('api')).toBeDefined();
    });
  });

  describe('acquire / round-robin', () => {
    it('returns accounts in round-robin order', () => {
      const pool = new AccountPool([
        { id: 'a', home: '/tmp/a' },
        { id: 'b', home: '/tmp/b' },
        { id: 'c', home: '/tmp/c' },
      ]);
      expect(pool.acquire()?.id).toBe('a');
      expect(pool.acquire()?.id).toBe('b');
      expect(pool.acquire()?.id).toBe('c');
      expect(pool.acquire()?.id).toBe('a'); // wraps
    });

    it('returns preferred account when supplied and known', () => {
      const pool = new AccountPool([
        { id: 'a', home: '/tmp/a' },
        { id: 'b', home: '/tmp/b' },
      ]);
      expect(pool.acquire('b')?.id).toBe('b');
      expect(pool.acquire('b')?.id).toBe('b');
    });

    it('falls back to round-robin when preferred id is unknown', () => {
      const pool = new AccountPool([{ id: 'a', home: '/tmp/a' }]);
      expect(pool.acquire('ghost')?.id).toBe('a');
    });

    it('skips cooling accounts in round-robin', () => {
      const pool = new AccountPool([
        { id: 'a', home: '/tmp/a' },
        { id: 'b', home: '/tmp/b' },
        { id: 'c', home: '/tmp/c' },
      ]);
      pool.markCooling('b', Date.now() + 60_000);

      expect(pool.acquire()?.id).toBe('a');
      expect(pool.acquire()?.id).toBe('c'); // b skipped
      expect(pool.acquire()?.id).toBe('a');
    });

    it('returns null when every account is cooling', () => {
      const pool = new AccountPool([
        { id: 'a', home: '/tmp/a' },
        { id: 'b', home: '/tmp/b' },
      ]);
      const future = Date.now() + 60_000;
      pool.markCooling('a', future);
      pool.markCooling('b', future);
      expect(pool.acquire()).toBeNull();
    });

    it('returns preferred account even if it is cooling (resume path)', () => {
      const pool = new AccountPool([
        { id: 'a', home: '/tmp/a' },
        { id: 'b', home: '/tmp/b' },
      ]);
      pool.markCooling('a', Date.now() + 60_000);
      // Resuming a session that was started on 'a' must still get 'a' —
      // its history lives under a's HOME and can't move.
      expect(pool.acquire('a')?.id).toBe('a');
    });

    it('allows reacquisition after cooldown passes', () => {
      const pool = new AccountPool([{ id: 'a', home: '/tmp/a' }]);
      pool.markCooling('a', Date.now() - 1); // already expired
      expect(pool.acquire()?.id).toBe('a');
    });
  });

  describe('sticky-by-thread binding', () => {
    // Regression: in claude-threads <=1.8.2 the pool was strictly round-robin,
    // and the claudeAccountId persisted to sessions.json could drift away from
    // the $HOME Claude actually spawned under (race between multiple acquires
    // and the writeAtomic of the whole sessions map). After a bot restart that
    // mismatch produced "conversation history no longer exists" → soft-delete.
    // Sticky binding by hash(threadId) closes the race deterministically.

    it('always returns the same account for a given threadId', () => {
      const pool = new AccountPool([
        { id: 'a', home: '/tmp/a' },
        { id: 'b', home: '/tmp/b' },
        { id: 'c', home: '/tmp/c' },
      ]);
      const first = pool.acquire(undefined, 'thread-xyz');
      // Many subsequent acquires for the same thread must return the same id,
      // independent of intervening calls from other threads.
      pool.acquire(undefined, 'thread-other-1');
      pool.acquire(undefined, 'thread-other-2');
      pool.acquire(); // anonymous round-robin must not affect sticky binding
      pool.acquire(undefined, 'thread-other-3');
      for (let i = 0; i < 20; i++) {
        expect(pool.acquire(undefined, 'thread-xyz')?.id).toBe(first?.id);
      }
    });

    it('does not advance roundRobinIndex when sticky path serves the request', () => {
      // Design invariant: sticky-bound threads must not perturb the cursor
      // the anonymous round-robin path uses. Otherwise heavy use of one
      // sticky thread silently shifts how anonymous acquires distribute,
      // which is exactly the kind of subtle drift this fix is meant to
      // eliminate.
      //
      // n=2 is required for RED-GREEN: with n=3 the cursor cycles back to 0
      // after 3 RR calls "by luck" and the test passes either way. With n=2,
      // 3 RR calls leave the cursor at index 1, so the anonymous acquire
      // returns 'b' under the broken code path and 'a' under the fix.
      const pool = new AccountPool([
        { id: 'a', home: '/tmp/a' },
        { id: 'b', home: '/tmp/b' },
      ]);
      pool.acquire(undefined, 'sticky-1');
      pool.acquire(undefined, 'sticky-2');
      pool.acquire(undefined, 'sticky-3');
      // Sticky path didn't touch the cursor → first anonymous acquire still
      // starts at index 0.
      expect(pool.acquire()?.id).toBe('a');
    });

    it('falls back to round-robin when sticky pick is cooling, then restores once cooldown lifts', () => {
      // n=3 is required to make this test RED-GREEN — with n=2, plain
      // round-robin happens to alternate back to the original account on the
      // third call by sheer luck and the test would pass without the sticky
      // branch. With n=3, plain round-robin walks 'a','b','c' regardless of
      // threadId, so the third call returns 'c'; only sticky restores the
      // original account after cooldown.
      //
      // setSystemTime advances the clock past the cooldown rather than
      // re-calling markCooling — markCooling has a "never shortens" guard
      // that makes a backwards-time call a no-op and silently breaks the
      // assertion.
      const pool = new AccountPool([
        { id: 'a', home: '/tmp/a' },
        { id: 'b', home: '/tmp/b' },
        { id: 'c', home: '/tmp/c' },
      ]);
      try {
        const sticky = pool.acquire(undefined, 'pin-thread');
        pool.release(sticky!.id);
        const cooldownUntil = Date.now() + 60_000;
        pool.markCooling(sticky!.id, cooldownUntil);

        // Next acquire for the same thread must NOT return the cooling account.
        const next = pool.acquire(undefined, 'pin-thread');
        expect(next?.id).not.toBe(sticky?.id);
        expect(next).not.toBeNull();

        // Advance time past cooldown so the sticky binding can reassert
        // itself. This is the property that distinguishes sticky from plain
        // round-robin and makes the test RED without the sticky branch.
        setSystemTime(new Date(cooldownUntil + 1));
        expect(pool.acquire(undefined, 'pin-thread')?.id).toBe(sticky?.id);
      } finally {
        setSystemTime(); // restore real clock for sibling tests
      }
    });

    it('preferredId still wins over threadId binding (resume invariant)', () => {
      // Resume path: even if hash(threadId) would pick 'a', a persisted
      // claudeAccountId of 'b' must still be honored — the conversation
      // history lives under b's HOME.
      const pool = new AccountPool([
        { id: 'a', home: '/tmp/a' },
        { id: 'b', home: '/tmp/b' },
      ]);
      const sticky = pool.acquire(undefined, 'thread-z');
      pool.release(sticky!.id);
      const other = sticky!.id === 'a' ? 'b' : 'a';
      expect(pool.acquire(other, 'thread-z')?.id).toBe(other);
    });

    it('returns null when only account is cooling, even with threadId', () => {
      const pool = new AccountPool([{ id: 'a', home: '/tmp/a' }]);
      pool.markCooling('a', Date.now() + 60_000);
      expect(pool.acquire(undefined, 'thread-q')).toBeNull();
    });
  });

  describe('usage accounting', () => {
    it('tracks active sessions via acquire/release', () => {
      const pool = new AccountPool([{ id: 'a', home: '/tmp/a' }]);
      pool.acquire(); // 1
      pool.acquire(); // 2
      pool.release('a'); // 1
      const status = pool.status();
      expect(status[0].activeSessions).toBe(1);
    });

    it('clamps release at zero', () => {
      const pool = new AccountPool([{ id: 'a', home: '/tmp/a' }]);
      pool.release('a'); // no-op effectively
      pool.release('a');
      expect(pool.status()[0].activeSessions).toBe(0);
    });

    it('ignores release for unknown accounts', () => {
      const pool = new AccountPool([{ id: 'a', home: '/tmp/a' }]);
      pool.release('ghost'); // does not throw
      expect(pool.status()[0].activeSessions).toBe(0);
    });
  });

  describe('markCooling', () => {
    it('reports cooling in status()', () => {
      const pool = new AccountPool([{ id: 'a', home: '/tmp/a' }]);
      const until = Date.now() + 60_000;
      pool.markCooling('a', until);
      expect(pool.status()[0].coolingUntil).toBe(until);
    });

    it('never shortens an existing cooldown', () => {
      const pool = new AccountPool([{ id: 'a', home: '/tmp/a' }]);
      const far = Date.now() + 120_000;
      const near = Date.now() + 60_000;
      pool.markCooling('a', far);
      pool.markCooling('a', near);
      expect(pool.status()[0].coolingUntil).toBe(far);
    });

    it('treats expired cooldowns as available in status()', () => {
      const pool = new AccountPool([{ id: 'a', home: '/tmp/a' }]);
      pool.markCooling('a', Date.now() - 1);
      expect(pool.status()[0].coolingUntil).toBeNull();
    });

    it('ignores markCooling for unknown accounts', () => {
      const pool = new AccountPool([{ id: 'a', home: '/tmp/a' }]);
      pool.markCooling('ghost', Date.now() + 60_000);
      // shouldn't throw and shouldn't appear in status
      expect(pool.status()).toHaveLength(1);
    });
  });
});
