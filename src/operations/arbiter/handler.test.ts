/**
 * Tests for the arbiter watchdog.
 *
 * `quickQuery` is mocked at the module level so no real `claude -p`
 * subprocess is spawned; everything else runs through the real handler code.
 */

import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';

// -----------------------------------------------------------------------------
// quickQuery mock (must be installed before importing the handler)
// -----------------------------------------------------------------------------

const quickQueryCfg: { current: { success: boolean; response?: string } } = {
  current: { success: true, response: '{"obligations": []}' },
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

// Import AFTER mock.module
const {
  extractObligations,
  noteEvent,
  onTurnComplete,
  getArbiterState,
  parseObligationsResponse,
  parseStallVerdict,
  mightContainDeliveryRequest,
  asksOnlyForSelfThreadReply,
  unmetObligations,
  canIntervene,
  classifyDeliveryTool,
  parseDisputeVerdict,
  MAX_DELIVERY_REMINDERS,
  MAX_CONTINUATION_NUDGES,
} = await import('./handler.js');
const { cancelWaiting } = await import('./waiting.js');
const { createArbiterState } = await import('./types.js');

import type { Session } from '../../session/types.js';
import type { SessionContext } from '../session-context/index.js';
import type { ArbiterObligation } from './types.js';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

interface Spies {
  createdMessages: string[];
  sentToAgent: string[];
  persisted: number;
  typingStarted: number;
}

function makeSession(spies: Spies, overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'mm:thread-1',
    threadId: 'thread-1',
    claudeSessionId: 'uuid-1',
    agentType: 'claude',
    workingDir: '/tmp/proj',
    platformId: 'mm',
    startedBy: 'alice',
    startedAt: new Date(),
    lastActivityAt: new Date(),
    sessionNumber: 1,
    planApproved: false,
    sessionAllowedUsers: new Set(['alice']),
    forceInteractivePermissions: false,
    respondOnlyWhenMentioned: false,
    sessionStartPostId: null,
    timers: {} as unknown as Session['timers'],
    lifecycle: { state: 'active' } as unknown as Session['lifecycle'],
    timeoutWarningPosted: false,
    messageCount: 1,
    isProcessing: false,
    firstPrompt: 'fix the flaky test and report to ~releases',
    platform: {
      platformId: 'mm',
      createPost: mock(async (message: string) => {
        spies.createdMessages.push(message);
        return { id: `post-${spies.createdMessages.length}`, message, userId: 'bot' };
      }),
      getFormatter: () => ({
        formatBold: (t: string) => `**${t}**`,
        formatItalic: (t: string) => `_${t}_`,
        formatCode: (t: string) => `\`${t}\``,
      }),
    } as unknown as Session['platform'],
    claude: {
      isRunning: () => true,
      sendMessage: mock((msg: string) => {
        spies.sentToAgent.push(msg);
      }),
    } as unknown as Session['claude'],
    messageManager: {
      getPendingApproval: () => null,
      hasPendingQuestions: () => false,
      getPendingContextPrompt: () => null,
      getPendingMessageApproval: () => null,
      getPendingBugReport: () => null,
    } as unknown as Session['messageManager'],
    ...overrides,
  } as unknown as Session;
}

function makeCtx(spies: Spies, arbiterEnabled = true, sessions?: Session[]): SessionContext {
  const registry = new Map<string, Session>();
  for (const s of sessions ?? []) registry.set(s.sessionId, s);
  return {
    config: { arbiterEnabled },
    state: { sessions: registry },
    ops: {
      persistSession: mock(() => {
        spies.persisted++;
      }),
      startTyping: mock(() => {
        spies.typingStarted++;
      }),
    },
  } as unknown as SessionContext;
}

function openObligation(tool: 'message' | 'file', remindCount = 0): ArbiterObligation {
  return { description: `deliver via ${tool}`, tool, status: 'open', remindCount };
}

let spies: Spies;
beforeEach(() => {
  spies = { createdMessages: [], sentToAgent: [], persisted: 0, typingStarted: 0 };
  quickQueryCfg.current = { success: true, response: '{"obligations": []}' };
  quickQueryMock.mockClear();
});

