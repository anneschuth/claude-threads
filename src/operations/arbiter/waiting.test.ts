/**
 * Tests for the arbiter's human-wait watchdog.
 *
 * `quickQuery` is mocked so the judge's verdict is scripted; everything else
 * runs through the real handler code.
 */

import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';

const quickQueryCfg: { current: { success: boolean; response?: string } } = {
  current: { success: true, response: '{"decide": false, "reason": "нужен человек"}' },
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
  noteWaiting,
  cancelWaiting,
  detectPendingPrompt,
  stillWaitingOnSame,
  parseJudgeVerdict,
  escalationTargets,
  resolvePolicy,
  DEFAULT_WAIT_TIMEOUT_MS,
  DEFAULT_MAX_ESCALATIONS,
} = await import('./waiting.js');
const { getArbiterState } = await import('./handler.js');

import type { Session } from '../../session/types.js';
import type { SessionContext } from '../session-context/index.js';

/** Tiny timings so the suite runs in milliseconds. */
const WAIT_MS = 25;

interface Spies {
  posts: string[];
  answered: Array<{ postId: string; optionIndex: number }>;
  approvals: Array<{ postId: string; approved: boolean }>;
  sentToAgent: string[];
}

const QUESTION_SET = {
  toolUseId: 'tu-1',
  currentIndex: 0,
  currentPostId: 'post-q1',
  questions: [
    {
      header: 'Ревью',
      question: 'Кинуть @Rocksteady на ревью?',
      options: [
        { label: 'Да, кинуть', description: 'отправить MR на ревью' },
        { label: 'Нет', description: 'оставить как есть' },
      ],
      answer: null,
    },
  ],
};

function makeSession(spies: Spies, overrides: Partial<Session> = {}): Session {
  const mm = {
    getPendingQuestionSet: () => null,
    getPendingApproval: () => null,
    handleQuestionAnswer: mock(async (postId: string, optionIndex: number) => {
      spies.answered.push({ postId, optionIndex });
      return true;
    }),
    handleApprovalResponse: mock(async (postId: string, approved: boolean) => {
      spies.approvals.push({ postId, approved });
      return true;
    }),
  };
  return {
    sessionId: 'mm:thread-1',
    threadId: 'thread-1',
    platformId: 'mm',
    startedBy: 'bebop',
    messageCount: 1,
    isProcessing: false,
    firstPrompt: 'почини сохранение Icon color в футере писем',
    platform: {
      createPost: mock(async (message: string) => {
        spies.posts.push(message);
        return { id: 'p', message };
      }),
      getFormatter: () => ({
        formatBold: (t: string) => `**${t}**`,
        formatItalic: (t: string) => `_${t}_`,
        formatCode: (t: string) => `\`${t}\``,
      }),
    } as unknown as Session['platform'],
    claude: {
      isRunning: () => true,
      sendMessage: mock((m: string) => {
        spies.sentToAgent.push(m);
      }),
    } as unknown as Session['claude'],
    messageManager: mm as unknown as Session['messageManager'],
    ...overrides,
  } as unknown as Session;
}

function makeCtx(spies: Spies, session: Session, policy: Record<string, unknown> = {}): SessionContext {
  const registry = new Map<string, Session>([[session.sessionId, session]]);
  return {
    config: {
      arbiterEnabled: true,
      arbiterPolicy: {
        waitTimeoutMs: WAIT_MS,
        escalateIntervalMs: WAIT_MS,
        ...policy,
      },
    },
    state: { sessions: registry },
    ops: {
      persistSession: mock(() => {}),
      startTyping: mock(() => {}),
    },
  } as unknown as SessionContext;
}

/** Point the session's messageManager at a pending question. */
function withQuestion(session: Session): void {
  (session.messageManager as unknown as { getPendingQuestionSet: () => unknown }).getPendingQuestionSet =
    () => QUESTION_SET;
}

function withApproval(session: Session): void {
  (session.messageManager as unknown as { getPendingApproval: () => unknown }).getPendingApproval =
    () => ({ postId: 'post-a1', type: 'plan', toolUseId: 'tu-2' });
}

