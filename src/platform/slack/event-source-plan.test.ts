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
import {
  planSlackEventSources,
  secondariesOf,
  findSharedChannelConflicts,
  buildPlatformClients,
  connectSecondariesFirst,
} from './event-source-plan.js';

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

  it('with no enabled entry on a token the first one is still the parent', () => {
    // The plan outlives the boot: both can be enabled at runtime, and then
    // they must not each open a socket.
    expect(planSlackEventSources([slack('a'), slack('b')], () => false)).toEqual(new Map([['b', 'a']]));
  });

  it('Mattermost entries are never part of the plan', () => {
    expect(planSlackEventSources([mm('m'), slack('a'), mm('n'), slack('b')], allEnabled)).toEqual(new Map([['b', 'a']]));
  });
});

describe('secondariesOf', () => {
  it('lists every entry that routes through the parent, and nothing else', () => {
    const plan = planSlackEventSources([slack('a'), slack('b'), slack('x', 'xapp-B'), slack('c'), slack('y', 'xapp-B')], allEnabled);
    expect(secondariesOf(plan, 'a')).toEqual(['b', 'c']);
    expect(secondariesOf(plan, 'x')).toEqual(['y']);
    expect(secondariesOf(plan, 'b')).toEqual([]);
  });
});

describe('buildPlatformClients', () => {
  type Built = { id: string; parent?: Built };
  const build = (configs: Array<{ id: string; type: string; appToken?: string }>, isEnabled: (id: string) => boolean = allEnabled) => {
    const created: string[] = [];
    const clients = buildPlatformClients<{ id: string }, Built>(configs, planSlackEventSources(configs, isEnabled), (config, parent) => {
      created.push(config.id);
      return { id: config.id, parent };
    });
    return { created, clients };
  };

  it('hands a secondary its parent client, and an owner none', () => {
    const { clients } = build([slack('a'), slack('b'), mm('m')]);
    expect(clients.get('b')?.parent).toBe(clients.get('a'));
    expect(clients.get('a')?.parent).toBeUndefined();
    expect(clients.get('m')?.parent).toBeUndefined();
  });

  it('builds the parent first even when it comes later in the config', () => {
    // 'a' is disabled, so 'b' owns the socket and 'a' is built on it.
    const { created, clients } = build([slack('a'), slack('b')], (id) => id !== 'a');
    expect(created).toEqual(['b', 'a']);
    expect(clients.get('a')?.parent).toBe(clients.get('b'));
  });

  it('builds one client for every configured platform', () => {
    const { clients } = build([slack('a'), mm('m'), slack('b'), mm('n')], (id) => id !== 'a');
    expect([...clients.keys()].sort()).toEqual(['a', 'b', 'm', 'n']);
  });
});

describe('findSharedChannelConflicts', () => {
  const inChannel = (id: string, channelId: string, appToken = 'xapp-A') => ({ ...slack(id, appToken), channelId });

  it('reports an entry that repeats a channel of the same app', () => {
    expect(findSharedChannelConflicts([inChannel('a', 'C1'), inChannel('b', 'C2'), inChannel('c', 'C1')]))
      .toEqual([['c', 'a', 'C1']]);
  });

  it('ignores the same channel id on a different app, and Mattermost', () => {
    expect(findSharedChannelConflicts([inChannel('a', 'C1'), inChannel('b', 'C1', 'xapp-B'), { ...mm('m'), channelId: 'C1' }]))
      .toEqual([]);
  });
});

describe('connectSecondariesFirst', () => {
  const run = async (ids: string[], plan: Map<string, string>, delays: Record<string, number> = {}) => {
    const events: string[] = [];
    const results = await connectSecondariesFirst(ids.map((id) => [id, null] as const), plan, async ([id]) => {
      events.push(`start ${id}`);
      await new Promise((resolve) => setTimeout(resolve, delays[id] ?? 1));
      events.push(`done ${id}`);
      return id;
    });
    return { events, results };
  };

  it('starts a parent only after all of its secondaries are done', async () => {
    const { events } = await run(['a', 'b', 'c'], new Map([['b', 'a'], ['c', 'a']]), { b: 20 });
    expect(events.indexOf('done b')).toBeLessThan(events.indexOf('start a'));
    expect(events.indexOf('done c')).toBeLessThan(events.indexOf('start a'));
  });

  it('does not hold back an entry that shares nothing', async () => {
    const { events } = await run(['a', 'b', 'm'], new Map([['b', 'a']]), { b: 30 });
    expect(events.indexOf('start m')).toBeLessThan(events.indexOf('done b'));
  });

  it('connects a secondary whose parent is not in the list', async () => {
    const { results } = await run(['b'], new Map([['b', 'a']]));
    expect(results).toEqual([{ status: 'fulfilled', value: 'b' }]);
  });

  it('reports results in entry order, and a failed secondary does not stop its parent', async () => {
    const plan = new Map([['b', 'a']]);
    const results = await connectSecondariesFirst([['a', null], ['b', null]] as const, plan, async ([id]) => {
      if (id === 'b') throw new Error('nope');
      return id;
    });
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
  });
});
