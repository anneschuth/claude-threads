/**
 * Tests for return-address delivery.
 *
 * No LLM is involved — everything here is deterministic code, which is the
 * whole point of the feature. The platform client is faked so we can assert
 * exactly what got posted where.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';

import {
  captureReturnAddress,
  noteEvent,
  onTurnComplete,
  cancelReturnDelivery,
  getReturnDeliveryState,
  deliveryPending,
  buildDeliveryMessage,
  noteTeammateRequest,
  MAX_DELIVERY_ATTEMPTS,
} from './handler.js';
import { createReturnDeliveryState, type ReturnAddress } from './types.js';

import type { Session } from '../../session/types.js';
import type { SessionContext } from '../session-context/index.js';
import type { DeliveryTarget, PlatformPost } from '../../platform/types.js';

/** Tiny quiescence so the suite runs in milliseconds, not minutes. */
const QUIET_MS = 30;

const PL = 'https://chat.corp/_redirect/pl/rootpost1';
const TARGET: DeliveryTarget = { channelId: 'chan-bebop', rootId: 'rootpost1' };

interface Spies {
  ownThreadPosts: string[];
  delivered: Array<{ target: DeliveryTarget; message: string }>;
  persisted: number;
  resolveResult: DeliveryTarget | null;
  deliverError: Error | null;
}

function makeSession(spies: Spies, overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'mm:thread-1',
    threadId: 'thread-1',
    platformId: 'mm',
    startedBy: 'alice',
    isProcessing: false,
    platform: {
      platformId: 'mm',
      getThreadLink: (id: string) => `https://chat.corp/_redirect/pl/${id}`,
      createPost: mock(async (message: string) => {
        spies.ownThreadPosts.push(message);
        return { id: 'p1', message } as unknown as PlatformPost;
      }),
      getFormatter: () => ({
        formatBold: (t: string) => `**${t}**`,
        formatItalic: (t: string) => `_${t}_`,
        formatCode: (t: string) => `\`${t}\``,
      }),
      resolveDeliveryTarget: mock(async (_url: string) => spies.resolveResult),
      deliverToThread: mock(async (target: DeliveryTarget, message: string) => {
        if (spies.deliverError) throw spies.deliverError;
        spies.delivered.push({ target, message });
        return { id: 'delivered-1', message } as unknown as PlatformPost;
      }),
    } as unknown as Session['platform'],
    ...overrides,
  } as unknown as Session;
}

function makeCtx(spies: Spies, enabled = true, sessions: Session[] = []): SessionContext {
  const registry = new Map<string, Session>();
  for (const s of sessions) registry.set(s.sessionId, s);
  return {
    config: { returnDeliveryEnabled: enabled, returnDeliveryQuiescenceMs: QUIET_MS },
    state: { sessions: registry },
    ops: {
      persistSession: mock(() => {
        spies.persisted++;
      }),
    },
  } as unknown as SessionContext;
}

function address(overrides: Partial<ReturnAddress> = {}): ReturnAddress {
  return { target: TARGET, requester: 'bebop', permalink: PL, ...overrides };
}

let spies: Spies;
beforeEach(() => {
  spies = {
    ownThreadPosts: [],
    delivered: [],
    persisted: 0,
    resolveResult: TARGET,
    deliverError: null,
  };
});

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

describe('captureReturnAddress', () => {
  it('stores the resolved address from a handoff message', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, true, [session]);

    await captureReturnAddress(session, `@rocksteady сделай ревью. Отвечай мне в тред: ${PL}`, 'bebop', ctx);

    const state = getReturnDeliveryState(session);
    expect(state.address?.target).toEqual(TARGET);
    expect(state.address?.requester).toBe('bebop');
    expect(spies.persisted).toBe(1);
  });

  it('ignores a message with no directive', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, true, [session]);

    await captureReturnAddress(session, `почини баг, контекст тут: ${PL}`, 'bebop', ctx);

    expect(getReturnDeliveryState(session).address).toBeUndefined();
  });

  // Without this guard the bot answers its own thread with its own answer.
  it('refuses an address that points at our own thread', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, true, [session]);
    spies.resolveResult = { channelId: 'chan-me', rootId: 'thread-1' };

    await captureReturnAddress(session, `отвечай мне в тред: ${PL}`, 'bebop', ctx);

    expect(getReturnDeliveryState(session).address).toBeUndefined();
  });

  it('does nothing when the permalink does not resolve', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, true, [session]);
    spies.resolveResult = null;

    await captureReturnAddress(session, `отвечай мне в тред: ${PL}`, 'bebop', ctx);

    expect(getReturnDeliveryState(session).address).toBeUndefined();
  });

  it('does nothing when disabled', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, false, [session]);

    await captureReturnAddress(session, `отвечай мне в тред: ${PL}`, 'bebop', ctx);

    expect(getReturnDeliveryState(session).address).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Event bookkeeping