let spies: Spies;
beforeEach(() => {
  spies = { posts: [], answered: [], approvals: [], sentToAgent: [] };
  quickQueryCfg.current = { success: true, response: '{"decide": false, "reason": "нужен человек"}' };
  quickQueryMock.mockClear();
});

// ---------------------------------------------------------------------------
// Policy & parsing
// ---------------------------------------------------------------------------

describe('resolvePolicy', () => {
  it('defaults to auto-answer on, sonnet judge', () => {
    const p = resolvePolicy({ config: {} } as unknown as SessionContext);
    expect(p.autoAnswer).toBe(true);
    expect(p.judgeModel).toBe('sonnet');
    expect(p.waitTimeoutMs).toBe(DEFAULT_WAIT_TIMEOUT_MS);
    expect(p.maxEscalations).toBe(DEFAULT_MAX_ESCALATIONS);
  });

  it('honours explicit autoAnswer: false', () => {
    const p = resolvePolicy({ config: { arbiterPolicy: { autoAnswer: false } } } as unknown as SessionContext);
    expect(p.autoAnswer).toBe(false);
  });
});

describe('parseJudgeVerdict', () => {
  it('parses a decide verdict with an option index', () => {
    const v = parseJudgeVerdict('{"decide": true, "optionIndex": 0, "reason": "рутина"}', 2);
    expect(v).toEqual({ decide: true, optionIndex: 0, reason: 'рутина' });
  });

  it('parses a refusal', () => {
    const v = parseJudgeVerdict('{"decide": false, "reason": "деструктив"}', 0);
    expect(v?.decide).toBe(false);
  });

  // An out-of-range index would no-op in handleQuestionAnswer, leaving the
  // session parked with its one shot at a decision already spent.
  it('rejects an out-of-range option index', () => {
    expect(parseJudgeVerdict('{"decide": true, "optionIndex": 7, "reason": "x"}', 2)).toBeNull();
    expect(parseJudgeVerdict('{"decide": true, "optionIndex": -1, "reason": "x"}', 2)).toBeNull();
  });

  it('rejects "decide" with no choice when options exist', () => {
    expect(parseJudgeVerdict('{"decide": true, "reason": "x"}', 2)).toBeNull();
  });

  it('returns null for garbage', () => {
    expect(parseJudgeVerdict('no json here', 0)).toBeNull();
    expect(parseJudgeVerdict('{"decide": "maybe"}', 0)).toBeNull();
  });
});

