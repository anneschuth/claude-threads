/**
 * Unit tests for the DM auto-discovery runtime — the lifecycle logic that was
 * previously untestable inside index.ts: discovery, handover routing, ABA-safe
 * teardown, orphan reaping, boot reconstruction and settling.
 */

import { describe, it, expect } from 'bun:test';
import { createDmDiscoveryRuntime, type DmDiscoveryDeps } from './dm-discovery-runtime.js';
import { _inFlightSessionStarts } from '../session/lifecycle.js';
import type { MattermostPlatformConfig } from '../config/types.js';
import type { PlatformClient, PlatformPost, PlatformUser } from './index.js';
import type { SessionManager } from '../session/index.js';
import { sleep } from '../../tests/integration/helpers/wait-for.js';

const parentConfig: MattermostPlatformConfig = {
  id: 'mm-main',
  type: 'mattermost',
  displayName: 'Main',
  url: 'https://mm.test',
  token: 'tok',
  channelId: 'main-channel',
  botName: 'bot',
  allowedUsers: ['alice'],
  directMessages: true,
};

function makePost(overrides: Partial<PlatformPost> = {}): PlatformPost {
  return {
    id: `post-${Math.random().toString(36).slice(2, 8)}`,
    platformId: 'mm-main',
    channelId: 'dm-chan-1',
    userId: 'u-alice',
    message: 'hello',
    rootId: '',
    createAt: 0,
    ...overrides,
  };
}
const alice: PlatformUser = { id: 'u-alice', username: 'alice', displayName: 'Alice' };
const mallory: PlatformUser = { id: 'u-mallory', username: 'mallory', displayName: 'Mallory' };

interface Harness {
  deps: DmDiscoveryDeps;
  platforms: Map<string, PlatformClient>;
  parent: PlatformClient & { emitDm: (post: PlatformPost, user: PlatformUser | null) => Promise<void> };
  delivered: Array<{ platformId: string; postId: string }>;
  removedPlatforms: string[];
  removedUiRows: string[];
  cancelled: string[];
  activeSessions: Set<string>;
  persisted: Map<string, { threadId: string; platformId: string; sessionAllowedUsers?: string[]; startedBy?: string }>;
  makeClient: (behavior?: { connect?: () => Promise<void> }) => PlatformClient & { disconnected: () => boolean };
  lastRegisteredClient: () => (PlatformClient & { disconnected: () => boolean }) | undefined;
}

function makeHarness(opts: { graceMs?: number; orphanTtlMs?: number; connect?: () => Promise<void>; cancelBehavior?: (tid: string) => Promise<void>; isEnabled?: (id: string) => boolean } = {}): Harness {
  const platforms = new Map<string, PlatformClient>();
  const delivered: Harness['delivered'] = [];
  const removedPlatforms: string[] = [];
  const removedUiRows: string[] = [];
  const cancelled: string[] = [];
  const activeSessions = new Set<string>();
  const persisted: Harness['persisted'] = new Map();
  let lastClient: (PlatformClient & { disconnected: () => boolean }) | undefined;

  const makeClient = (behavior: { connect?: () => Promise<void> } = {}) => {
    let disconnected = false;
    const client = {
      connect: behavior.connect ?? (() => Promise.resolve()),
      disconnect: () => { disconnected = true; return Promise.resolve(); },
      getBotName: () => 'bot',
      on: () => client,
      disconnected: () => disconnected,
    } as unknown as PlatformClient & { disconnected: () => boolean };
    return client;
  };

  const listeners: Array<(post: PlatformPost, user: PlatformUser | null) => Promise<void>> = [];
  const parent = {
    isUserAllowed: (u: string) => u === 'alice',
    on: (event: string, handler: (post: PlatformPost, user: PlatformUser | null) => Promise<void>) => {
      if (event === 'direct_message') listeners.push(handler);
    },
    emitDm: async (post: PlatformPost, user: PlatformUser | null) => {
      for (const l of listeners) await l(post, user);
    },
  } as unknown as Harness['parent'];

  const session = {
    registry: { findByThreadId: (tid: string) => (activeSessions.has(tid) ? {} : undefined) },
    removePlatform: (id: string) => { removedPlatforms.push(id); },
    cancelSession: async (tid: string) => {
      if (opts.cancelBehavior) await opts.cancelBehavior(tid);
      cancelled.push(tid);
      activeSessions.delete(tid);
    },
    addPlatform: () => {},
  } as unknown as SessionManager;

  const deps: DmDiscoveryDeps = {
    platforms,
    session,
    log: () => {},
    registerPlatform: (cfg) => {
      const client = makeClient({ connect: opts.connect });
      lastClient = client;
      platforms.set(cfg.id, client);
      return client;
    },
    deliverMessage: async (_client, post, _user, platformId) => {
      delivered.push({ platformId, postId: post.id });
    },
    loadPersistedSessions: () => persisted as never,
    isEnabled: opts.isEnabled,
    removeUiRow: (id) => { removedUiRows.push(id); },
    graceMs: opts.graceMs ?? 40,
    orphanTtlMs: opts.orphanTtlMs ?? 80,
  };

  return { deps, platforms, parent, delivered, removedPlatforms, removedUiRows, cancelled, activeSessions, persisted, makeClient, lastRegisteredClient: () => lastClient };
}

