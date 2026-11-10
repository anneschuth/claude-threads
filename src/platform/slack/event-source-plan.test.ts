/**
 * Which configured Slack entries must share one Socket Mode connection.
 *
 * Slack round-robins Socket Mode envelopes across all of an app's open
 * connections, so two `platforms:` entries with the same app token that each
 * open a socket lose each other's events — in both channels, silently.
 * The plan makes the first enabled entry per app token the parent (it owns the
 * socket) and every other entry on that token its secondary (#502 plumbing).
 */

import { describe, it, expect } from 'bun:test';
import { planSlackEventSources } from './event-source-plan.js';

const slack = (id: string, appToken = 'xapp-A') => ({ id, type: 'slack' as const, appToken });
const mm = (id: string) => ({ id, type: 'mattermost' as const });
const allEnabled = () => true;

describe('planSlackEventSources', () => {
  it('a single Slack entry owns its socket', () => {
    expect(planSlackEventSources([slack('a')], allEnabled)).toEqual(new Map());
  });

  it('two entries on one app token: the second is a secondary of the first', () => {
    expect(planSlackEventSources([slack('a'), slack('b')], allEnabled)).toEqual(new Map([['b', 'a']]));
  });

  it('three entries on one app token all route through the first', () => {
    const plan = planSlackEventSources([slack('a'), slack('b'), slack('c')], allEnabled);
    expect(plan).toEqual(new Map([['b', 'a'], ['c', 'a']]));
  });

  it('different app tokens are different apps: each keeps its own socket', () => {
    expect(planSlackEventSources([slack('a', 'xapp-A'), slack('b', 'xapp-B')], allEnabled)).toEqual(new Map());
  });

  it('a disabled first entry is not the parent: the first enabled one is', () => {
    const plan = planSlackEventSources([slack('a'), slack('b'), slack('c')], (id) => id !== 'a');
    expect(plan).toEqual(new Map([['a', 'b'], ['c', 'b']]));
  });

  it('with no enabled entry on a token there is no parent and nothing to route', () => {
    expect(planSlackEventSources([slack('a'), slack('b')], () => false)).toEqual(new Map());
  });

  it('Mattermost entries are never part of the plan', () => {
    expect(planSlackEventSources([mm('m'), slack('a'), mm('n'), slack('b')], allEnabled)).toEqual(new Map([['b', 'a']]));
  });
});