// ---------------------------------------------------------------------------

describe('noteEvent', () => {
  /**
   * A review's verdict, findings and file list arrive as separate assistant
   * messages. Keeping only the last one delivered a fragment — bebop got the
   * tail of rocksteady's review and could not fetch the rest.
   */
  it('keeps every assistant message since the last tool call', () => {
    const session = makeSession(spies);

    noteEvent(session, { type: 'assistant', message: { content: [{ type: 'text', text: '## Review Summary' }] } });
    noteEvent(session, { type: 'assistant', message: { content: [{ type: 'text', text: 'MUST FIX: renderCard.ts:98' }] } });
    noteEvent(session, { type: 'assistant', message: { content: [{ type: 'text', text: 'VERDICT: FAIL' }] } });

    expect(getReturnDeliveryState(session).lastFinalText).toBe(
      '## Review Summary\n\nMUST FIX: renderCard.ts:98\n\nVERDICT: FAIL'
    );
  });

  it('drops commentary made before a tool call', () => {
    const session = makeSession(spies);

    noteEvent(session, { type: 'assistant', message: { content: [{ type: 'text', text: 'смотрю код...' }] } });
    noteEvent(session, { type: 'tool_use', tool_use: { id: 't1', name: 'Read', input: {} } });
    noteEvent(session, { type: 'assistant', message: { content: [{ type: 'text', text: 'VERDICT: PASS' }] } });

    expect(getReturnDeliveryState(session).lastFinalText).toBe('VERDICT: PASS');
  });

  it('joins multiple text blocks of one message', () => {
    const session = makeSession(spies);

    noteEvent(session, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'A' }, { type: 'tool_use' }, { type: 'text', text: 'B' }] },
    });

    expect(getReturnDeliveryState(session).lastFinalText).toBe('A\n\nB');
  });

  it('stands down when the agent delivered to the target itself', () => {
    const session = makeSession(spies);
    const state = getReturnDeliveryState(session);
    state.address = address();

    noteEvent(session, {
      type: 'tool_use',
      tool_use: { id: 't1', name: 'mcp__mattermost__post_in_thread', input: { root_id: 'rootpost1', text: 'hi' } },
    });
    noteEvent(session, { type: 'tool_result', tool_result: { tool_use_id: 't1' } });

    expect(state.deliveredRootIds).toContain('rootpost1');
    expect(deliveryPending(state)).toBe(false);
  });

  it('a FAILED agent delivery does not count', () => {
    const session = makeSession(spies);
    const state = getReturnDeliveryState(session);
    state.address = address();

    noteEvent(session, {
      type: 'tool_use',
      tool_use: { id: 't1', name: 'mcp__mattermost__post_in_thread', input: { root_id: 'rootpost1' } },
    });
    noteEvent(session, { type: 'tool_result', tool_result: { tool_use_id: 't1', is_error: true } });

    expect(deliveryPending(state)).toBe(true);
  });

  it('a delivery to a DIFFERENT thread does not count', () => {
    const session = makeSession(spies);
    const state = getReturnDeliveryState(session);
    state.address = address();

    noteEvent(session, {
      type: 'tool_use',
      tool_use: { id: 't1', name: 'mcp__mattermost__post_in_thread', input: { root_id: 'some-other-thread' } },
    });
    noteEvent(session, { type: 'tool_result', tool_result: { tool_use_id: 't1' } });

    expect(deliveryPending(state)).toBe(true);
  });

  it('reads the thread id from Slack-style input keys', () => {
    const session = makeSession(spies);
    const state = getReturnDeliveryState(session);
    state.address = address();

    noteEvent(session, {
      type: 'tool_use',
      tool_use: { id: 't1', name: 'mcp__slack__send_message', input: { thread_ts: 'rootpost1' } },
    });
    noteEvent(session, { type: 'tool_result', tool_result: { tool_use_id: 't1' } });

    expect(state.deliveredRootIds).toContain('rootpost1');
  });
});

// ---------------------------------------------------------------------------
// Quiescence delivery
// ---------------------------------------------------------------------------