describe('escalationTargets', () => {
  it('prefers configured targets over the session owner', () => {
    const session = makeSession(spies);
    const policy = resolvePolicy({
      config: { arbiterPolicy: { escalateTo: ['maxk', '@anne'] } },
    } as unknown as SessionContext);
    expect(escalationTargets(session, policy)).toEqual(['maxk', '@anne']);
  });

  it('falls back to whoever started the session', () => {
    const session = makeSession(spies);
    const policy = resolvePolicy({ config: {} } as unknown as SessionContext);
    expect(escalationTargets(session, policy)).toEqual(['bebop']);
  });
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe('detectPendingPrompt', () => {
  it('detects a pending question with its options', () => {
    const session = makeSession(spies);
    withQuestion(session);
    const p = detectPendingPrompt(session);
    expect(p?.kind).toBe('question');
    expect(p?.postId).toBe('post-q1');
    expect(p?.options).toHaveLength(2);
  });

  it('includes the question index in the signature so each one restarts the clock', () => {
    const session = makeSession(spies);
    withQuestion(session);
    const first = detectPendingPrompt(session)?.signature;
    (session.messageManager as unknown as { getPendingQuestionSet: () => unknown }).getPendingQuestionSet =
      () => ({ ...QUESTION_SET, currentIndex: 1, questions: [...QUESTION_SET.questions, { ...QUESTION_SET.questions[0] }] });
    expect(detectPendingPrompt(session)?.signature).not.toBe(first);
  });

  it('detects a pending approval', () => {
    const session = makeSession(spies);
    withApproval(session);
    expect(detectPendingPrompt(session)?.kind).toBe('approval');
  });

  it('detects a prose stall only when given the text', () => {
    const session = makeSession(spies);
    expect(detectPendingPrompt(session)).toBeNull();
    expect(detectPendingPrompt(session, 'Что делаем дальше?')?.kind).toBe('text');
  });
});

describe('stillWaitingOnSame', () => {
  it('is false once a human spoke', () => {
    const session = makeSession(spies);
    withQuestion(session);
    const ctx = makeCtx(spies, session);
    noteWaiting(session, ctx, undefined);
    const waiting = getArbiterState(session).waiting!;

    session.messageCount++;
    expect(stillWaitingOnSame(session, waiting)).toBe(false);
    cancelWaiting(session);
  });

  it('is false once the agent resumed work', () => {
    const session = makeSession(spies);
    withQuestion(session);
    const ctx = makeCtx(spies, session);
    noteWaiting(session, ctx, undefined);
    const waiting = getArbiterState(session).waiting!;

    session.isProcessing = true;
    expect(stillWaitingOnSame(session, waiting)).toBe(false);
    cancelWaiting(session);
  });
});

// ---------------------------------------------------------------------------
// Arming
// ---------------------------------------------------------------------------

describe('noteWaiting', () => {
  it('arms a wait for a pending question', () => {
    const session = makeSession(spies);
    withQuestion(session);
    const ctx = makeCtx(spies, session);

    noteWaiting(session, ctx, undefined);

    const waiting = getArbiterState(session).waiting;
    expect(waiting?.kind).toBe('question');
    expect(waiting?.timer).toBeDefined();
    cancelWaiting(session);
  });

  it('clears the wait when nothing is pending any more', () => {
    const session = makeSession(spies);
    withQuestion(session);
    const ctx = makeCtx(spies, session);
    noteWaiting(session, ctx, undefined);

    (session.messageManager as unknown as { getPendingQuestionSet: () => unknown }).getPendingQuestionSet =
      () => null;
    noteWaiting(session, ctx, undefined);

    expect(getArbiterState(session).waiting).toBeUndefined();
  });

  it('does nothing when the arbiter is disabled', () => {
    const session = makeSession(spies);
    withQuestion(session);
    const ctx = makeCtx(spies, session);
    (ctx.config as { arbiterEnabled?: boolean }).arbiterEnabled = false;

    noteWaiting(session, ctx, undefined);

    expect(getArbiterState(session).waiting).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Resolution — the point of the whole feature
// ---------------------------------------------------------------------------

describe('resolution: auto-answer', () => {
  it('answers a routine question on the human behalf and says so', async () => {
    quickQueryCfg.current = {
      success: true,
      response: '{"decide": true, "optionIndex": 0, "reason": "ревью — рутина"}',
    };
    const session = makeSession(spies);
    withQuestion(session);
    const ctx = makeCtx(spies, session);

    noteWaiting(session, ctx, undefined);
    await Bun.sleep(WAIT_MS + 40);

    expect(spies.answered).toEqual([{ postId: 'post-q1', optionIndex: 0 }]);
    expect(spies.posts.some((p) => p.includes('Арбитр решил за вас') && p.includes('Да, кинуть'))).toBe(true);
    // Always reversible — that's what makes deciding acceptable.
    expect(spies.posts.some((p) => p.includes('откатим'))).toBe(true);
  });

  it('approves a pending plan when the judge says it is routine', async () => {
    quickQueryCfg.current = {
      success: true,
      response: '{"decide": true, "approve": true, "reason": "план очевиден"}',
    };
    const session = makeSession(spies);
    withApproval(session);
    const ctx = makeCtx(spies, session);

    noteWaiting(session, ctx, undefined);
    await Bun.sleep(WAIT_MS + 40);

    expect(spies.approvals).toEqual([{ postId: 'post-a1', approved: true }]);
  });

  it('nudges the agent for a prose stall — there is no prompt to answer', async () => {
    quickQueryCfg.current = { success: true, response: '{"decide": true, "reason": "решай сам"}' };
    const session = makeSession(spies);
    const ctx = makeCtx(spies, session);

    noteWaiting(session, ctx, 'Что делаем дальше — фиксить сейчас или оставить?');
    await Bun.sleep(WAIT_MS + 40);

    expect(spies.sentToAgent).toHaveLength(1);
    expect(spies.sentToAgent[0]).toContain('[Arbiter]');
    expect(spies.answered).toHaveLength(0);
  });

  it('never decides when autoAnswer is off — it escalates instead', async () => {
    quickQueryCfg.current = {
      success: true,
      response: '{"decide": true, "optionIndex": 0, "reason": "рутина"}',
    };
    const session = makeSession(spies);
    withQuestion(session);
    const ctx = makeCtx(spies, session, { autoAnswer: false });

    noteWaiting(session, ctx, undefined);
    await Bun.sleep(WAIT_MS + 40);

    expect(spies.answered).toHaveLength(0);
    expect(spies.posts.some((p) => p.includes('агент ждёт ответа'))).toBe(true);
    cancelWaiting(session);
  });
});

describe('resolution: escalation', () => {
  it('pings the owner when the judge insists on a human', async () => {
    const session = makeSession(spies);
    withQuestion(session);
    const ctx = makeCtx(spies, session);

    noteWaiting(session, ctx, undefined);
    await Bun.sleep(WAIT_MS + 40);

    const ping = spies.posts.find((p) => p.includes('агент ждёт ответа'));
    expect(ping).toBeDefined();
    expect(ping).toContain('@bebop');
    expect(ping).toContain('Кинуть @Rocksteady на ревью?');
    expect(ping).toContain(`1/${DEFAULT_MAX_ESCALATIONS}`);
    cancelWaiting(session);
  });

  // Re-judging the same prompt buys the same answer for another Sonnet call.
  it('judges a prompt once, no matter how many times it pings', async () => {
    const session = makeSession(spies);
    withQuestion(session);
    const ctx = makeCtx(spies, session);

    noteWaiting(session, ctx, undefined);
    await Bun.sleep(WAIT_MS * 4 + 60); // long enough for several pings

    const pings = spies.posts.filter((p) => p.includes('агент ждёт ответа')).length;
    expect(pings).toBeGreaterThan(1);
    expect(quickQueryMock).toHaveBeenCalledTimes(1);
    cancelWaiting(session);
  });

  it('pings configured humans instead of the requesting bot', async () => {
    const session = makeSession(spies);
    withQuestion(session);
    const ctx = makeCtx(spies, session, { escalateTo: ['maxk'] });

    noteWaiting(session, ctx, undefined);
    await Bun.sleep(WAIT_MS + 40);

    expect(spies.posts.some((p) => p.includes('@maxk'))).toBe(true);
    cancelWaiting(session);
  });

  it('stands down silently when a human answered while we waited', async () => {
    const session = makeSession(spies);
    withQuestion(session);
    const ctx = makeCtx(spies, session);

    noteWaiting(session, ctx, undefined);
    session.messageCount++; // human replied
    await Bun.sleep(WAIT_MS + 40);

    expect(spies.posts).toHaveLength(0);
    expect(spies.answered).toHaveLength(0);
    expect(getArbiterState(session).waiting).toBeUndefined();
  });

  it('escalates when the decision could not be applied', async () => {
    quickQueryCfg.current = {
      success: true,
      response: '{"decide": true, "optionIndex": 0, "reason": "рутина"}',
    };
    const session = makeSession(spies);
    withQuestion(session);
    (session.messageManager as unknown as { handleQuestionAnswer: unknown }).handleQuestionAnswer =
      mock(async () => false); // the prompt moved on under us
    const ctx = makeCtx(spies, session);

    noteWaiting(session, ctx, undefined);
    await Bun.sleep(WAIT_MS + 40);

    expect(spies.posts.some((p) => p.includes('агент ждёт ответа'))).toBe(true);
    cancelWaiting(session);
  });

  it('does not fire for a killed session', async () => {
    const session = makeSession(spies);
    withQuestion(session);
    const ctx = makeCtx(spies, session);
    noteWaiting(session, ctx, undefined);

    (ctx.state.sessions as Map<string, Session>).delete(session.sessionId);
    await Bun.sleep(WAIT_MS + 40);

    expect(spies.posts).toHaveLength(0);
  });

  it('cancelWaiting stops a pending resolution', async () => {
    const session = makeSession(spies);
    withQuestion(session);
    const ctx = makeCtx(spies, session);

    noteWaiting(session, ctx, undefined);
    cancelWaiting(session);
    await Bun.sleep(WAIT_MS + 40);

    expect(spies.posts).toHaveLength(0);
  });
});