// -----------------------------------------------------------------------------
// Parsers & helpers
// -----------------------------------------------------------------------------

describe('parseObligationsResponse', () => {
  it('parses a valid response (kinds)', () => {
    expect(parseObligationsResponse('{"obligations":[{"description":"reply to ~releases","tool":"message"}]}'))
      .toEqual([{ description: 'reply to ~releases', tool: 'message' }]);
  });

  it('maps legacy tool names to kinds', () => {
    expect(parseObligationsResponse('{"obligations":[{"description":"reply to ~releases","tool":"send_dm"}]}'))
      .toEqual([{ description: 'reply to ~releases', tool: 'message' }]);
  });

  it('tolerates surrounding prose', () => {
    expect(parseObligationsResponse('Sure! {"obligations":[{"description":"send report.pdf to @boss","tool":"file"}]} hope that helps'))
      .toEqual([{ description: 'send report.pdf to @boss', tool: 'file' }]);
  });

  it('filters out unknown tools and junk entries', () => {
    expect(parseObligationsResponse('{"obligations":[{"description":"x","tool":"launch_rocket"},{"description":"","tool":"message"},{"description":"ok","tool":"message"}]}'))
      .toEqual([{ description: 'ok', tool: 'message' }]);
  });

  it('returns null for garbage', () => {
    expect(parseObligationsResponse('no json here')).toBeNull();
    expect(parseObligationsResponse('{"nope": true}')).toBeNull();
  });
});

describe('parseStallVerdict', () => {
  it('parses each verdict', () => {
    expect(parseStallVerdict('{"verdict":"continue"}')).toBe('continue');
    expect(parseStallVerdict('{"verdict":"wait_for_human"}')).toBe('wait_for_human');
    expect(parseStallVerdict('{"verdict":"done"}')).toBe('done');
  });

  it('returns null for anything else', () => {
    expect(parseStallVerdict('{"verdict":"maybe"}')).toBeNull();
    expect(parseStallVerdict('nonsense')).toBeNull();
  });
});