describe('onTurnComplete → delivery', () => {
  it('delivers the final text to the requester thread once quiet', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, true, [session]);
    const state = getReturnDeliveryState(session);
    state.address = address();
    state.lastFinalText = 'VERDICT: PASS';

    onTurnComplete(session, ctx);
    await Bun.sleep(QUIET_MS + 20);

    expect(spies.delivered).toHaveLength(1);
    expect(spies.delivered[0].target).toEqual(TARGET);
    expect(spies.delivered[0].message).toContain('@bebop');
    expect(spies.delivered[0].message).toContain('VERDICT: PASS');
    // The reply carries our own thread so the loop continues.
    expect(spies.delivered[0].message).toContain('/pl/thread-1');
    expect(state.deliveredRootIds).toContain('rootpost1');
  });

  // The whole point: many turns, ONE delivery, after the last one.
  it('re-arms on each turn so a multi-turn task delivers only once', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, true, [session]);
    const state = getReturnDeliveryState(session);
    state.address = address();
    state.lastFinalText = 'первый проход';

    onTurnComplete(session, ctx);
    await Bun.sleep(QUIET_MS * 0.6);
    state.lastFinalText = 'VERDICT: PASS';
    onTurnComplete(session, ctx);
    await Bun.sleep(QUIET_MS * 0.6);

    // First deadline has passed in wall-clock terms but was pushed out.
    expect(spies.delivered).toHaveLength(0);

    await Bun.sleep(QUIET_MS * 0.5);
    expect(spies.delivered).toHaveLength(1);
    expect(spies.delivered[0].message).toContain('VERDICT: PASS');
    expect(spies.delivered[0].message).not.toContain('первый проход');
  });

  it('does not deliver when the agent already answered the thread', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, true, [session]);
    const state = getReturnDeliveryState(session);
    state.address = address();
    state.lastFinalText = 'VERDICT: PASS';
    state.deliveredRootIds.push('rootpost1');

    onTurnComplete(session, ctx);
    await Bun.sleep(QUIET_MS + 20);

    expect(spies.delivered).toHaveLength(0);
  });

  it('does not deliver without an address', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, true, [session]);
    getReturnDeliveryState(session).lastFinalText = 'что-то';

    onTurnComplete(session, ctx);
    await Bun.sleep(QUIET_MS + 20);

    expect(spies.delivered).toHaveLength(0);
  });

  it('skips a session that was killed while the timer was pending', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, true, []); // not registered
    const state = getReturnDeliveryState(session);
    state.address = address();
    state.lastFinalText = 'VERDICT: PASS';

    onTurnComplete(session, ctx);
    await Bun.sleep(QUIET_MS + 20);

    expect(spies.delivered).toHaveLength(0);
  });

  it('cancelReturnDelivery stops a pending delivery', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, true, [session]);
    const state = getReturnDeliveryState(session);
    state.address = address();
    state.lastFinalText = 'VERDICT: PASS';

    onTurnComplete(session, ctx);
    cancelReturnDelivery(session);
    await Bun.sleep(QUIET_MS + 20);

    expect(spies.delivered).toHaveLength(0);
  });

  it('retries a failed delivery and gives up after the cap', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, true, [session]);
    const state = getReturnDeliveryState(session);
    state.address = address();
    state.lastFinalText = 'VERDICT: PASS';
    spies.deliverError = new Error('channel not found');

    onTurnComplete(session, ctx);
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
      await Bun.sleep(QUIET_MS + 20);
    }

    expect(state.attempts).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(spies.delivered).toHaveLength(0);
    expect(spies.ownThreadPosts.some((m) => m.includes('Не удалось доставить'))).toBe(true);
  });
});

describe('buildDeliveryMessage', () => {
  it('mentions the requester and links back to our thread', () => {
    const session = makeSession(spies);
    const msg = buildDeliveryMessage(session, address(), 'VERDICT: PASS');

    expect(msg.startsWith('@bebop ')).toBe(true);
    expect(msg).toContain('VERDICT: PASS');
    // A delivered ANSWER carries provenance, not an address — otherwise the
    // requester re-parses it and re-points its own return address at us.
    expect(msg).toContain('delivered-answer');
    expect(msg).toContain('https://chat.corp/_redirect/pl/thread-1');
    expect(msg).not.toContain('reply-to:');
  });
});