const DM_ID = 'mm-main--dm-dm-chan-1';
const THREAD_ID = `dcm:${DM_ID}`;

describe('dm-discovery-runtime: live discovery', () => {
  it('spawns an instance for an allowed cold DM and delivers the first message', async () => {
    const h = makeHarness();
    const rt = createDmDiscoveryRuntime(h.deps);
    rt.wireParent(parentConfig, h.parent);

    const post = makePost();
    await h.parent.emitDm(post, alice);

    expect(h.platforms.has(DM_ID)).toBe(true);
    expect(h.delivered).toEqual([{ platformId: DM_ID, postId: post.id }]);
    // The routed post is deduped for the handover window.
    expect(rt.isRoutedPost(post.id)).toBe(true);
  });

  it('ignores users not on the parent allowlist', async () => {
    const h = makeHarness();
    const rt = createDmDiscoveryRuntime(h.deps);
    rt.wireParent(parentConfig, h.parent);

    await h.parent.emitDm(makePost({ userId: 'u-mallory' }), mallory);

    expect(h.platforms.size).toBe(0);
    expect(h.delivered.length).toBe(0);
  });

  it('routes messages via the parent only during the connect window', async () => {
    let resolveConnect!: () => void;
    const h = makeHarness({ connect: () => new Promise<void>((r) => { resolveConnect = r; }) });
    const rt = createDmDiscoveryRuntime(h.deps);
    rt.wireParent(parentConfig, h.parent);

    await h.parent.emitDm(makePost(), alice);          // spawns, connect pending
    await h.parent.emitDm(makePost(), alice);          // connect window → parent routes
    expect(h.delivered.length).toBe(2);

    resolveConnect();
    await sleep(10);
    await h.parent.emitDm(makePost(), alice);          // instance's own socket owns it now
    expect(h.delivered.length).toBe(2);
  });

  it('kills a stranded session and tears down when the connect fails', async () => {
    let rejectConnect!: (err: Error) => void;
    const h = makeHarness({ connect: () => new Promise<void>((_r, rej) => { rejectConnect = rej; }) });
    const rt = createDmDiscoveryRuntime(h.deps);
    rt.wireParent(parentConfig, h.parent);

    await h.parent.emitDm(makePost(), alice);
    const client = h.lastRegisteredClient()!;
    h.activeSessions.add(THREAD_ID);                   // first message created a session

    rejectConnect(new Error('boom'));
    await sleep(20);

    expect(h.cancelled).toEqual([THREAD_ID]);
    expect(h.platforms.has(DM_ID)).toBe(false);
    expect(h.removedPlatforms).toContain(DM_ID);
    expect(client.disconnected()).toBe(true);
  });
});