describe('mightContainDeliveryRequest', () => {
  it('matches delivery-ish phrasings (en/ru)', () => {
    expect(mightContainDeliveryRequest('когда закончишь — отпишись в канал ~releases')).toBe(true);
    expect(mightContainDeliveryRequest('when done, send a DM to @boss')).toBe(true);
    expect(mightContainDeliveryRequest('fix the bug and notify #general')).toBe(true);
  });

  it('skips plain work requests', () => {
    expect(mightContainDeliveryRequest('fix the flaky test in ci.yml')).toBe(false);
  });

  // Regression: the cross-agent handoff phrasing. The `ответ` stem does NOT
  // match "отвечай", so a review request whose only delivery cue was
  // "отвечай мне в тред" was pre-filtered out and never became an obligation.
  it('matches the cross-agent "отвечай мне в тред" handoff', () => {
    expect(
      mightContainDeliveryRequest('проведи ревью MR 42. Отвечай мне в тред: https://chat.corp/_redirect/pl/abc123')
    ).toBe(true);
  });

  it('matches a bare permalink with no other delivery cue', () => {
    expect(mightContainDeliveryRequest('см. https://chat.corp/_redirect/pl/abc123')).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Extraction
// -----------------------------------------------------------------------------

describe('asksOnlyForSelfThreadReply', () => {
  const OWN = 'ye1k3bcyxprd9gknsiuizx1upc';
  const link = (id: string) => `https://chat.corp/_redirect/pl/${id}`;

  /**
   * Observed in #ai-work: teammates share one thread, so "reply to me here"
   * asks for nothing — yet the arbiter booked an obligation, nagged about work
   * already done, and pushed the agent into a redundant post_in_thread.
   */
  it('is true when the reply-to link is this very thread', () => {
    expect(asksOnlyForSelfThreadReply(
      `@rocksteady что думаешь про squash? Отвечай мне в тред: ${link(OWN)}`, OWN
    )).toBe(true);
  });

  it('is false when the link points at ANOTHER thread', () => {
    expect(asksOnlyForSelfThreadReply(
      `сделай и отпишись в тред: ${link('someotherthread1234567890x')}`, OWN
    )).toBe(false);
  });

  it('is false when something else must still be delivered elsewhere', () => {
    expect(asksOnlyForSelfThreadReply(
      `отвечай мне в тред: ${link(OWN)} и пришли отчёт в канал ~releases`, OWN
    )).toBe(false);
  });

  it('is false without any reply-to link', () => {
    expect(asksOnlyForSelfThreadReply('почини баг в ci.yml', OWN)).toBe(false);
  });
});

describe('extractObligations', () => {
  it('adds obligations from the extractor response', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, true, [session]);
    quickQueryCfg.current = {
      success: true,
      response: '{"obligations":[{"description":"reply to ~releases when done","tool":"message"}]}',
    };

    await extractObligations(session, 'почини тест и отпишись в ~releases', ctx);

    expect(getArbiterState(session).obligations).toEqual([
      { description: 'reply to ~releases when done', tool: 'message', status: 'open', remindCount: 0 },
    ]);
    expect(spies.persisted).toBe(1);
  });

  it('drops cancelled obligations (extractor returns empty list)', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies);
    getArbiterState(session).obligations = [openObligation('message')];
    quickQueryCfg.current = { success: true, response: '{"obligations":[]}' };

    await extractObligations(session, 'не надо никуда писать, я передумал', ctx);

    expect(getArbiterState(session).obligations).toEqual([]);
  });

  it('keeps the ledger when the extractor fails', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies);
    getArbiterState(session).obligations = [openObligation('message')];
    quickQueryCfg.current = { success: false };

    await extractObligations(session, 'отправь ещё и файл', ctx);

    expect(getArbiterState(session).obligations).toHaveLength(1);
  });

  it('skips the LLM call for plain work messages with an empty ledger', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies);

    await extractObligations(session, 'fix the flaky test in ci.yml', ctx);

    expect(quickQueryMock).not.toHaveBeenCalled();
  });

  it('does nothing for codex sessions and when disabled', async () => {
    const codexSession = makeSession(spies, { agentType: 'codex' } as Partial<Session>);
    await extractObligations(codexSession, 'отпишись в канал ~releases', makeCtx(spies));
    expect(quickQueryMock).not.toHaveBeenCalled();

    const session = makeSession(spies);
    await extractObligations(session, 'отпишись в канал ~releases', makeCtx(spies, false));
    expect(quickQueryMock).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Event bookkeeping
// -----------------------------------------------------------------------------

describe('noteEvent', () => {
  it('a tool_use alone does NOT fulfill — fulfillment waits for the result', () => {
    const session = makeSession(spies);
    getArbiterState(session).obligations = [openObligation('message')];

    noteEvent(session, {
      type: 'tool_use',
      tool_use: { id: 't1', name: 'mcp__claude-threads-mcp__send_dm', input: {} },
    });

    const state = getArbiterState(session);
    expect(state.obligations[0].status).toBe('open');
    expect(state.deliveryToolCalls).toEqual([]);
    expect(state.pendingDeliveryCalls.get('t1')).toBe('message');
  });

  it('fulfills the obligation when the delivery tool result comes back clean', () => {
    const session = makeSession(spies);
    getArbiterState(session).obligations = [openObligation('message')];

    noteEvent(session, {
      type: 'tool_use',
      tool_use: { id: 't1', name: 'mcp__claude-threads-mcp__send_dm', input: {} },
    });
    noteEvent(session, {
      type: 'tool_result',
      tool_result: { tool_use_id: 't1', is_error: false },
    });

    const state = getArbiterState(session);
    expect(state.obligations[0].status).toBe('fulfilled');
    expect(state.deliveryToolCalls).toEqual(['message']);
    expect(state.pendingDeliveryCalls.size).toBe(0);
  });

  it('a FAILED delivery keeps the obligation open', () => {
    const session = makeSession(spies);
    getArbiterState(session).obligations = [openObligation('message')];

    noteEvent(session, {
      type: 'tool_use',
      tool_use: { id: 't1', name: 'mcp__claude-threads-mcp__send_dm', input: {} },
    });
    noteEvent(session, {
      type: 'tool_result',
      tool_result: { tool_use_id: 't1', is_error: true },
    });

    const state = getArbiterState(session);
    expect(state.obligations[0].status).toBe('open');
    expect(state.deliveryToolCalls).toEqual([]);
  });

  it('ignores non-delivery tools', () => {
    const session = makeSession(spies);
    getArbiterState(session).obligations = [openObligation('message')];

    noteEvent(session, { type: 'tool_use', tool_use: { id: 't1', name: 'Bash', input: {} } });

    expect(getArbiterState(session).obligations[0].status).toBe('open');
  });

  it('remembers the last assistant text of the turn', () => {
    const session = makeSession(spies);

    noteEvent(session, { type: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } });
    noteEvent(session, { type: 'assistant', message: { content: [{ type: 'text', text: 'Should I continue?' }] } });

    expect(getArbiterState(session).lastAssistantText).toBe('Should I continue?');
  });
});

describe('unmetObligations', () => {
  it('returns open obligations whose tool was never called', () => {
    const state = createArbiterState();
    state.obligations = [openObligation('message'), openObligation('file')];
    state.deliveryToolCalls = ['file'];

    expect(unmetObligations(state).map((o) => o.tool)).toEqual(['message']);
  });
});

// -----------------------------------------------------------------------------
// Turn-complete: delivery reminders
// -----------------------------------------------------------------------------

describe('onTurnComplete — delivery reminders', () => {
  it('reminds the agent about an unmet delivery', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies);
    getArbiterState(session).obligations = [openObligation('message')];

    await onTurnComplete(session, ctx);

    expect(spies.sentToAgent).toHaveLength(1);
    expect(spies.sentToAgent[0]).toContain('[Arbiter]');
    expect(spies.sentToAgent[0]).toContain('message delivery');
    expect(getArbiterState(session).obligations[0].remindCount).toBe(1);
    // Thread got an informational note, typing restarted
    expect(spies.createdMessages.some((m) => m.includes('Arbiter'))).toBe(true);
    expect(spies.typingStarted).toBe(1);
    expect(session.isProcessing).toBe(true);
  });

  it('does not remind when the delivery tool was called', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies);
    getArbiterState(session).obligations = [openObligation('message')];
    getArbiterState(session).deliveryToolCalls = ['message'];

    await onTurnComplete(session, ctx);

    expect(spies.sentToAgent).toHaveLength(0);
  });

  it('gives up after MAX reminders and warns the humans', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies);
    getArbiterState(session).obligations = [openObligation('message', MAX_DELIVERY_REMINDERS)];

    await onTurnComplete(session, ctx);

    expect(spies.sentToAgent).toHaveLength(0);
    expect(getArbiterState(session).obligations[0].status).toBe('failed');
    expect(spies.createdMessages.some((m) => m.includes('without completing'))).toBe(true);

    // A failed obligation never triggers the arbiter again
    await onTurnComplete(session, ctx);
    expect(spies.sentToAgent).toHaveLength(0);
  });

  it('does not intervene when an interactive prompt is pending', async () => {
    const session = makeSession(spies, {
      messageManager: {
        getPendingApproval: () => ({ postId: 'p', type: 'plan', toolUseId: 't' }),
        hasPendingQuestions: () => false,
        getPendingContextPrompt: () => null,
      } as unknown as Session['messageManager'],
    } as Partial<Session>);
    const ctx = makeCtx(spies);
    getArbiterState(session).obligations = [openObligation('message')];

    await onTurnComplete(session, ctx);

    expect(spies.sentToAgent).toHaveLength(0);
  });

  /**
   * The inversion that makes the human-wait watchdog work: canIntervene()
   * refuses to touch a session with a pending interactive prompt, and
   * onTurnComplete used to return right there. The wait clock has to be armed
   * BEFORE that gate, or the very case that silently parks the fleet — an
   * unanswered AskUserQuestion — is the one case nothing watches.
   */
  it('arms the human-wait clock even though it will not intervene', async () => {
    const session = makeSession(spies, {
      messageManager: {
        getPendingApproval: () => ({ postId: 'p', type: 'plan', toolUseId: 't' }),
        hasPendingQuestions: () => false,
        getPendingQuestionSet: () => null,
        getPendingContextPrompt: () => null,
      } as unknown as Session['messageManager'],
    } as Partial<Session>);
    const ctx = makeCtx(spies, true, [session]);
    (ctx.config as { arbiterPolicy?: unknown }).arbiterPolicy = {
      waitTimeoutMs: 60_000, // long: we assert the clock exists, not that it fires
    };
    getArbiterState(session).obligations = [openObligation('message')];

    await onTurnComplete(session, ctx);

    const waiting = getArbiterState(session).waiting;
    expect(waiting?.kind).toBe('approval');
    expect(waiting?.timer).toBeDefined();
    expect(spies.sentToAgent).toHaveLength(0); // still does not barge in

    cancelWaiting(session);
  });

  it('drops the wait clock once the prompt is gone', async () => {
    const session = makeSession(spies, {
      messageManager: {
        getPendingApproval: () => null,
        hasPendingQuestions: () => false,
        getPendingQuestionSet: () => null,
        getPendingContextPrompt: () => null,
      } as unknown as Session['messageManager'],
    } as Partial<Session>);
    const ctx = makeCtx(spies, true, [session]);
    getArbiterState(session).waiting = {
      kind: 'approval',
      signature: 'a:stale',
      text: 'old',
      messageCountAtArm: 0,
      since: Date.now(),
      escalations: 0,
      autoAnswered: false,
    };

    await onTurnComplete(session, ctx);

    expect(getArbiterState(session).waiting).toBeUndefined();
  });

  it('does nothing when disabled', async () => {
    const session = makeSession(spies);
    getArbiterState(session).obligations = [openObligation('message')];

    await onTurnComplete(session, makeCtx(spies, false));

    expect(spies.sentToAgent).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// Turn-complete: stall nudges
// -----------------------------------------------------------------------------

describe('onTurnComplete — stall nudges', () => {
  it('nudges the agent when the verdict is continue', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies);
    getArbiterState(session).lastAssistantText = 'I found the issue. Should I continue with the fix?';
    quickQueryCfg.current = { success: true, response: '{"verdict":"continue"}' };

    await onTurnComplete(session, ctx);

    expect(spies.sentToAgent).toHaveLength(1);
    expect(spies.sentToAgent[0]).toContain('continue working');
    expect(getArbiterState(session).continuationNudges).toBe(1);
  });

  it('leaves genuine questions to the humans', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies);
    getArbiterState(session).lastAssistantText = 'Which auth provider should we use: OAuth or SAML?';
    quickQueryCfg.current = { success: true, response: '{"verdict":"wait_for_human"}' };

    await onTurnComplete(session, ctx);

    expect(spies.sentToAgent).toHaveLength(0);
    expect(getArbiterState(session).continuationNudges).toBe(0);
  });

  it('skips the LLM call when the final message has no question-like phrasing', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies);
    getArbiterState(session).lastAssistantText = 'All done. Tests pass, PR is up.';

    await onTurnComplete(session, ctx);

    expect(quickQueryMock).not.toHaveBeenCalled();
    expect(spies.sentToAgent).toHaveLength(0);
  });

  it('stops nudging after the cap', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies);
    getArbiterState(session).lastAssistantText = 'Should I continue?';
    getArbiterState(session).continuationNudges = MAX_CONTINUATION_NUDGES;
    quickQueryCfg.current = { success: true, response: '{"verdict":"continue"}' };

    await onTurnComplete(session, ctx);

    expect(spies.sentToAgent).toHaveLength(0);
  });

  it('aborts the nudge when a human replied while judging', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies);
    getArbiterState(session).lastAssistantText = 'Should I continue?';
    quickQueryCfg.current = { success: true, response: '{"verdict":"continue"}' };
    // Simulate a user reply arriving during the LLM call
    quickQueryMock.mockImplementationOnce(async () => {
      session.messageCount++;
      return { ...quickQueryCfg.current, durationMs: 1 };
    });

    await onTurnComplete(session, ctx);

    expect(spies.sentToAgent).toHaveLength(0);
    expect(getArbiterState(session).continuationNudges).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Review fixes: concurrency, persist guard, liveness rechecks, text consumption
