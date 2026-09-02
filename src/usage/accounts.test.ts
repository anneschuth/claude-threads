import { describe, it, expect } from 'bun:test';
import { accountTargets } from './accounts.js';
import type { ClaudeAccount } from '../config/types.js';

const POOL: ClaudeAccount[] = [
  { id: 'work', home: '/home/herder/accounts/work', displayName: 'Work seat' },
  { id: 'personal', home: '/home/herder/accounts/personal' },
  { id: 'metered', apiKey: 'sk-ant-xxx' },
];

describe('accountTargets', () => {
  it('reads a pooled account from <home>/.claude, not from ~/.claude-*', () => {
    // The pool identifies accounts by an alternate $HOME holding
    // .claude/.credentials.json. Our own ~/.claude-* discovery never descends
    // there, so without this mapping `!usage all` would report seats the bot
    // has stopped using and none of the ones actually burning tokens.
    const [work] = accountTargets(POOL);

    expect(work.configDir).toBe('/home/herder/accounts/work/.claude');
  });

  it('labels rows by the pool\'s own identity so both sides agree', () => {
    const names = accountTargets(POOL).map((t) => t.name);

    // displayName when set, else the id — the same string the pool writes in
    // its logs and sticky message, so a row here can be matched to a routing
    // decision there.
    expect(names).toEqual(['Work seat', 'personal', 'metered']);
  });

  it('keeps an API-key account visible but explains why it has no windows', () => {
    // API-key billing has no subscription limits to report. Dropping the row
    // would read as "this account is fine"; it is simply a different thing.
    const metered = accountTargets(POOL).find((t) => t.name === 'metered');

    expect(metered?.configDir).toBeUndefined();
    expect(metered?.note).toMatch(/API key/i);
  });

  it('narrows to one account when a session is bound to it', () => {
    const targets = accountTargets(POOL, 'personal');

    expect(targets.map((t) => t.name)).toEqual(['personal']);
  });

  it('names a stale binding instead of quietly widening to the whole pool', () => {
    // Returning every account here reads exactly like `!usage all`, so the
    // stale binding would never be noticed.
    const targets = accountTargets(POOL, 'deleted-account');

    expect(targets).toHaveLength(1);
    expect(targets[0].name).toBe('deleted-account');
    expect(targets[0].note).toMatch(/no longer configured/i);
    expect(targets[0].configDir).toBeUndefined();
  });

  it('has nothing to offer when no pool is configured', () => {
    expect(accountTargets([])).toEqual([]);
    expect(accountTargets(undefined)).toEqual([]);
  });
});