describe('dm-discovery-runtime: connect-failure ordering', () => {
  it('awaits a slow cancellation before removing the platform', async () => {
    let rejectConnect!: (err: Error) => void;
    let finishCancel!: () => void;
    const h = makeHarness({
      connect: () => new Promise<void>((_r, rej) => { rejectConnect = rej; }),
      cancelBehavior: () => new Promise<void>((r) => { finishCancel = r; }),
    });
    const rt = createDmDiscoveryRuntime(h.deps);
    rt.wireParent(parentConfig, h.parent);
    await h.parent.emitDm(makePost(), alice);
    h.activeSessions.add(THREAD_ID);

    rejectConnect(new Error('boom'));
    await sleep(20);
    // Cancellation is still pending — the platform must NOT be gone yet
    // (the old fire-and-forget ordering would already have removed it).
    expect(h.platforms.has(DM_ID)).toBe(true);

    finishCancel();
    await sleep(20);
    expect(h.cancelled).toEqual([THREAD_ID]);
    expect(h.platforms.has(DM_ID)).toBe(false);
  });

  it('retries a rejected cancellation once and still tears down', async () => {
    let rejectConnect!: (err: Error) => void;
    let attempts = 0;
    const h = makeHarness({
      connect: () => new Promise<void>((_r, rej) => { rejectConnect = rej; }),
      cancelBehavior: async () => {
        attempts++;
        if (attempts === 1) throw new Error('post failed');
      },
    });
    const rt = createDmDiscoveryRuntime(h.deps);
    rt.wireParent(parentConfig, h.parent);
    await h.parent.emitDm(makePost(), alice);
    h.activeSessions.add(THREAD_ID);

    rejectConnect(new Error('boom'));
    await sleep(30);
    expect(attempts).toBe(2);                          // retried
    expect(h.cancelled).toEqual([THREAD_ID]);          // second attempt landed
    expect(h.platforms.has(DM_ID)).toBe(false);
  });

  it('waits for an in-flight session start before the registry check', async () => {
    let rejectConnect!: (err: Error) => void;
    const h = makeHarness({ connect: () => new Promise<void>((_r, rej) => { rejectConnect = rej; }) });
    const rt = createDmDiscoveryRuntime(h.deps);
    rt.wireParent(parentConfig, h.parent);
    await h.parent.emitDm(makePost(), alice);

    // Simulate a session start still in flight when the connect fails: the
    // session registers only after the start promise resolves.
    let finishStart!: () => void;
    const startPromise = new Promise<void>((r) => { finishStart = r; });
    _inFlightSessionStarts.set(`${DM_ID}:${THREAD_ID}`, startPromise);

    rejectConnect(new Error('boom'));
    await sleep(20);
    expect(h.cancelled.length).toBe(0);                // still waiting on the start

    h.activeSessions.add(THREAD_ID);                   // start completed → session registered
    finishStart();
    _inFlightSessionStarts.delete(`${DM_ID}:${THREAD_ID}`);
    await sleep(20);
    expect(h.cancelled).toEqual([THREAD_ID]);          // late session was found and cancelled
    expect(h.platforms.has(DM_ID)).toBe(false);
  });

  it('waits through a replacement retry generation before the registry check', async () => {
    let rejectConnect!: (err: Error) => void;
    const h = makeHarness({ connect: () => new Promise<void>((_r, rej) => { rejectConnect = rej; }) });
    const rt = createDmDiscoveryRuntime(h.deps);
    rt.wireParent(parentConfig, h.parent);
    await h.parent.emitDm(makePost(), alice);

    const key = `${DM_ID}:${THREAD_ID}`;
    // Generation A: a start that will fail (no session registered).
    let finishA!: () => void;
    _inFlightSessionStarts.set(key, new Promise<void>((r) => { finishA = r; }));

    rejectConnect(new Error('boom'));
    await sleep(15);
    expect(h.cancelled.length).toBe(0);                 // waiting on A

    // A fails; a waiter immediately installs retry generation B under the
    // same key (mirrors the startSession wrapper's retry behavior).
    let finishB!: () => void;
    _inFlightSessionStarts.set(key, new Promise<void>((r) => { finishB = r; }));
    finishA();
    await sleep(15);
    expect(h.cancelled.length).toBe(0);                 // must now wait on B, not proceed

    // B succeeds and registers a session — cleanup must find and cancel it.
    h.activeSessions.add(THREAD_ID);
    finishB();
    _inFlightSessionStarts.delete(key);
    await sleep(20);
    expect(h.cancelled).toEqual([THREAD_ID]);
    expect(h.platforms.has(DM_ID)).toBe(false);
  });

  it('sweep cancels a session that slipped through the empty-map window', async () => {
    let rejectConnect!: (err: Error) => void;
    const h = makeHarness({ connect: () => new Promise<void>((_r, rej) => { rejectConnect = rej; }) });
    const rt = createDmDiscoveryRuntime(h.deps);
    rt.wireParent(parentConfig, h.parent);
    await h.parent.emitDm(makePost(), alice);

    rejectConnect(new Error('boom'));
    await sleep(20);                                   // cleanup ran, platform gone
    expect(h.platforms.has(DM_ID)).toBe(false);

    // A retry generation registered its session AFTER cleanup's registry
    // check (the transient empty-map ordering) — bound to the removed client.
    h.activeSessions.add(THREAD_ID);

    await sleep(2200);                                 // the sweep enforces the invariant
    expect(h.cancelled).toContain(THREAD_ID);
  }, 10000);

  it('reconstructPersisted reports skipped disabled instances', () => {
    const h = makeHarness();
    const rt = createDmDiscoveryRuntime(h.deps);
    h.persisted.set('x', { threadId: THREAD_ID, platformId: DM_ID, sessionAllowedUsers: ['alice'], startedBy: 'alice' });

    const skipped = rt.reconstructPersisted([parentConfig], () => false);

    expect(skipped).toEqual([{ platformId: DM_ID, channelId: 'dm-chan-1' }]);
    expect(h.platforms.size).toBe(0);
  });

  it('live discovery ignores a disabled derived instance id', async () => {
    const h = makeHarness({ isEnabled: (id) => id !== DM_ID });
    const rt = createDmDiscoveryRuntime(h.deps);
    rt.wireParent(parentConfig, h.parent);

    await h.parent.emitDm(makePost(), alice);

    expect(h.platforms.size).toBe(0);
    expect(h.delivered.length).toBe(0);
  });
});