// -----------------------------------------------------------------------------

describe('extractObligations — serialization', () => {
  it('does not lose obligations when two extractions overlap', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, true, [session]);

    // First call resolves slowly with obligation A; second call's prompt must
    // see A in the ledger (serialization) and returns A + B.
    const prompts: string[] = [];
    quickQueryMock.mockImplementationOnce(async (opts: { prompt: string }) => {
      prompts.push(opts.prompt);
      await new Promise((r) => setTimeout(r, 30));
      return { success: true, response: '{"obligations":[{"description":"DM @alice","tool":"send_dm"}]}', durationMs: 1 };
    });
    quickQueryMock.mockImplementationOnce(async (opts: { prompt: string }) => {
      prompts.push(opts.prompt);
      return { success: true, response: '{"obligations":[{"description":"DM @alice","tool":"send_dm"},{"description":"post to ~releases","tool":"send_dm"}]}', durationMs: 1 };
    });

    const first = extractObligations(session, 'напиши @alice когда закончишь', ctx);
    const second = extractObligations(session, 'и ещё отпишись в ~releases', ctx);
    await Promise.all([first, second]);

    const open = getArbiterState(session).obligations.filter((o) => o.status === 'open');
    expect(open.map((o) => o.description).sort()).toEqual(['DM @alice', 'post to ~releases']);
    // Second extraction saw the first one's result in its prompt
    expect(prompts[1]).toContain('DM @alice');
  });
});