describe('createReturnDeliveryState', () => {
  it('restores persisted state and tolerates missing fields', () => {
    const restored = createReturnDeliveryState({
      address: address(),
      deliveredRootIds: ['x'],
      attempts: 2,
    });
    expect(restored.address?.requester).toBe('bebop');
    expect(restored.deliveredRootIds).toEqual(['x']);
    expect(restored.attempts).toBe(2);

    const empty = createReturnDeliveryState();
    expect(empty.address).toBeUndefined();
    expect(empty.deliveredRootIds).toEqual([]);
    expect(empty.attempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Hand-back to a teammate who asked us in this thread
// ---------------------------------------------------------------------------

/**
 * The teammate's bot wakes only on a mention. Two shapes, and they must not be
 * confused: in a SHARED thread the mention belongs in the answer itself (a
 * separate ping a quiescence window later read as "called nobody"); from their
 * OWN channel there is no answer of ours to ride on, so the ping stays.
 */
describe('teammate hand-back', () => {
  const KRANG = { name: 'krang', channelId: 'chan-krang' };
  const SHARED = 'chan-ai-work';

  /** Fake MessageManager: records what the answer stream was handed. */
  function makeMessageManager() {
    let armed: string | undefined;
    return {
      armAnswerMention: (m: string) => { armed = m; },
      takeAnswerMention: () => { const a = armed; armed = undefined; return a; },
      /** What ContentExecutor would do once answer text arrives. */
      simulateAnswerText: () => { armed = undefined; },
      isArmed: () => armed,
    };
  }

  function makeTeammateSession(presentHere: string[]) {
    const mm = makeMessageManager();
    const session = makeSession(spies, {
      messageManager: mm as unknown as Session['messageManager'],
    });
    (session.platform as unknown as {
      getMcpConfig: () => unknown;
    }).getMcpConfig = () => ({
      teammates: [KRANG], teammatesPresent: presentHere, channelId: SHARED,
    });
    return { session, mm };
  }

  const toolUse = { type: 'tool_use', tool_use: { id: 't1', name: 'Read', input: {} } } as never;

  it('arms the answer mention once the turn calls a tool', () => {
    const { session, mm } = makeTeammateSession(['krang']);

    noteTeammateRequest(session, 'krang');
    expect(mm.isArmed()).toBeUndefined(); // nothing done yet — nothing to announce

    noteEvent(session, toolUse);

    expect(mm.isArmed()).toBe('@krang');
    expect(getReturnDeliveryState(session).pendingHandback).toBe('krang');
  });

  /**
   * The loop breaker. Two idle bots mentioning each other ("@Bebop Жду." /
   * "@April Ждём.") burn a turn per round forever, and a rate-limited session
   * whose only output is "You've hit your session limit" would wake the other
   * side to answer nothing. A turn that called no tool wakes nobody.
   */
  it('stays silent when the turn did no work', async () => {
    const { session, mm } = makeTeammateSession(['krang']);
    const ctx = makeCtx(spies, true, [session]);

    noteTeammateRequest(session, 'krang');
    onTurnComplete(session, ctx);
    await Bun.sleep(QUIET_MS + 40);

    expect(mm.isArmed()).toBeUndefined();
    expect(spies.delivered).toHaveLength(0);
    expect(getReturnDeliveryState(session).pendingHandback).toBeUndefined();
  });

  it('arms nothing for a teammate reachable only in their own channel', () => {
    const { session, mm } = makeTeammateSession([]);

    noteTeammateRequest(session, 'krang');
    noteEvent(session, toolUse);

    expect(mm.isArmed()).toBeUndefined();
    expect(getReturnDeliveryState(session).pendingHandback).toBe('krang');
  });

  it('ignores a requester who is not a known teammate', () => {
    const { session, mm } = makeTeammateSession(['krang']);

    noteTeammateRequest(session, 'alice');
    noteEvent(session, toolUse);

    expect(mm.isArmed()).toBeUndefined();
    expect(getReturnDeliveryState(session).pendingHandback).toBeUndefined();
  });

  it('posts no separate ping once the answer carried the mention', async () => {
    const { session, mm } = makeTeammateSession(['krang']);
    const ctx = makeCtx(spies, true, [session]);

    noteTeammateRequest(session, 'krang');
    noteEvent(session, toolUse);
    mm.simulateAnswerText();
    onTurnComplete(session, ctx);
    await Bun.sleep(QUIET_MS + 40);

    expect(spies.delivered).toHaveLength(0);
    expect(getReturnDeliveryState(session).pendingHandback).toBeUndefined();
  });

  /**
   * The fallback that keeps the teammate from waiting forever: a turn that only
   * ran tools and said nothing leaves the mention unused, so it has to be
   * delivered the old way.
   */
  it('falls back to the ping when the turn worked but said nothing', async () => {
    const { session } = makeTeammateSession(['krang']);
    const ctx = makeCtx(spies, true, [session]);

    noteTeammateRequest(session, 'krang');
    noteEvent(session, toolUse);
    onTurnComplete(session, ctx);
    await Bun.sleep(QUIET_MS + 40);

    expect(spies.delivered).toHaveLength(1);
    expect(spies.delivered[0].message).toContain('@krang');
    expect(spies.delivered[0].target).toEqual({ channelId: SHARED, rootId: 'thread-1' });
  });

  it('still pings a teammate in their own channel, with a backlink', async () => {
    const { session } = makeTeammateSession([]);
    const ctx = makeCtx(spies, true, [session]);

    noteTeammateRequest(session, 'krang');
    onTurnComplete(session, ctx);
    await Bun.sleep(QUIET_MS + 40);

    expect(spies.delivered).toHaveLength(1);
    expect(spies.delivered[0].target).toEqual({ channelId: 'chan-krang', rootId: '' });
    expect(spies.delivered[0].message).toContain('reply-to: https://chat.corp/_redirect/pl/thread-1');
  });
});
