import { describe, it, expect } from 'bun:test';
import {
  findTeammate,
  resolveTeammateRoute,
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

  it('falls back to their own channel when they do not listen here', () => {
    const r = route('krang', ['rocksteady']);
    expect(r?.kind).toBe('channel');
    expect(r?.target).toEqual({ channelId: 'chan-krang', rootId: '' });
  });

  it('uses their channel from a personal-channel session (nobody else present)', () => {
    const r = route('april', [], 'chan-bebop', 'thread-personal');
    expect(r?.kind).toBe('channel');
    expect(r?.target.channelId).toBe('chan-april');
  });

  // Posting "in this channel" with no thread would open a thread the teammate
  // can't tie back to anything.
  it('does not claim same-thread without a thread to reply in', () => {
    expect(route('rocksteady', ['rocksteady'], SHARED, '')?.kind).toBe('channel');
  });

  it('returns null for an unknown name so the caller can say so', () => {
    expect(route('shredder', ['rocksteady'])).toBeNull();
  });

  it('tolerates @ and case in the presentHere list', () => {
    expect(route('rocksteady', ['@RockSteady'])?.kind).toBe('thread');
  });
});

describe('buildHandoffMessage', () => {
  const link = 'https://chat.corp/_redirect/pl/thread-42';

  it('adds a backlink for a cold channel contact', () => {
    const r = route('krang', [])!;
    const msg = buildHandoffMessage(r, 'глянь поды', link);
    expect(msg.startsWith('@krang глянь поды')).toBe(true);
    expect(msg).toContain(`reply-to: ${link}`);
  });

  /**
   * A backlink to the thread you're posting into reads as the counterpart's
   * thread — the reply lands in a dead end. This is the exact drift the
   * require-thread-link hook was written to catch.
   */
  it('omits the backlink for an in-thread handoff', () => {
    const r = route('rocksteady', ['rocksteady'])!;
    const msg = buildHandoffMessage(r, 'посмотри MR 42', link);
    expect(msg).toBe('@rocksteady посмотри MR 42');
    expect(msg).not.toContain('тред');
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

// Review finding: a platform whose permalink the MCP child can't build passes an
// empty link, and the message ended with a dangling "Отвечай мне в тред: ".
describe('buildHandoffMessage — no link available', () => {
  it('omits the directive entirely rather than emitting a dangling label', () => {
    const r = resolveTeammateRoute('krang', {
      registry: REGISTRY, presentHere: [], currentChannelId: SHARED, currentThreadId: THREAD,
    })!;
    const msg = buildHandoffMessage(r, 'глянь поды', '');

    expect(msg).toBe('@krang глянь поды');
    expect(msg).not.toContain('reply-to:');
    expect(msg).not.toMatch(/:\s*$/);
  });
});
