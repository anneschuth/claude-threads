/**
 * Shared event source tests
 *
 * Several SlackClient instances serving one Slack app must not each open a
 * Socket Mode connection: Slack round-robins envelopes across an app's
 * connections, so every extra socket silently steals events from the others.
 * These tests cover the alternative: one parent client owns the socket and
 * routes events for other channels into registered secondary clients.
 */

import { installFetchHarness, jsonResponse, type FetchResponder } from '../test-helpers/fetch-harness.js';
import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import { SlackClient } from './client.js';
import type { SlackPlatformConfig } from '../../config/types.js';

let fetchResponder: FetchResponder = () => jsonResponse({ ok: true });
const harness = installFetchHarness(() => fetchResponder);

const ok = (body: Record<string, unknown> = {}) => jsonResponse({ ok: true, ...body });

function makeConfig(overrides: Partial<SlackPlatformConfig> = {}): SlackPlatformConfig {
  return {
    type: 'slack',
    id: overrides.id ?? 'parent',
    displayName: 'Test',
    botToken: 'xoxb-x',
    appToken: 'xapp-x',
    channelId: overrides.channelId ?? 'C-PARENT',
    botName: 'claude',
    allowedUsers: [],
    ...overrides,
  } as SlackPlatformConfig;
}

function makeParent(): SlackClient {
  return new SlackClient(makeConfig());
}

function makeSecondary(parent: SlackClient, channelId: string): SlackClient {
  return new SlackClient(makeConfig({ id: `parent--ch-${channelId}`, channelId }), parent);
}

function messageEvent(channel: string, text = 'hello', ts = '111.222') {
  return { type: 'message', channel, ts, user: 'U-HUMAN', text };
}

