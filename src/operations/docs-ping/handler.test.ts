/**
 * Tests for the deterministic docs ping.
 *
 * `quickQuery` is mocked so the judge verdict is scripted; the trigger,
 * dedup and delivery all run through the real handler.
 */

import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';

const quickQueryCfg: { current: { success: boolean; response?: string } } = {
  current: { success: true, response: '{"needsDocs": true, "summary": "починили сохранение Icon color", "whatToCheck": "раздел Account Defaults"}' },
};
const quickQueryMock = mock(async (_opts: { prompt: string }) => ({ ...quickQueryCfg.current, durationMs: 1 }));

const realQuickQuery = await import('../../claude/quick-query.js');
mock.module('../../claude/quick-query.js', () => ({
  ...realQuickQuery,
  quickQuery: quickQueryMock,
}));

afterAll(() => {
  mock.module('../../claude/quick-query.js', () => realQuickQuery);
});

const {
  noteEvent,
  onTurnComplete,
  cancelDocsPing,
  getDocsPingState,
  resolveDocsPing,
  pingPending,
  parseDocsVerdict,
  buildDocsMessage,
} = await import('./handler.js');
const { createDocsPingState } = await import('./types.js');

import type { Session } from '../../session/types.js';
import type { SessionContext } from '../session-context/index.js';
import type { DeliveryTarget, PlatformPost } from '../../platform/types.js';

const QUIET_MS = 30;
const DOCS_CHANNEL = 'ygoqny3463n98dnbbdqecouzga';
const MR = 'https://gitlab.corp/group/repo/-/merge_requests/512';

interface Spies {
  ownThreadPosts: string[];
  delivered: Array<{ target: DeliveryTarget; message: string }>;
  persisted: number;
}

function makeSession(spies: Spies, overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'mm:thread-1',
    threadId: 'thread-1',
    platformId: 'mm',
    startedBy: 'maxk',
    isProcessing: false,
    pullRequestUrl: MR,
    firstPrompt: 'в футере емейлов не сохраняется Icon color',
    returnDelivery: { lastFinalText: 'Готово, MR 512.' } as unknown as Session['returnDelivery'],
    platform: {
      platformId: 'mm',
      getBotName: () => 'bebop',
      getMcpConfig: () => ({ channelId: 'chan-bebop' }),
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
      deliverToThread: mock(async (target: DeliveryTarget, message: string) => {
        spies.delivered.push({ target, message });
        return { id: 'd1', message } as unknown as PlatformPost;
      }),
    } as unknown as Session['platform'],
    ...overrides,
  } as unknown as Session;
}

// `null` (not undefined) means "no docsPing config at all" — passing
// undefined would trigger the default parameter and configure it.
function makeCtx(spies: Spies, session: Session, docsPing: Record<string, unknown> | null = {}): SessionContext {
  const registry = new Map<string, Session>([[session.sessionId, session]]);
  return {
    config: {
      docsPing: docsPing === null ? undefined : {
        enabled: true,
        channelId: DOCS_CHANNEL,
        botName: 'april',
        quiescenceMs: QUIET_MS,
        ...docsPing,
      },
    },
    state: { sessions: registry },
    ops: { persistSession: mock(() => { spies.persisted++; }) },
  } as unknown as SessionContext;
}

let spies: Spies;
beforeEach(() => {
  spies = { ownThreadPosts: [], delivered: [], persisted: 0 };
  quickQueryCfg.current = {
    success: true,
    response: '{"needsDocs": true, "summary": "починили сохранение Icon color", "whatToCheck": "раздел Account Defaults"}',
  };
  quickQueryMock.mockClear();
});

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