describe('persist guard (killed session)', () => {
  it('does not persist from a late extraction when the session was unregistered', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, true, []); // session NOT in the registry (killed)
    quickQueryCfg.current = {
      success: true,
      response: '{"obligations":[{"description":"reply to ~releases","tool":"send_dm"}]}',
    };

    await extractObligations(session, 'отпишись в ~releases', ctx);

    expect(spies.persisted).toBe(0);
  });

  it('does not persist a reminder for an unregistered session', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, true, []);
    getArbiterState(session).obligations = [openObligation('message')];

    await onTurnComplete(session, ctx);

    expect(spies.persisted).toBe(0);
  });
});

describe('liveness recheck before sending', () => {
  it('drops the delivery reminder if session.claude was replaced mid-flight (e.g. !cd)', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, true, [session]);
    getArbiterState(session).obligations = [openObligation('message')];

    // Simulate a !cd restart happening during the arbiter's thread post
    (session.platform.createPost as ReturnType<typeof mock>).mockImplementationOnce(async (message: string) => {
      spies.createdMessages.push(message);
      session.claude = {
        isRunning: () => true,
        sendMessage: mock((msg: string) => spies.sentToAgent.push(`WRONG:${msg}`)),
      } as unknown as Session['claude'];
      return { id: 'post-x', message, userId: 'bot' };
    });

    await onTurnComplete(session, ctx);

    expect(spies.sentToAgent).toHaveLength(0);
    // The reminder was not consumed — it can retry on the next turn
    expect(getArbiterState(session).obligations[0].remindCount).toBe(0);
  });
});

