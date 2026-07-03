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

  describe('acquire / least-loaded selection', () => {
    // With usage unknown (nothing probed yet) selection falls back to fewest
    // active sessions, then config order — which spreads sequential acquires
    // across accounts just like the old round-robin did.
    it('spreads sequential acquires across accounts (active-count tiebreak)', () => {
      const pool = new AccountPool([
        { id: 'a', home: '/tmp/a' },
        { id: 'b', home: '/tmp/b' },
        { id: 'c', home: '/tmp/c' },
      ]);
      expect(pool.acquire()?.id).toBe('a');
      expect(pool.acquire()?.id).toBe('b');
      expect(pool.acquire()?.id).toBe('c');
      expect(pool.acquire()?.id).toBe('a'); // wraps back to least-active
    });

    it('returns preferred account when supplied and known', () => {
      const pool = new AccountPool([
        { id: 'a', home: '/tmp/a' },
        { id: 'b', home: '/tmp/b' },
      ]);
      expect(pool.acquire('b')?.id).toBe('b');
      expect(pool.acquire('b')?.id).toBe('b');
    });

    it('falls back to least-loaded when preferred id is unknown', () => {
      const pool = new AccountPool([{ id: 'a', home: '/tmp/a' }]);
      expect(pool.acquire('ghost')?.id).toBe('a');
    });

    it('skips cooling accounts', () => {
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
      pool.acquire(); // anonymous acquire must not affect sticky binding
      pool.acquire(undefined, 'thread-other-3');
      for (let i = 0; i < 20; i++) {
        expect(pool.acquire(undefined, 'thread-xyz')?.id).toBe(first?.id);
      }
    });

    it('new sessions (balanceByUsage) skip the sticky binding', () => {
      // The sticky path is a resume-compat shim: a new session opts into usage
      // balancing and must NOT be pinned by thread hash. We can't assert the
      // exact account (depends on hashes/usage), but we can assert that the
      // balanced pick is chosen by load, not by the thread hash — here by
      // pre-loading one account and confirming the balanced acquire avoids it.
      const pool = new AccountPool([
        { id: 'a', home: '/tmp/a' },
        { id: 'b', home: '/tmp/b' },
      ]);
      // Find which account the thread hash pins to, then make THAT one busy.
      const sticky = pool.acquire(undefined, 'thread-pin')!;
      // With sticky busy (active=1) and the other idle, a usage-balanced
      // acquire for the same thread must pick the idle one, not the sticky.
      const balanced = pool.acquire(undefined, 'thread-pin', { balanceByUsage: true });
      expect(balanced?.id).not.toBe(sticky.id);
    });

    it('falls back to least-loaded when sticky pick is cooling, then restores once cooldown lifts', () => {
      // n=3 keeps the assertion meaningful: with the sticky account cooling,
      // the fallback picks a different non-cooling account; only the sticky
      // branch restores the original account once cooldown lifts.
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

  describe('usage-based selection', () => {
    const usage = (loadPct: number) => ({
      sessionPct: loadPct,
      weekAllModelsPct: 0,
      weekPerModelPct: null,
      sessionResetsAt: null,
      weekResetsAt: null,
    });

    it('routes a new session to the account with the lowest usage', () => {
      const pool = new AccountPool([
        { id: 'a', home: '/tmp/a' },
        { id: 'b', home: '/tmp/b' },
        { id: 'c', home: '/tmp/c' },
      ]);
      pool.setUsage('a', usage(80));
      pool.setUsage('b', usage(10)); // least loaded
      pool.setUsage('c', usage(50));
      expect(pool.acquire(undefined, 'any-thread', { balanceByUsage: true })?.id).toBe('b');
    });

    it('lower usage wins even against a lower active-session count', () => {
      const pool = new AccountPool([
        { id: 'a', home: '/tmp/a' },
        { id: 'b', home: '/tmp/b' },
      ]);
      // 'a' has an active session but far more headroom; usage is the primary key.
      pool.acquire('a');
      pool.setUsage('a', usage(5));
      pool.setUsage('b', usage(90));
      expect(pool.acquire(undefined, undefined, { balanceByUsage: true })?.id).toBe('a');
    });

    it('never routes to a cooling account even if it has the lowest usage', () => {
      const pool = new AccountPool([
        { id: 'a', home: '/tmp/a' },
        { id: 'b', home: '/tmp/b' },
      ]);
      pool.setUsage('a', usage(1)); // lowest but cooling
      pool.setUsage('b', usage(70));
      pool.markCooling('a', Date.now() + 60_000);
      expect(pool.acquire(undefined, undefined, { balanceByUsage: true })?.id).toBe('b');
    });

    it('prefers a probed low-usage account over an unprobed one', () => {
      const pool = new AccountPool([
        { id: 'a', home: '/tmp/a' },
        { id: 'b', home: '/tmp/b' },
      ]);
      // 'b' known-low, 'a' unknown → unknown sorts last so 'b' is chosen.
      pool.setUsage('b', usage(30));
      expect(pool.acquire(undefined, undefined, { balanceByUsage: true })?.id).toBe('b');
    });

    it('rotates among equally-loaded accounts on serial traffic', () => {
      // Regression (round-robin tiebreak): when accounts tie on both usage
      // score and active count, sequential acquire→release must cycle through
      // them instead of hammering the config-first account. Without the
      // rotating cursor this returns ['a','a','a','a'].
      const pool = new AccountPool([
        { id: 'a', home: '/tmp/a' },
        { id: 'b', home: '/tmp/b' },
        { id: 'c', home: '/tmp/c' },
      ]);
      pool.setUsage('a', usage(10));
      pool.setUsage('b', usage(10));
      pool.setUsage('c', usage(10));
      const picks: string[] = [];
      for (let i = 0; i < 4; i++) {
        const acc = pool.acquire(undefined, undefined, { balanceByUsage: true });
        picks.push(acc!.id);
        pool.release(acc!.id); // serial: one at a time, active returns to 0
      }
      expect(picks).toEqual(['a', 'b', 'c', 'a']);
    });

    it('spreads a concurrent burst instead of piling onto the lowest-usage account', () => {
      // Regression (#5): concurrent starts read the same usage snapshot; without
      // the in-flight active-session penalty all of them pick the single lowest
      // account. Here b is lowest (10%) but should not absorb every session.
      const pool = new AccountPool([
        { id: 'a', home: '/tmp/a' },
        { id: 'b', home: '/tmp/b' },
      ]);
      pool.setUsage('a', usage(12));
      pool.setUsage('b', usage(10));
      // No release between acquires — simulates a burst of overlapping sessions.
      const picks: string[] = [];
      for (let i = 0; i < 4; i++) {
        picks.push(pool.acquire(undefined, undefined, { balanceByUsage: true })!.id);
      }
      // b (10) first, then a once b's effective load (10+5) exceeds a (12), etc.
      expect(picks).toEqual(['b', 'a', 'b', 'a']);
      // Both accounts got work; neither was starved.
      expect(picks.filter((p) => p === 'a').length).toBe(2);
      expect(picks.filter((p) => p === 'b').length).toBe(2);
    });

    it('surfaces usagePercent in status()', () => {
      const pool = new AccountPool([{ id: 'a', home: '/tmp/a' }]);
      expect(pool.status()[0].usagePercent).toBeNull();
      pool.setUsage('a', usage(42));
      expect(pool.status()[0].usagePercent).toBe(42);
    });

    it('ignores setUsage for unknown accounts', () => {
      const pool = new AccountPool([{ id: 'a', home: '/tmp/a' }]);
      pool.setUsage('ghost', usage(10)); // no throw
      expect(pool.status()).toHaveLength(1);
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