/** Let queued microtasks (e.g. getUser().then(...)) run before asserting. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// The shared-event-source contract lives on protected/private members; these
// reach them deliberately rather than widening the production API for tests.
function setSocketConnected(client: SlackClient, value: boolean): void {
  (client as unknown as { socketConnected: boolean }).socketConnected = value;
}

function setReconnecting(client: SlackClient, value: boolean): void {
  (client as unknown as { isReconnecting: boolean }).isReconnecting = value;
}

function fireConnectionEstablished(client: SlackClient): void {
  (client as unknown as { onConnectionEstablished: () => void }).onConnectionEstablished();
}

function stubRecovery(client: SlackClient) {
  return spyOn(
    client as unknown as { recoverMissedMessages: () => Promise<void> },
    'recoverMissedMessages'
  ).mockResolvedValue(undefined);
}

beforeEach(() => {
  fetchResponder = (url) => {
    if (String(url).endsWith('auth.test')) return ok({ user_id: 'U-BOT', url: 'https://team.slack.com/' });
    if (String(url).includes('users.info')) {
      return ok({ user: { id: 'U-BOT', name: 'claude', real_name: 'Claude', profile: {} } });
    }
    return ok();
  };
});

describe('secondary connect()', () => {
  it('registers with the parent and never opens a Socket Mode connection', async () => {
    const parent = makeParent();
    const secondary = makeSecondary(parent, 'C-TASK');

    let connected = false;
    secondary.on('connected', () => { connected = true; });
    await secondary.connect();

    // The parent's socket is not live yet, so the secondary must NOT claim to
    // be connected — its only feed does not exist. The state mirror delivers
    // 'connected' when the parent's hello arrives.
    expect(connected).toBe(false);
    expect(harness.calls.some((c) => c.url.includes('apps.connections.open'))).toBe(false);

    // Registration is live: parent routes an event for the secondary's channel.
    const inject = spyOn(secondary, '_injectSlackEvent');
    parent._injectSlackEvent(messageEvent('C-TASK'));
    expect(inject).toHaveBeenCalledTimes(1);

    // ...and the deferred 'connected' lands with the parent's.
    parent.emit('connected');
    expect(connected).toBe(true);
  });

  it("emits 'connected' immediately when the parent's socket is already live", async () => {
    const parent = makeParent();
    setSocketConnected(parent, true);
    const secondary = makeSecondary(parent, 'C-TASK');

    let connected = false;
    secondary.on('connected', () => { connected = true; });
    await secondary.connect();

    expect(connected).toBe(true);
  });
});

describe('parent-side routing', () => {
  it('hands events for a registered channel to that secondary, including reaction items', () => {
    const parent = makeParent();
    const secondary = makeSecondary(parent, 'C-TASK');
    parent.registerChannelClient('C-TASK', secondary);
    const inject = spyOn(secondary, '_injectSlackEvent');

    parent._injectSlackEvent(messageEvent('C-TASK'));
    parent._injectSlackEvent({
      type: 'reaction_added',
      user: 'U-HUMAN',
      reaction: 'eyes',
      item: { type: 'message', channel: 'C-TASK', ts: '111.222' },
    });

    expect(inject).toHaveBeenCalledTimes(2);
  });

  it('keeps handling its own channel itself', () => {
    const parent = makeParent();
    const secondary = makeSecondary(parent, 'C-TASK');
    parent.registerChannelClient('C-TASK', secondary);
    const inject = spyOn(secondary, '_injectSlackEvent');

    parent._injectSlackEvent(messageEvent('C-PARENT'));
    expect(inject).not.toHaveBeenCalled();
  });

  it('leaves events for unregistered foreign channels to the existing drop path', () => {
    const parent = makeParent();
    let emitted = 0;
    parent.on('message', () => { emitted += 1; });

    // No throw, no message emission — same as before the routing existed.
    parent._injectSlackEvent(messageEvent('C-UNKNOWN'));
    expect(emitted).toBe(0);
  });

  it('stops routing after unregisterChannelClient', () => {
    const parent = makeParent();
    const secondary = makeSecondary(parent, 'C-TASK');
    parent.registerChannelClient('C-TASK', secondary);
    parent.unregisterChannelClient('C-TASK');
    const inject = spyOn(secondary, '_injectSlackEvent');

    parent._injectSlackEvent(messageEvent('C-TASK'));
    expect(inject).not.toHaveBeenCalled();
  });
});

describe('lifecycle and safety', () => {
  it('mirrors the parent connection state onto registered secondaries', () => {
    const parent = makeParent();
    const secondary = makeSecondary(parent, 'C-TASK');
    parent.registerChannelClient('C-TASK', secondary);

    const seen: string[] = [];
    secondary.on('disconnected', () => seen.push('disconnected'));
    secondary.on('connected', () => seen.push('connected'));

    parent.emit('disconnected');
    parent.emit('connected');
    expect(seen).toEqual(['disconnected', 'connected']);
  });

  it("an old secondary's disconnect does not evict its replacement", async () => {
    const parent = makeParent();
    const old = makeSecondary(parent, 'C-TASK');
    await old.connect();
    const replacement = makeSecondary(parent, 'C-TASK');
    parent.registerChannelClient('C-TASK', replacement);

    await old.disconnect();
    const inject = spyOn(replacement, '_injectSlackEvent');
    parent._injectSlackEvent(messageEvent('C-TASK'));
    expect(inject).toHaveBeenCalledTimes(1);
  });

  it('rejects registering a secondary for the parent\'s own channel', () => {
    const parent = makeParent();
    const secondary = makeSecondary(parent, 'C-PARENT');
    expect(() => parent.registerChannelClient('C-PARENT', secondary)).toThrow(/own channel/);
  });

  it('injected messages flow through the secondary\'s own pipeline to a message emission', async () => {
    const parent = makeParent();
    const secondary = makeSecondary(parent, 'C-TASK');
    parent.registerChannelClient('C-TASK', secondary);

    const post = new Promise<{ message: string }>((resolve) => {
      secondary.on('message', (p: { message: string }) => resolve(p));
    });
    parent._injectSlackEvent(messageEvent('C-TASK', 'through the pipe'));
    const received = await post;
    expect(received.message).toContain('through the pipe');

    // Dedup still applies on the injected path: same ts again → no second emit.
    // The emission is deferred through getUser().then(...), so flush the
    // microtask queue first — asserting synchronously passes even with the
    // dedup guard removed.
    const emitSpy = spyOn(secondary, 'emit');
    parent._injectSlackEvent(messageEvent('C-TASK', 'through the pipe'));
    await flush();
    expect(emitSpy.mock.calls.filter((c) => c[0] === 'message')).toHaveLength(0);
  });

  it('keeps mirroring parent state after the parent disconnects and reconnects', async () => {
    const parent = makeParent();
    const secondary = makeSecondary(parent, 'C-TASK');
    parent.registerChannelClient('C-TASK', secondary);

    // Base teardown detaches every listener, the state mirror included.
    await parent.disconnect();
    parent.prepareForReconnect();

    const seen: string[] = [];
    secondary.on('connected', () => seen.push('connected'));
    parent.emit('connected');

    expect(seen).toEqual(['connected']);
  });

  it('re-arms the mirror before the socket close settles', () => {
    const parent = makeParent();
    const secondary = makeSecondary(parent, 'C-TASK');
    parent.registerChannelClient('C-TASK', secondary);

    const seen: string[] = [];
    secondary.on('connected', () => seen.push('connected'));

    // Base teardown drops the listeners synchronously but the socket close is
    // a promise that can stay pending. A reconnect landing inside that window
    // must not emit into a mirror-less parent — the secondaries would miss it
    // permanently. Deliberately not awaited: that IS the window.
    const closing = parent.disconnect();
    parent.emit('connected');

    expect(seen).toEqual(['connected']);
    return closing;
  });

  it('does not stack mirror listeners when disconnects overlap', async () => {
    const parent = makeParent();
    const secondary = makeSecondary(parent, 'C-TASK');
    parent.registerChannelClient('C-TASK', secondary);

    // Both calls clear the listeners before either re-arms; a non-idempotent
    // install leaves two mirrors, so every later event reaches the secondary
    // twice.
    await Promise.all([parent.disconnect(), parent.disconnect()]);

    const seen: string[] = [];
    secondary.on('connected', () => seen.push('connected'));
    parent.emit('connected');

    expect(seen).toEqual(['connected']);
  });

  it('re-arms the mirror even when the socket close throws synchronously', () => {
    const parent = makeParent();
    const secondary = makeSecondary(parent, 'C-TASK');
    parent.registerChannelClient('C-TASK', secondary);

    spyOn(
      parent as unknown as { forceCloseConnection: () => Promise<void> },
      'forceCloseConnection'
    ).mockImplementation(() => {
      throw new Error('close blew up');
    });

    // The failure must still propagate — but it must not also leave the parent
    // permanently mute towards its secondaries.
    expect(() => parent.disconnect()).toThrow('close blew up');

    const seen: string[] = [];
    secondary.on('connected', () => seen.push('connected'));
    parent.emit('connected');

    expect(seen).toEqual(['connected']);
  });
});

describe('reconnect recovery', () => {
  it('recovers missed messages for every registered secondary', async () => {
    const parent = makeParent();
    const first = makeSecondary(parent, 'C-ONE');
    const second = makeSecondary(parent, 'C-TWO');
    parent.registerChannelClient('C-ONE', first);
    parent.registerChannelClient('C-TWO', second);

    const firstRecovery = stubRecovery(first);
    const secondRecovery = stubRecovery(second);

    // A reconnect: the parent's socket dropped and came back, so every
    // secondary missed whatever arrived in the gap — their only feed is here.
    setReconnecting(parent, true);
    fireConnectionEstablished(parent);

    expect(firstRecovery).toHaveBeenCalledTimes(1);
    expect(secondRecovery).toHaveBeenCalledTimes(1);

    await parent.disconnect();
  });

  it('does not recover for secondaries on a first connect', async () => {
    const parent = makeParent();
    const secondary = makeSecondary(parent, 'C-TASK');
    parent.registerChannelClient('C-TASK', secondary);
    const recovery = stubRecovery(secondary);

    setReconnecting(parent, false);
    fireConnectionEstablished(parent);

    expect(recovery).not.toHaveBeenCalled();

    await parent.disconnect();
  });
});

describe('secondary disconnect()', () => {
  it('unregisters itself from the parent', async () => {
    const parent = makeParent();
    const secondary = makeSecondary(parent, 'C-TASK');
    await secondary.connect();
    const inject = spyOn(secondary, '_injectSlackEvent');

    await secondary.disconnect();
    parent._injectSlackEvent(messageEvent('C-TASK'));
    expect(inject).not.toHaveBeenCalled();
  });
});
