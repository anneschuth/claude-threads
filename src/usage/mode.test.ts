import { describe, it, expect } from 'bun:test';
import { collectUsage } from './index.js';
import { renderProfiles } from './render.js';

/**
 * The promise of the account-pool work is that `!usage` reports the seats the
 * router chooses between. Testing `accountTargets` alone does not prove
 * `collectUsage` ever consults it — the wiring could be deleted and the helper
 * tests would stay green.
 *
 * API-key accounts give a pool path with no filesystem or network IO, so the
 * mode switch can be asserted deterministically.
 */
const METERED_POOL = [
  { id: 'alpha', apiKey: 'sk-a' },
  { id: 'beta', apiKey: 'sk-b' },
];

describe('collectUsage mode selection', () => {
  it('reports the pool when one is configured, not ~/.claude* discovery', async () => {
    const rows = await collectUsage({ all: true, accounts: METERED_POOL });

    expect(rows.map((r) => r.profile)).toEqual(['alpha', 'beta']);
  });

  it('narrows to the bound account rather than the whole pool', async () => {
    const rows = await collectUsage({
      all: false,
      accounts: METERED_POOL,
      sessionAccountId: 'beta',
    });

    expect(rows.map((r) => r.profile)).toEqual(['beta']);
  });

  it('surfaces a stale binding as its own row', async () => {
    const rows = await collectUsage({
      all: false,
      accounts: METERED_POOL,
      sessionAccountId: 'gone',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].error).toMatch(/no longer configured/i);
  });

  it('falls back to discovery when the pool is empty or absent', async () => {
    // Not asserting which profiles exist — only that it did NOT take the pool
    // path, which would have produced the pool's ids.
    for (const accounts of [[], undefined]) {
      const rows = await collectUsage({ all: true, accounts });
      expect(rows.map((r) => r.profile)).not.toContain('alpha');
    }
  });
});

describe('the plan badge reaches the rendered output', () => {
  it('renders the plan beside the account', () => {
    // planLabel could be correct and still never be wired into a row.
    const out = renderProfiles([
      { profile: 'vvs', email: 'a@b.test', plan: 'Max 20×', limits: [] },
    ]);

    expect(out).toContain('vvs (a@b.test · Max 20×)');
  });
});