describe('dm-discovery-runtime: teardown lifecycle', () => {
  it('tears down after the grace period when the session ended', async () => {
    const h = makeHarness({ graceMs: 30 });
    const rt = createDmDiscoveryRuntime(h.deps);
    rt.wireParent(parentConfig, h.parent);
    await h.parent.emitDm(makePost(), alice);

    rt.onSessionRemove(`${DM_ID}:${THREAD_ID}`);
    expect(h.platforms.has(DM_ID)).toBe(true);         // grace not elapsed yet
    await sleep(60);
    expect(h.platforms.has(DM_ID)).toBe(false);
    expect(h.removedPlatforms).toContain(DM_ID);
  });

  it('a new session on the instance cancels the pending teardown', async () => {
    const h = makeHarness({ graceMs: 30 });
    const rt = createDmDiscoveryRuntime(h.deps);
    rt.wireParent(parentConfig, h.parent);
    await h.parent.emitDm(makePost(), alice);

    rt.onSessionRemove(`${DM_ID}:${THREAD_ID}`);
    h.activeSessions.add(THREAD_ID);                   // new session takes over
    await sleep(60);
    expect(h.platforms.has(DM_ID)).toBe(true);
  });

  it('ABA: a stale grace timer never tears down a replacement client under the same id', async () => {
    const h = makeHarness({ graceMs: 30 });
    const rt = createDmDiscoveryRuntime(h.deps);
    rt.wireParent(parentConfig, h.parent);
    await h.parent.emitDm(makePost(), alice);

    rt.onSessionRemove(`${DM_ID}:${THREAD_ID}`);       // timer captured gen-1
    // The instance is swapped without a teardown (the defense-in-depth case:
    // every teardown path cancels the timer, so only an untracked swap can
    // leave a stale timer behind). The captured-client guard must hold.
    const gen2 = h.makeClient();
    h.platforms.set(DM_ID, gen2);

    await sleep(60);
    expect(h.platforms.get(DM_ID)).toBe(gen2);         // survived the stale timer
    expect(h.removedPlatforms).not.toContain(DM_ID);
  });

  it('orphan reaper removes an instance that never produced a session', async () => {
    const h = makeHarness({ orphanTtlMs: 40 });
    const rt = createDmDiscoveryRuntime(h.deps);
    rt.wireParent(parentConfig, h.parent);
    await h.parent.emitDm(makePost(), alice);

    await sleep(80);
    expect(h.platforms.has(DM_ID)).toBe(false);
  });

  it('teardown removes the UI status row of the torn-down instance', async () => {
    const h = makeHarness({ orphanTtlMs: 40 });
    const rt = createDmDiscoveryRuntime(h.deps);
    rt.wireParent(parentConfig, h.parent);
    await h.parent.emitDm(makePost(), alice);

    await sleep(80);
    expect(h.removedUiRows).toEqual([DM_ID]);
  });

  it('teardown keeps the UI row of a disabled instance (re-enable handle)', async () => {
    const enabled = new Map<string, boolean>();
    const h = makeHarness({ orphanTtlMs: 40, isEnabled: (id) => enabled.get(id) ?? true });
    const rt = createDmDiscoveryRuntime(h.deps);
    rt.wireParent(parentConfig, h.parent);
    await h.parent.emitDm(makePost(), alice);
    enabled.set(DM_ID, false);

    await sleep(80);
    expect(h.platforms.has(DM_ID)).toBe(false);
    expect(h.removedUiRows).toEqual([]);
  });

  it('orphan reaper spares an instance with a resumable persisted session', async () => {
    const h = makeHarness({ orphanTtlMs: 40 });
    const rt = createDmDiscoveryRuntime(h.deps);
    rt.wireParent(parentConfig, h.parent);
    await h.parent.emitDm(makePost(), alice);
    h.persisted.set('x', { threadId: THREAD_ID, platformId: DM_ID });

    await sleep(80);
    expect(h.platforms.has(DM_ID)).toBe(true);
  });
});

