import { describe, it, expect } from 'bun:test';
import {
  findTeammate,
  resolveTeammateRoute,
  unreachableReason,
  buildHandoffMessage,
  parseTeammateRegistry,
  type Teammate,
} from './registry.js';

const REGISTRY: Teammate[] = [
  { name: 'rocksteady', channelId: 'chan-rocksteady' },
  { name: 'april', channelId: 'chan-april' },
  { name: 'krang', channelId: 'chan-krang' },
];

const SHARED = 'chan-ai-work';
const THREAD = 'thread-42';

function route(name: string, presentHere: string[], channelId = SHARED, threadId = THREAD) {
  return resolveTeammateRoute(name, {
    registry: REGISTRY,
    presentHere,
    currentChannelId: channelId,
    currentThreadId: threadId,
  });
}

describe('findTeammate', () => {
  it('matches ignoring @ and case', () => {
    expect(findTeammate(REGISTRY, '@Rocksteady')?.channelId).toBe('chan-rocksteady');
    expect(findTeammate(REGISTRY, 'APRIL')?.channelId).toBe('chan-april');
  });

  it('returns undefined for strangers and blanks', () => {
    expect(findTeammate(REGISTRY, 'nobody')).toBeUndefined();
    expect(findTeammate(REGISTRY, '  ')).toBeUndefined();
  });
});

describe('resolveTeammateRoute', () => {
  /** The whole point: one task, one thread. */
  it('routes a teammate who listens here into THIS thread', () => {
    const r = route('rocksteady', ['rocksteady', 'april', 'krang']);
    expect(r?.kind).toBe('thread');
    expect(r?.target).toEqual({ channelId: SHARED, rootId: THREAD });
  });

  /**
   * The inconsistency this replaces: docs-ping hardcoded "April's channel", so
   * she was pinged in her own channel even when she was sitting in the very
   * thread the work was happening in. Same rule for everyone now.
   */
  it('routes april into this thread too when she listens here', () => {
    expect(route('april', ['rocksteady', 'april'])?.kind).toBe('thread');
  });

  /**
   * There is no channel route any more. Posting into a teammate's channel opened
   * a SECOND thread for a conversation that already had one, and the two halves
   * drifted apart — krang did exactly that to rocksteady on 2026-07-29, after
   * having already reached him correctly in the shared thread.
   */
  it('refuses rather than falling back to their own channel', () => {
    expect(route('krang', ['rocksteady'])).toBeNull();
    expect(unreachableReason('krang', { registry: REGISTRY, presentHere: ['rocksteady'] }))
      .toBe('not-here');
  });

  it('refuses from a session whose channel nobody else works in', () => {
    expect(route('april', [], 'chan-bebop', 'thread-personal')).toBeNull();
  });

  // Channel-level context: posting there is precisely what we refuse to do.
  it('refuses when there is no thread to land in', () => {
    expect(route('rocksteady', ['rocksteady'], SHARED, '')).toBeNull();
  });

  it('returns null for an unknown name so the caller can say so', () => {
    expect(route('shredder', ['rocksteady'])).toBeNull();
    expect(unreachableReason('shredder', { registry: REGISTRY, presentHere: ['rocksteady'] }))
      .toBe('unknown');
  });

  it('tolerates @ and case in the presentHere list', () => {
    expect(route('rocksteady', ['@RockSteady'])?.kind).toBe('thread');
  });
});

describe('buildHandoffMessage', () => {
  /**
   * Mention plus text, nothing else. A backlink would point at the thread we are
   * already posting into, which reads as the counterpart's thread and sends the
   * reply into a dead end — the exact drift the require-thread-link hook existed
   * to catch, and now structurally impossible.
   */
  it('is the mention and the text, with no backlink', () => {
    const r = route('rocksteady', ['rocksteady'])!;
    const msg = buildHandoffMessage(r, 'посмотри MR 42');

    expect(msg).toBe('@rocksteady посмотри MR 42');
    expect(msg).not.toContain('тред');
    expect(msg).not.toContain('reply-to');
  });
});

describe('parseTeammateRegistry', () => {
  it('parses a well-formed list', () => {
    expect(parseTeammateRegistry('[{"name":"april","channelId":"c1"}]'))
      .toEqual([{ name: 'april', channelId: 'c1' }]);
  });

  it('drops incomplete entries instead of failing whole', () => {
    expect(parseTeammateRegistry('[{"name":"a"},{"channelId":"c"},{"name":"ok","channelId":"c2"}]'))
      .toEqual([{ name: 'ok', channelId: 'c2' }]);
  });

  it('returns empty for junk, empty and missing input', () => {
    expect(parseTeammateRegistry('not json')).toEqual([]);
    expect(parseTeammateRegistry('{"name":"a"}')).toEqual([]);
    expect(parseTeammateRegistry('')).toEqual([]);
    expect(parseTeammateRegistry(undefined)).toEqual([]);
  });
});