describe('lastAssistantText consumption', () => {
  it('a stall check consumes the text — no re-judging on a later text-less turn', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, true, [session]);
    getArbiterState(session).lastAssistantText = 'Should I continue?';
    quickQueryCfg.current = { success: true, response: '{"verdict":"wait_for_human"}' };

    await onTurnComplete(session, ctx);
    expect(quickQueryMock).toHaveBeenCalledTimes(1);
    expect(getArbiterState(session).lastAssistantText).toBeUndefined();

    // Next turn ends without any assistant text — stale question must not re-trigger
    await onTurnComplete(session, ctx);
    expect(quickQueryMock).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------------
// Delivery via ANY chat MCP + dispute resolution (bug: arbiter bullied the
// agent into a forbidden send_dm after it delivered via post_message)
// -----------------------------------------------------------------------------

describe('classifyDeliveryTool', () => {
  it('recognizes delivery tools from any MCP server by short name', () => {
    expect(classifyDeliveryTool('mcp__claude-threads-mcp__send_dm')).toBe('message');
    expect(classifyDeliveryTool('mcp__mattermost__post_message')).toBe('message');
    // Regression: the tool a bot actually uses to answer a teammate's thread.
    // Missing here, a CORRECT delivery went uncounted and the arbiter nagged
    // about work that was already done, then filed a false "not delivered".
    expect(classifyDeliveryTool('mcp__mattermost__post_in_thread')).toBe('message');
    expect(classifyDeliveryTool('mcp__slack-tools__send_message')).toBe('message');
    expect(classifyDeliveryTool('mcp__claude-threads-mcp__send_file')).toBe('file');
    expect(classifyDeliveryTool('mcp__drive__upload_file')).toBe('file');
  });

  it('does not classify unrelated tools', () => {
    expect(classifyDeliveryTool('Bash')).toBeUndefined();
    expect(classifyDeliveryTool('mcp__mattermost__read_post')).toBeUndefined();
    expect(classifyDeliveryTool('mcp__gitlab__create_merge_request')).toBeUndefined();
  });
});

describe('delivery through another MCP server', () => {
  it('post_message from a different MCP fulfills a message obligation — no reminder', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, true, [session]);
    getArbiterState(session).obligations = [openObligation('message')];

    // The agent delivers via the mattermost MCP, not claude-threads send_dm
    noteEvent(session, {
      type: 'tool_use',
      tool_use: { id: 'pm1', name: 'mcp__mattermost__post_message', input: {} },
    });
    noteEvent(session, {
      type: 'tool_result',
      tool_result: { tool_use_id: 'pm1', is_error: false },
    });

    expect(getArbiterState(session).obligations[0].status).toBe('fulfilled');

    await onTurnComplete(session, ctx);
    expect(spies.sentToAgent).toHaveLength(0);
  });
});

