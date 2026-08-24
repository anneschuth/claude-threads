/**
 * Gating matrix for agent-initiated feature actions. These tests drive the
 * REAL handleAgentAction — every refusal asserted here is the authoritative
 * bot-side gate (the MCP child's env gates are advisory only), so a gate
 * that stops gating fails these tests.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { handleAgentAction, AGENT_MEMORY_WRITES_PER_SESSION } from './handler.js';
import type { Session } from '../../session/types.js';
import type { SessionContext } from '../session-context/index.js';
import type { AgentAction } from '../../mcp/decision-bridge.js';
import { createMockFormatter } from '../../test-utils/mock-formatter.js';

const NO_SIGNAL = new AbortController().signal;

function makeSession(overrides: Partial<Session> = {}): Session {
  const posts: string[] = [];
  const session = {
    platformId: 'mm',
    threadId: 'thread-1',
    sessionId: 'mm:thread-1',
    startedBy: 'anne',
    platform: {
      getFormatter: () => createMockFormatter(),
      createPost: mock(async (message: string) => {
        posts.push(message);
        return { id: `post_${posts.length}`, platformId: 'mm', channelId: 'c', userId: 'bot', message, createAt: Date.now() };
      }),
      createInteractivePost: mock(async (message: string) => {
        posts.push(message);
        return { id: `card_${posts.length}`, platformId: 'mm', channelId: 'c', userId: 'bot', message, createAt: Date.now() };
      }),
    },
    messageManager: {
      setPendingRoutinePrompt: mock(() => {}),
      setPendingWatchPrompt: mock(() => {}),
    },
    ...overrides,
  } as unknown as Session;
  (session as unknown as { _posts: string[] })._posts = posts;
  return session;
}

function postsOf(session: Session): string[] {
  return (session as unknown as { _posts: string[] })._posts;
}

function makeCtx(overrides: {
  memoryEnabled?: boolean;
  routinesEnabled?: boolean;
  watchesEnabled?: boolean;
  addResult?: { added: unknown[]; duplicates: string[]; superseded: unknown[] };
  entries?: unknown[];
  routines?: unknown[];
  watches?: unknown[];
} = {}): SessionContext {
  return {
    state: {
      memoryStore: {
        addChannelEntries: mock(async () => overrides.addResult ?? {
          added: [{ text: 'x' }], duplicates: [], superseded: [],
        }),
        listChannelEntries: mock(() => overrides.entries ?? []),
      },
      routinesStore: { list: mock(() => overrides.routines ?? []) },
      watchesStore: { list: mock(() => overrides.watches ?? []) },
    },
    ops: {
      getPlatformMemoryConfig: mock(() => ({
        enabled: overrides.memoryEnabled ?? true,
        repoLayer: true,
        channelLayer: overrides.memoryEnabled ?? true,
        distillation: true,
      })),
      isRoutinesEnabled: mock(() => overrides.routinesEnabled ?? true),
      isWatchesEnabled: mock(() => overrides.watchesEnabled ?? true),
      registerPost: mock(() => {}),
    },
  } as unknown as SessionContext;
}

function act(action: AgentAction, input: Record<string, unknown> = {}) {
  return { kind: 'agent_action' as const, action, input };
}

const VALID_ROUTINE = {
  name: 'Daily standup',
  prompt: 'post a standup summary',
  schedule: { preset: 'daily', time: '09:00', timezone: 'Europe/Amsterdam' },
};

const VALID_WATCH = {
  name: 'Incident triage',
  condition: 'someone reports a production incident',
  prompt: 'triage it',
  keywords: ['incident', 'outage'],
};

describe('handleAgentAction — remember_fact', () => {
  test('refuses when channel memory is disabled (authoritative bot-side gate)', async () => {
    const session = makeSession();
    const ctx = makeCtx({ memoryEnabled: false });
    const res = await handleAgentAction(session, ctx, act('remember_fact', { text: 'a fact' }), NO_SIGNAL);
    expect(res.ok).toBe(false);
    expect(ctx.state.memoryStore.addChannelEntries).not.toHaveBeenCalled();
  });

  test('saves with source agent, posts a visibility message, reports remaining writes', async () => {
    const session = makeSession();
    const ctx = makeCtx();
    const res = await handleAgentAction(session, ctx, act('remember_fact', { text: 'deploys happen on Fridays' }), NO_SIGNAL);
    expect(res.ok).toBe(true);
    expect((res.result as { status: string }).status).toBe('saved');
    expect(ctx.state.memoryStore.addChannelEntries).toHaveBeenCalledWith('mm', [
      { text: 'deploys happen on Fridays', source: 'agent' },
    ]);
    // The visibility post replaces a human gate — it must exist and name the undo path.
    const visible = postsOf(session).join('\n');
    expect(visible).toContain('saved a channel memory');
    expect(visible).toContain('!memory forget');
  });

  test('a duplicate is reported without a visibility post', async () => {
    const session = makeSession();
    const ctx = makeCtx({ addResult: { added: [], duplicates: ['deploys happen on Fridays'], superseded: [] } });
    const res = await handleAgentAction(session, ctx, act('remember_fact', { text: 'deploys happen on Fridays' }), NO_SIGNAL);
    expect(res.ok).toBe(true);
    expect((res.result as { status: string }).status).toBe('duplicate');
    expect(postsOf(session)).toHaveLength(0);
  });

  test('enforces the per-session write cap', async () => {
    const session = makeSession({ agentMemoryWrites: AGENT_MEMORY_WRITES_PER_SESSION });
    const ctx = makeCtx();
    const res = await handleAgentAction(session, ctx, act('remember_fact', { text: 'one more' }), NO_SIGNAL);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('cap');
    expect(ctx.state.memoryStore.addChannelEntries).not.toHaveBeenCalled();
  });

  test('refuses empty or non-string text', async () => {
    const session = makeSession();
    const ctx = makeCtx();
    expect((await handleAgentAction(session, ctx, act('remember_fact', { text: '   ' }), NO_SIGNAL)).ok).toBe(false);
    expect((await handleAgentAction(session, ctx, act('remember_fact', { text: 42 }), NO_SIGNAL)).ok).toBe(false);
    expect(ctx.state.memoryStore.addChannelEntries).not.toHaveBeenCalled();
  });
});

describe('handleAgentAction — propose_routine / propose_watch', () => {
  let session: Session;
  let ctx: SessionContext;

  beforeEach(() => {
    session = makeSession();
    ctx = makeCtx();
  });

  test('a valid routine proposal posts the card and parks the pending prompt — saves NOTHING', async () => {
    const res = await handleAgentAction(session, ctx, act('propose_routine', VALID_ROUTINE), NO_SIGNAL);
    expect(res.ok).toBe(true);
    expect((res.result as { status: string }).status).toBe('proposed_awaiting_human_approval');

    const mm = session.messageManager as unknown as { setPendingRoutinePrompt: ReturnType<typeof mock> };
    expect(mm.setPendingRoutinePrompt).toHaveBeenCalledTimes(1);
    const pending = mm.setPendingRoutinePrompt.mock.calls[0][0] as {
      requestedBy: string; proposedByAgent?: boolean; parsed: { name: string };
    };
    // createdBy-on-approval must be the session owner: per-fire
    // re-authorization depends on it being a real platform user.
    expect(pending.requestedBy).toBe('anne');
    expect(pending.proposedByAgent).toBe(true);
    expect(pending.parsed.name).toBe('Daily standup');
    // The card names the agent as proposer so approvers scrutinize harder.
    expect(postsOf(session).join('\n')).toContain('Claude proposes routine');
  });

  test('an UNATTENDED session may not propose (self-replication gate)', async () => {
    session = makeSession({ unattended: true });
    for (const [action, input] of [['propose_routine', VALID_ROUTINE], ['propose_watch', VALID_WATCH]] as const) {
      const res = await handleAgentAction(session, ctx, act(action, input), NO_SIGNAL);
      expect(res.ok).toBe(false);
      expect(res.reason).toContain('unattended');
    }
    const mm = session.messageManager as unknown as { setPendingRoutinePrompt: ReturnType<typeof mock>; setPendingWatchPrompt: ReturnType<typeof mock> };
    expect(mm.setPendingRoutinePrompt).not.toHaveBeenCalled();
    expect(mm.setPendingWatchPrompt).not.toHaveBeenCalled();
  });

  test('refused in direct channel mode', async () => {
    session = makeSession({ threadId: 'dcm:mm', sessionId: 'mm:dcm:mm' });
    const res = await handleAgentAction(session, ctx, act('propose_routine', VALID_ROUTINE), NO_SIGNAL);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('direct channel mode');
  });

  test('refused when the feature is disabled for the platform', async () => {
    ctx = makeCtx({ routinesEnabled: false, watchesEnabled: false });
    expect((await handleAgentAction(session, ctx, act('propose_routine', VALID_ROUTINE), NO_SIGNAL)).ok).toBe(false);
    expect((await handleAgentAction(session, ctx, act('propose_watch', VALID_WATCH), NO_SIGNAL)).ok).toBe(false);
  });

  test('an invalid schedule is refused before any card is posted', async () => {
    const res = await handleAgentAction(session, ctx, act('propose_routine', {
      ...VALID_ROUTINE,
      schedule: { preset: 'every-minute', timezone: 'Europe/Amsterdam' },
    }), NO_SIGNAL);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('invalid schedule');
    expect(postsOf(session)).toHaveLength(0);
  });

  test('a missing timezone defaults to the host timezone and validates', async () => {
    const res = await handleAgentAction(session, ctx, act('propose_routine', {
      ...VALID_ROUTINE,
      schedule: { preset: 'daily', time: '09:00' },
    }), NO_SIGNAL);
    expect(res.ok).toBe(true);
  });

  test('a valid watch proposal parks the pending prompt with normalized keywords', async () => {
    const res = await handleAgentAction(session, ctx, act('propose_watch', {
      ...VALID_WATCH,
      keywords: ['Incident', 'OUTAGE', 'incident'],
    }), NO_SIGNAL);
    expect(res.ok).toBe(true);
    const mm = session.messageManager as unknown as { setPendingWatchPrompt: ReturnType<typeof mock> };
    const pending = mm.setPendingWatchPrompt.mock.calls[0][0] as { parsed: { keywords: string[] }; proposedByAgent?: boolean };
    expect(pending.parsed.keywords).toEqual(['incident', 'outage']);
    expect(pending.proposedByAgent).toBe(true);
  });

  test('unusable keywords are refused', async () => {
    const res = await handleAgentAction(session, ctx, act('propose_watch', { ...VALID_WATCH, keywords: [] }), NO_SIGNAL);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('keyword');
  });

  test('an aborted bridge call posts no orphan card', async () => {
    const aborter = new AbortController();
    aborter.abort();
    const res = await handleAgentAction(session, ctx, act('propose_routine', VALID_ROUTINE), aborter.signal);
    expect(res.ok).toBe(false);
    expect(postsOf(session)).toHaveLength(0);
  });
});

describe('handleAgentAction — listings and safety', () => {
  test('list_memory maps entries with provenance', async () => {
    const session = makeSession();
    const ctx = makeCtx({
      entries: [
        { text: 'fact a', addedAt: '2026-08-01', source: 'user', addedBy: 'anne' },
        { text: 'fact b', addedAt: '2026-08-02', source: 'agent' },
      ],
    });
    const res = await handleAgentAction(session, ctx, act('list_memory'), NO_SIGNAL);
    expect(res.ok).toBe(true);
    const { entries } = res.result as { entries: { source: string; text: string }[] };
    expect(entries.map((e) => e.source)).toEqual(['@anne', 'agent']);
  });

  test('list_routines / list_watches summarize the stores', async () => {
    const session = makeSession();
    const ctx = makeCtx({
      routines: [{ name: 'r1', schedule: { preset: 'hourly', timezone: 'UTC' }, enabled: true, createdBy: 'anne' }],
      watches: [{ name: 'w1', condition: 'x', keywords: ['x'], enabled: false, createdBy: 'anne' }],
    });
    const routines = await handleAgentAction(session, ctx, act('list_routines'), NO_SIGNAL);
    expect((routines.result as { routines: { name: string }[] }).routines[0].name).toBe('r1');
    const watches = await handleAgentAction(session, ctx, act('list_watches'), NO_SIGNAL);
    expect((watches.result as { watches: { enabled: boolean }[] }).watches[0].enabled).toBe(false);
  });

  test('an unknown action is refused, not thrown', async () => {
    const res = await handleAgentAction(makeSession(), makeCtx(), act('drop_tables' as AgentAction), NO_SIGNAL);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('unknown agent action');
  });

  test('a handler exception degrades to ok:false (never rejects across the bridge)', async () => {
    const session = makeSession();
    const ctx = makeCtx();
    (ctx.state.memoryStore.addChannelEntries as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new Error('disk on fire');
    });
    const res = await handleAgentAction(session, ctx, act('remember_fact', { text: 'x' }), NO_SIGNAL);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('disk on fire');
  });
});