describe('dm-discovery-runtime: boot reconstruction', () => {
  const persistedSession = { threadId: THREAD_ID, platformId: DM_ID, sessionAllowedUsers: ['alice'], startedBy: 'alice' };

  it('reconstructs a persisted DM instance and keeps it in the forwarding window until settled', async () => {
    const h = makeHarness();
    const rt = createDmDiscoveryRuntime(h.deps);
    h.persisted.set('x', persistedSession);

    rt.reconstructPersisted([parentConfig], () => true);
    expect(h.platforms.has(DM_ID)).toBe(true);

    // Connect window: parent still forwards.
    rt.wireParent(parentConfig, h.parent);
    const during = makePost();
    await h.parent.emitDm(during, alice);
    expect(h.delivered).toEqual([{ platformId: DM_ID, postId: during.id }]);

    // Settle success → forwarding stops.
    rt.settleBootResult(DM_ID, true, h.platforms.get(DM_ID));
    const after = makePost();
    await h.parent.emitDm(after, alice);
    expect(h.delivered.length).toBe(1);
  });

  it('tears down a reconstructed instance whose boot connect failed', () => {
    const h = makeHarness();
    const rt = createDmDiscoveryRuntime(h.deps);
    h.persisted.set('x', persistedSession);
    rt.reconstructPersisted([parentConfig], () => true);
    const client = h.platforms.get(DM_ID);

    rt.settleBootResult(DM_ID, false, client);
    expect(h.platforms.has(DM_ID)).toBe(false);
    expect(h.removedPlatforms).toContain(DM_ID);
  });

  it('skips disabled instances and foreign parents', () => {
    const h = makeHarness();
    const rt = createDmDiscoveryRuntime(h.deps);
    h.persisted.set('x', persistedSession);
    rt.reconstructPersisted([parentConfig], () => false);      // disabled
    expect(h.platforms.size).toBe(0);

    h.persisted.set('y', { ...persistedSession, platformId: 'other--dm-abc', threadId: 'dcm:other--dm-abc' });
    rt.reconstructPersisted([parentConfig], () => true);
    expect(h.platforms.has('other--dm-abc')).toBe(false);      // parent unknown
    expect(h.platforms.has(DM_ID)).toBe(true);                 // own one reconstructed
  });

  it('a stale settle result cannot touch a replacement client', () => {
    const h = makeHarness();
    const rt = createDmDiscoveryRuntime(h.deps);
    h.persisted.set('x', persistedSession);
    rt.reconstructPersisted([parentConfig], () => true);
    const gen1 = h.platforms.get(DM_ID);

    // Replacement appears under the same id (teardown + rediscovery).
    const gen2 = h.makeClient();
    h.platforms.set(DM_ID, gen2);

    rt.settleBootResult(DM_ID, false, gen1);                   // stale failure
    expect(h.platforms.get(DM_ID)).toBe(gen2);                 // untouched
  });
});