describe('dispute resolution after a reminder', () => {
  it('waives the obligation when the agent explains it delivered another way', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, true, [session]);
    getArbiterState(session).obligations = [openObligation('message', 1)]; // already reminded once
    getArbiterState(session).lastAssistantText =
      'Уже сделано — отправил через post_message в канал рокстеди (post_id 94ydo). send_dm в нашей связке запрещён и не работает.';
    quickQueryCfg.current = { success: true, response: '{"verdict":"resolved"}' };

    await onTurnComplete(session, ctx);

    expect(getArbiterState(session).obligations[0].status).toBe('waived');
    expect(spies.sentToAgent).toHaveLength(0); // no second reminder
    expect(spies.createdMessages.some((m) => m.includes('accepting'))).toBe(true);

    // Waived obligations never trigger the arbiter again
    await onTurnComplete(session, ctx);
    expect(spies.sentToAgent).toHaveLength(0);
  });

  it('keeps reminding when the judge says the delivery is still not done', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, true, [session]);
    getArbiterState(session).obligations = [openObligation('message', 1)];
    getArbiterState(session).lastAssistantText = 'Понял, сейчас займусь этим.';
    quickQueryCfg.current = { success: true, response: '{"verdict":"not_done"}' };

    await onTurnComplete(session, ctx);

    expect(getArbiterState(session).obligations[0].status).toBe('open');
    expect(getArbiterState(session).obligations[0].remindCount).toBe(2);
    expect(spies.sentToAgent).toHaveLength(1);
  });

  it('the FIRST reminder is sent without judging (nothing to dispute yet)', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies, true, [session]);
    getArbiterState(session).obligations = [openObligation('message', 0)];
    getArbiterState(session).lastAssistantText = 'Готово, MR запушен.';

    await onTurnComplete(session, ctx);

    expect(quickQueryMock).not.toHaveBeenCalled();
    expect(spies.sentToAgent).toHaveLength(1);
  });
});

