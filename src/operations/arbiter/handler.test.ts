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
const quickQueryMock = mock(async () => ({ ...quickQueryCfg.current, durationMs: 1 }));

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
  unmetObligations,
  canIntervene,
  MAX_DELIVERY_REMINDERS,
  MAX_CONTINUATION_NUDGES,
} = await import('./handler.js');
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
    } as unknown as Session['messageManager'],
    ...overrides,
  } as unknown as Session;
}

function makeCtx(spies: Spies, arbiterEnabled = true): SessionContext {
  return {
    config: { arbiterEnabled },
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

function openObligation(tool: 'send_dm' | 'send_file', remindCount = 0): ArbiterObligation {
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
  it('parses a valid response', () => {
    expect(parseObligationsResponse('{"obligations":[{"description":"reply to ~releases","tool":"send_dm"}]}'))
      .toEqual([{ description: 'reply to ~releases', tool: 'send_dm' }]);
  });

  it('tolerates surrounding prose', () => {
    expect(parseObligationsResponse('Sure! {"obligations":[{"description":"send report.pdf to @boss","tool":"send_file"}]} hope that helps'))
      .toEqual([{ description: 'send report.pdf to @boss', tool: 'send_file' }]);
  });

  it('filters out unknown tools and junk entries', () => {
    expect(parseObligationsResponse('{"obligations":[{"description":"x","tool":"launch_rocket"},{"description":"","tool":"send_dm"},{"description":"ok","tool":"send_dm"}]}'))
      .toEqual([{ description: 'ok', tool: 'send_dm' }]);
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
});

// -----------------------------------------------------------------------------
// Extraction
// -----------------------------------------------------------------------------

describe('extractObligations', () => {
  it('adds obligations from the extractor response', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies);
    quickQueryCfg.current = {
      success: true,
      response: '{"obligations":[{"description":"reply to ~releases when done","tool":"send_dm"}]}',
    };

    await extractObligations(session, 'почини тест и отпишись в ~releases', ctx);

    expect(getArbiterState(session).obligations).toEqual([
      { description: 'reply to ~releases when done', tool: 'send_dm', status: 'open', remindCount: 0 },
    ]);
    expect(spies.persisted).toBe(1);
  });

  it('drops cancelled obligations (extractor returns empty list)', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies);
    getArbiterState(session).obligations = [openObligation('send_dm')];
    quickQueryCfg.current = { success: true, response: '{"obligations":[]}' };

    await extractObligations(session, 'не надо никуда писать, я передумал', ctx);

    expect(getArbiterState(session).obligations).toEqual([]);
  });

  it('keeps the ledger when the extractor fails', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies);
    getArbiterState(session).obligations = [openObligation('send_dm')];
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
  it('fulfills a matching obligation when the delivery tool is called', () => {
    const session = makeSession(spies);
    getArbiterState(session).obligations = [openObligation('send_dm')];

    noteEvent(session, {
      type: 'tool_use',
      tool_use: { id: 't1', name: 'mcp__claude-threads-mcp__send_dm', input: {} },
    });

    const state = getArbiterState(session);
    expect(state.obligations[0].status).toBe('fulfilled');
    expect(state.deliveryToolCalls).toEqual(['send_dm']);
  });

  it('ignores non-delivery tools', () => {
    const session = makeSession(spies);
    getArbiterState(session).obligations = [openObligation('send_dm')];

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
    state.obligations = [openObligation('send_dm'), openObligation('send_file')];
    state.deliveryToolCalls = ['send_file'];

    expect(unmetObligations(state).map((o) => o.tool)).toEqual(['send_dm']);
  });
});

// -----------------------------------------------------------------------------
// Turn-complete: delivery reminders
// -----------------------------------------------------------------------------

describe('onTurnComplete — delivery reminders', () => {
  it('reminds the agent about an unmet delivery', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies);
    getArbiterState(session).obligations = [openObligation('send_dm')];

    await onTurnComplete(session, ctx);

    expect(spies.sentToAgent).toHaveLength(1);
    expect(spies.sentToAgent[0]).toContain('[Arbiter]');
    expect(spies.sentToAgent[0]).toContain('send_dm');
    expect(getArbiterState(session).obligations[0].remindCount).toBe(1);
    // Thread got an informational note, typing restarted
    expect(spies.createdMessages.some((m) => m.includes('Arbiter'))).toBe(true);
    expect(spies.typingStarted).toBe(1);
    expect(session.isProcessing).toBe(true);
  });

  it('does not remind when the delivery tool was called', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies);
    getArbiterState(session).obligations = [openObligation('send_dm')];
    getArbiterState(session).deliveryToolCalls = ['send_dm'];

    await onTurnComplete(session, ctx);

    expect(spies.sentToAgent).toHaveLength(0);
  });

  it('gives up after MAX reminders and warns the humans', async () => {
    const session = makeSession(spies);
    const ctx = makeCtx(spies);
    getArbiterState(session).obligations = [openObligation('send_dm', MAX_DELIVERY_REMINDERS)];

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
    getArbiterState(session).obligations = [openObligation('send_dm')];

    await onTurnComplete(session, ctx);

    expect(spies.sentToAgent).toHaveLength(0);
  });

  it('does nothing when disabled', async () => {
    const session = makeSession(spies);
    getArbiterState(session).obligations = [openObligation('send_dm')];

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
});
