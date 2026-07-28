/**
 * Tests for review-ping — the bot asks the reviewer when a session opens an MR.
 *
 * The behaviour under test is exactly the gap that made a docs bot open an MR,
 * notice GitLab wanted an approver, say so, and ask nobody: nothing in code
 * requested the review.
 */

import { describe, it, expect, mock } from 'bun:test';
import { onTurnComplete, cancelReviewPing } from './handler.js';
import type { Session } from '../../session/types.js';
import type { SessionContext } from '../session-context/index.js';
import type { DeliveryTarget } from '../../platform/types.js';

const QUIET_MS = 5;
const MR = 'https://gitlab.corp/group/proj/-/merge_requests/149';

interface Spies {
  delivered: Array<{ target: DeliveryTarget; message: string }>;
  ownThreadPosts: string[];
}

function makeSpies(): Spies {
  return { delivered: [], ownThreadPosts: [] };
}

function makeSession(
  spies: Spies,
  overrides: Partial<Session> = {},
  mcp: Record<string, unknown> = {},
  botName = 'bebop',
): Session {
  return {
    sessionId: 'mm:thread-1',
    threadId: 'thread-1',
    platformId: 'mm',
    startedBy: 'alice',
    isProcessing: false,
    pullRequestUrl: MR,
    platform: {
      platformId: 'mm',
      getBotName: () => botName,
      getThreadLink: (id: string) => `https://chat.corp/_redirect/pl/${id}`,
      getMcpConfig: () => ({ channelId: 'chan-bebop', ...mcp }),
      createPost: mock(async (message: string) => {
        spies.ownThreadPosts.push(message);
        return { id: 'p1', message };
      }),
      getFormatter: () => ({
        formatBold: (t: string) => `**${t}**`,
        formatItalic: (t: string) => `_${t}_`,
        formatCode: (t: string) => `\`${t}\``,
      }),
      deliverToThread: mock(async (target: DeliveryTarget, message: string) => {
        spies.delivered.push({ target, message });
        return { id: 'd1', message };
      }),
    } as unknown as Session['platform'],
    ...overrides,
  } as unknown as Session;
}

function makeCtx(session: Session, enabled = true, botName = 'rocksteady'): SessionContext {
  return {
    config: {
      reviewPing: {
        enabled,
        channelId: 'chan-rocksteady',
        botName,
        quiescenceMs: QUIET_MS,
      },
    },
    state: { sessions: new Map([[session.sessionId, session]]) },
    ops: { persistSession: mock(() => {}) },
  } as unknown as SessionContext;
}

const settle = () => new Promise((r) => setTimeout(r, QUIET_MS + 20));

describe('review-ping', () => {
  it('asks the reviewer once the session goes quiet after opening an MR', async () => {
    const spies = makeSpies();
    const session = makeSession(spies);
    onTurnComplete(session, makeCtx(session));
    await settle();

    expect(spies.delivered).toHaveLength(1);
    // Must mention the reviewer — their bot wakes on nothing else — and carry
    // the MR so they don't have to go hunting for it.
    expect(spies.delivered[0].message).toContain('@rocksteady');
    expect(spies.delivered[0].message).toContain(MR);
    // Routed to the reviewer's channel: they don't hold a session here.
    expect(spies.delivered[0].target.channelId).toBe('chan-rocksteady');
  });

  it('does not ask twice for the same MR', async () => {
    const spies = makeSpies();
    const session = makeSession(spies);
    const ctx = makeCtx(session);
    onTurnComplete(session, ctx);
    await settle();
    onTurnComplete(session, ctx);
    await settle();

    expect(spies.delivered).toHaveLength(1);
  });

  it('stays silent when no MR was opened', async () => {
    const spies = makeSpies();
    const session = makeSession(spies, { pullRequestUrl: undefined });
    onTurnComplete(session, makeCtx(session));
    await settle();

    expect(spies.delivered).toHaveLength(0);
  });

  /**
   * The reviewer opening an MR of their own must not ask themselves. Guarded by
   * name and by channel, since a renamed bot still lives in the same channel.
   */
  it('never asks itself', async () => {
    const spies = makeSpies();
    const session = makeSession(spies, {}, {}, 'rocksteady');
    onTurnComplete(session, makeCtx(session));
    await settle();

    expect(spies.delivered).toHaveLength(0);
  });

  it('asks in this thread when the reviewer works in this channel', async () => {
    const spies = makeSpies();
    const session = makeSession(spies, {}, {
      channelId: 'shared',
      teammates: [{ name: 'rocksteady', channelId: 'chan-rocksteady' }],
      teammatesPresent: ['rocksteady'],
    });
    onTurnComplete(session, makeCtx(session));
    await settle();

    expect(spies.delivered).toHaveLength(1);
    expect(spies.delivered[0].target.rootId).toBe('thread-1');
    expect(spies.delivered[0].target.channelId).toBe('shared');
  });

  it('does nothing while the agent is still working', async () => {
    const spies = makeSpies();
    const session = makeSession(spies, { isProcessing: true });
    onTurnComplete(session, makeCtx(session));
    await settle();

    expect(spies.delivered).toHaveLength(0);
  });

  it('is disabled by config', async () => {
    const spies = makeSpies();
    const session = makeSession(spies);
    onTurnComplete(session, makeCtx(session, false));
    await settle();

    expect(spies.delivered).toHaveLength(0);
  });

  it('cancelReviewPing stops a pending ask', async () => {
    const spies = makeSpies();
    const session = makeSession(spies);
    onTurnComplete(session, makeCtx(session));
    cancelReviewPing(session);
    await settle();

    expect(spies.delivered).toHaveLength(0);
  });
});