describe('parseDisputeVerdict', () => {
  it('parses verdicts and rejects garbage', () => {
    expect(parseDisputeVerdict('{"verdict":"resolved"}')).toBe('resolved');
    expect(parseDisputeVerdict('{"verdict":"not_done"}')).toBe('not_done');
    expect(parseDisputeVerdict('{"verdict":"maybe"}')).toBeNull();
    expect(parseDisputeVerdict('nope')).toBeNull();
  });
});

describe('legacy persisted state normalization', () => {
  it('maps send_dm/send_file to kinds on hydration', () => {
    const state = createArbiterState({
      obligations: [{ description: 'x', tool: 'send_dm' as never, status: 'open', remindCount: 1 }],
      deliveryToolCalls: ['send_file'],
      continuationNudges: 2,
    });

    expect(state.obligations[0].tool).toBe('message');
    expect(state.deliveryToolCalls).toEqual(['file']);
    expect(state.continuationNudges).toBe(2);
  });
});

// -----------------------------------------------------------------------------
// canIntervene
// -----------------------------------------------------------------------------

describe('canIntervene', () => {
  it('is true for an idle active session', () => {
    expect(canIntervene(makeSession(spies))).toBe(true);
  });

  it('is false while processing, when not running, or mid-shutdown', () => {
    expect(canIntervene(makeSession(spies, { isProcessing: true } as Partial<Session>))).toBe(false);
    expect(canIntervene(makeSession(spies, {
      claude: { isRunning: () => false, sendMessage: () => {} } as unknown as Session['claude'],
    } as Partial<Session>))).toBe(false);
    expect(canIntervene(makeSession(spies, {
      lifecycle: { state: 'ending' } as unknown as Session['lifecycle'],
    } as Partial<Session>))).toBe(false);
  });

  it('is false when a worktree prompt is pending', () => {
    expect(canIntervene(makeSession(spies, { pendingWorktreePrompt: true } as Partial<Session>))).toBe(false);
  });

  it('is false while a message approval or bug report is pending', () => {
    expect(canIntervene(makeSession(spies, {
      messageManager: {
        getPendingApproval: () => null,
        hasPendingQuestions: () => false,
        getPendingContextPrompt: () => null,
        getPendingMessageApproval: () => ({ fromUser: 'bob' }),
        getPendingBugReport: () => null,
      } as unknown as Session['messageManager'],
    } as Partial<Session>))).toBe(false);

    expect(canIntervene(makeSession(spies, {
      messageManager: {
        getPendingApproval: () => null,
        hasPendingQuestions: () => false,
        getPendingContextPrompt: () => null,
        getPendingMessageApproval: () => null,
        getPendingBugReport: () => ({ postId: 'p1' }),
      } as unknown as Session['messageManager'],
    } as Partial<Session>))).toBe(false);
  });
});

/**
 * The prompts sanction exactly one cross-bot delivery tool, and the arbiter did
 * not count it. krang delivered to rocksteady through `send_to_teammate`, the
 * ledger stayed open, the arbiter reminded him, he delivered again — the same
 * post every three minutes for half an hour, agent obeying both the prompt and
 * the arbiter while they disagreed.
 */
describe('classifyDeliveryTool — the sanctioned teammate tool counts', () => {
  it('recognises send_to_teammate as a message delivery', () => {
    expect(classifyDeliveryTool('mcp__claude-threads-mcp__send_to_teammate')).toBe('message');
    expect(classifyDeliveryTool('send_to_teammate')).toBe('message');
  });

  it('still recognises the raw platform tools', () => {
    expect(classifyDeliveryTool('mcp__mattermost__post_in_thread')).toBe('message');
    expect(classifyDeliveryTool('mcp__mattermost__post_message')).toBe('message');
  });

  it('does not count unrelated tools', () => {
    expect(classifyDeliveryTool('Bash')).toBeUndefined();
    expect(classifyDeliveryTool('mcp__mattermost__find_channel_by_name')).toBeUndefined();
  });
});
