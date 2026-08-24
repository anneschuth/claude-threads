/**
 * fireWatch admission tests — the skip/unauthorized paths that must decide
 * BEFORE startSession is reached. The minimal contexts here would explode
 * inside the real startSession, which is the red half of the red-green
 * policy: a guard that stops guarding fails these tests loudly.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { fireWatch } from './runner.js';
import { _inFlightSessionStarts } from '../session/lifecycle.js';
import type { SessionContext } from '../operations/session-context/index.js';
import type { Watch } from '../persistence/watches-store.js';

function makeWatch(overrides: Partial<Watch> = {}): Watch {
  return {
    id: 'w1',
    name: 'Incident triage',
    condition: 'someone reports a production incident',
    prompt: 'triage it',
    keywords: ['incident'],
    createdBy: 'anne',
    createdAt: new Date().toISOString(),
    enabled: true,
    consecutiveFailures: 0,
    ...overrides,
  };
}

function makeCtx(overrides: { sessions?: Map<string, unknown>; maxSessions?: number; userAllowed?: boolean; noPlatform?: boolean } = {}): SessionContext {
  const platforms = new Map<string, unknown>();
  if (!overrides.noPlatform) {
    platforms.set('mm', { isUserAllowed: () => overrides.userAllowed ?? true });
  }
  return {
    state: {
      platforms,
      sessions: overrides.sessions ?? new Map(),
    },
    config: { maxSessions: overrides.maxSessions ?? 5 },
    ops: { getSessionId: (platformId: string, threadId: string) => `${platformId}:${threadId}` },
  } as unknown as SessionContext;
}

describe('fireWatch admission', () => {
  afterEach(() => {
    _inFlightSessionStarts.clear();
  });

  test('skips when the platform is not registered', async () => {
    const result = await fireWatch(makeWatch(), 'mm', { id: 'p1' }, 'bob', makeCtx({ noPlatform: true }));
    expect(result).toBe('skipped');
  });

  test('reports a deauthorized creator (so the evaluator can disable the watch)', async () => {
    const result = await fireWatch(makeWatch(), 'mm', { id: 'p1' }, 'bob', makeCtx({ userAllowed: false }));
    expect(result).toBe('unauthorized');
  });

  test('skips at MAX_SESSIONS', async () => {
    const sessions = new Map([['mm:other', {}]]);
    const result = await fireWatch(makeWatch(), 'mm', { id: 'p1' }, 'bob', makeCtx({ sessions, maxSessions: 1 }));
    expect(result).toBe('skipped');
  });

  test('skips when the triggering thread already hosts a session', async () => {
    const sessions = new Map([['mm:root1', {}]]);
    const result = await fireWatch(makeWatch(), 'mm', { id: 'p2', rootId: 'root1' }, 'bob', makeCtx({ sessions }));
    expect(result).toBe('skipped');
  });

  test('skips when a session start for the thread is already in flight', async () => {
    // The confirm await is a ~10s race window: a user @mention in the same
    // thread can have an unregistered start in flight. Calling startSession
    // then would deliver the watch's synthetic prompt into the USER'S
    // session as a follow-up — the fire must skip instead. The entry never
    // resolves: with the guard the skip returns without touching it; a
    // regressed guard blocks in startSession's dedup wait and fails this
    // test by timeout.
    _inFlightSessionStarts.set('mm:p1', new Promise(() => {}));

    const result = await fireWatch(makeWatch(), 'mm', { id: 'p1' }, 'bob', makeCtx());
    expect(result).toBe('skipped');
  });
});
