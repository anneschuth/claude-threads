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

  // The no-pool path is deliberately NOT exercised here: it spawns a real
  // `claude -p "/usage"` probe, which would make this suite depend on a CLI
  // being installed and logged in. `accountTargets` returning no targets is
  // the branch decision itself, and accounts.test.ts pins it — everything
  // after that point is one probe of the account this process already runs
  // as, with no directory scan anywhere in it.
});

describe('the plan badge reaches the rendered output', () => {
  it('renders the plan badge with no email, since the badge is not private', () => {
    // The flag gates the address, not the plan: "Max 20×" says nothing about
    // who owns the seat, and it is the field that explains why one seat's
    // week is four times the other's.
    const out = renderProfiles([
      { profile: 'vvs', email: 'a@b.test', plan: 'Max 20×', limits: [] },
    ]);

    expect(out).toContain('vvs (Max 20×)');
    expect(out).not.toContain('a@b.test');
  });

  it('renders the plan beside the account', () => {
    // planLabel could be correct and still never be wired into a row.
    const out = renderProfiles(
      [{ profile: 'vvs', email: 'a@b.test', plan: 'Max 20×', limits: [] }],
      { showEmails: true }
    );

    expect(out).toContain('vvs (a@b.test · Max 20×)');
  });
});