describe('resolveDocsPing', () => {
  it('resolves when enabled with a channel', () => {
    const session = makeSession(spies);
    expect(resolveDocsPing(session, makeCtx(spies, session))?.botName).toBe('april');
  });

  it('is off when disabled, unset, or missing a channel', () => {
    const session = makeSession(spies);
    expect(resolveDocsPing(session, makeCtx(spies, session, { enabled: false }))).toBeNull();
    expect(resolveDocsPing(session, makeCtx(spies, session, null))).toBeNull();
    expect(resolveDocsPing(session, makeCtx(spies, session, { channelId: '' }))).toBeNull();
  });

  // April must not ping April.
  it('is off for the docs bot own sessions — by name', () => {
    const session = makeSession(spies, {
      platform: {
        getBotName: () => 'april',
        getMcpConfig: () => ({ channelId: DOCS_CHANNEL }),
      } as unknown as Session['platform'],
    });
    expect(resolveDocsPing(session, makeCtx(spies, session))).toBeNull();
  });

  it('is off for the docs bot own sessions — by channel, even if renamed', () => {
    const session = makeSession(spies, {
      platform: {
        getBotName: () => 'renamed-docs-bot',
        getMcpConfig: () => ({ channelId: DOCS_CHANNEL }),
      } as unknown as Session['platform'],
    });
    expect(resolveDocsPing(session, makeCtx(spies, session))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

describe('pingPending', () => {
  it('requires an MR — an investigation-only session pings nobody', () => {
    const withMr = makeSession(spies);
    expect(pingPending(withMr, getDocsPingState(withMr))).toBe(true);

    const noMr = makeSession(spies, { pullRequestUrl: undefined });
    expect(pingPending(noMr, getDocsPingState(noMr))).toBe(false);
  });

  it('is false once settled or once the agent pinged', () => {
    const session = makeSession(spies);
    expect(pingPending(session, createDocsPingState({ settled: true }))).toBe(false);
    expect(pingPending(session, { ...createDocsPingState(), agentPinged: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

describe('noteEvent', () => {
  it('stands down when the agent posted to the docs channel itself', () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, session);

    noteEvent(session, {
      type: 'tool_use',
      tool_use: { id: 't1', name: 'mcp__mattermost__post_message', input: { channel_id: DOCS_CHANNEL, text: '@april ...' } },
    }, ctx);
    noteEvent(session, { type: 'tool_result', tool_result: { tool_use_id: 't1' } }, ctx);

    expect(getDocsPingState(session).agentPinged).toBe(true);
  });

  it('a failed post does not count', () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, session);

    noteEvent(session, {
      type: 'tool_use',
      tool_use: { id: 't1', name: 'mcp__mattermost__post_message', input: { channel_id: DOCS_CHANNEL } },
    }, ctx);
    noteEvent(session, { type: 'tool_result', tool_result: { tool_use_id: 't1', is_error: true } }, ctx);

    expect(getDocsPingState(session).agentPinged).toBe(false);
  });

  it('a post to another channel does not count', () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, session);

    noteEvent(session, {
      type: 'tool_use',
      tool_use: { id: 't1', name: 'mcp__mattermost__post_message', input: { channel_id: 'some-other-channel' } },
    }, ctx);
    noteEvent(session, { type: 'tool_result', tool_result: { tool_use_id: 't1' } }, ctx);

    expect(getDocsPingState(session).agentPinged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Verdict parsing
// ---------------------------------------------------------------------------

describe('parseDocsVerdict', () => {
  it('parses a positive verdict', () => {
    expect(parseDocsVerdict('{"needsDocs": true, "summary": "s", "whatToCheck": "w"}'))
      .toEqual({ needsDocs: true, summary: 's', whatToCheck: 'w' });
  });

  it('parses a negative verdict and drops its text', () => {
    expect(parseDocsVerdict('{"needsDocs": false, "summary": "x", "whatToCheck": "y"}'))
      .toEqual({ needsDocs: false, summary: '', whatToCheck: '' });
  });

  // A ping with no summary makes the docs bot dig out what happened itself.
  it('rejects a positive verdict with no summary', () => {
    expect(parseDocsVerdict('{"needsDocs": true, "summary": "  ", "whatToCheck": "w"}')).toBeNull();
  });

  it('returns null for garbage', () => {
    expect(parseDocsVerdict('nope')).toBeNull();
    expect(parseDocsVerdict('{"needsDocs": "yes"}')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

describe('onTurnComplete → ping', () => {
  it('posts to the docs channel at quiescence', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, session);

    onTurnComplete(session, ctx);
    await Bun.sleep(QUIET_MS + 40);

    expect(spies.delivered).toHaveLength(1);
    // Channel-level post: no thread root.
    expect(spies.delivered[0].target).toEqual({ channelId: DOCS_CHANNEL, rootId: '' });
    const msg = spies.delivered[0].message;
    expect(msg).toContain('@april');
    expect(msg).toContain('починили сохранение Icon color');
    expect(msg).toContain(MR);
    expect(msg).toContain('раздел Account Defaults');
    expect(msg).toContain('Отвечай мне в тред: https://chat.corp/_redirect/pl/thread-1');
    expect(getDocsPingState(session).settled).toBe(true);
  });

  it('stays silent when the judge says docs are unaffected — and does not re-judge', async () => {
    quickQueryCfg.current = { success: true, response: '{"needsDocs": false, "summary": "", "whatToCheck": ""}' };
    const session = makeSession(spies);
    const ctx = makeCtx(spies, session);

    onTurnComplete(session, ctx);
    await Bun.sleep(QUIET_MS + 40);
    onTurnComplete(session, ctx);
    await Bun.sleep(QUIET_MS + 40);

    expect(spies.delivered).toHaveLength(0);
    expect(quickQueryMock).toHaveBeenCalledTimes(1);
  });

  it('does not fire without an MR', async () => {
    const session = makeSession(spies, { pullRequestUrl: undefined });
    const ctx = makeCtx(spies, session);

    onTurnComplete(session, ctx);
    await Bun.sleep(QUIET_MS + 40);

    expect(spies.delivered).toHaveLength(0);
    expect(quickQueryMock).not.toHaveBeenCalled();
  });

  it('does not fire when the agent already pinged', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, session);
    getDocsPingState(session).agentPinged = true;

    onTurnComplete(session, ctx);
    await Bun.sleep(QUIET_MS + 40);

    expect(spies.delivered).toHaveLength(0);
  });

  it('re-arms across turns so a long task pings once, at the end', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, session);

    onTurnComplete(session, ctx);
    await Bun.sleep(QUIET_MS * 0.6);
    onTurnComplete(session, ctx);
    await Bun.sleep(QUIET_MS * 0.6);
    expect(spies.delivered).toHaveLength(0);

    await Bun.sleep(QUIET_MS);
    expect(spies.delivered).toHaveLength(1);
  });

  it('skips a killed session', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, session);
    onTurnComplete(session, ctx);
    (ctx.state.sessions as Map<string, Session>).delete(session.sessionId);

    await Bun.sleep(QUIET_MS + 40);

    expect(spies.delivered).toHaveLength(0);
  });

  it('cancelDocsPing stops a pending ping', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, session);

    onTurnComplete(session, ctx);
    cancelDocsPing(session);
    await Bun.sleep(QUIET_MS + 40);

    expect(spies.delivered).toHaveLength(0);
  });

  // An unusable verdict must not burn the session's one chance.
  it('leaves the ping pending when the judge fails', async () => {
    quickQueryCfg.current = { success: false };
    const session = makeSession(spies);
    const ctx = makeCtx(spies, session);

    onTurnComplete(session, ctx);
    await Bun.sleep(QUIET_MS + 40);

    expect(spies.delivered).toHaveLength(0);
    expect(getDocsPingState(session).settled).toBe(false);
    expect(pingPending(session, getDocsPingState(session))).toBe(true);
  });
});

describe('buildDocsMessage', () => {
  it('omits the what-to-check line when empty', () => {
    const session = makeSession(spies);
    const cfg = resolveDocsPing(session, makeCtx(spies, session))!;
    const msg = buildDocsMessage(session, cfg, { needsDocs: true, summary: 's', whatToCheck: '' }, MR);

    expect(msg).toContain('@april s');
    expect(msg).toContain(`MR: ${MR}`);
    expect(msg).not.toContain('Что проверить');
  });
});
