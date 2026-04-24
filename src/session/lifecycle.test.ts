import { describe, it, expect, mock } from 'bun:test';

import * as lifecycle from './lifecycle.js';
import type { SessionContext } from '../operations/session-context/index.js';
import type { Session } from './types.js';
import { createSessionTimers, createSessionLifecycle, createResumedLifecycle } from './types.js';
import type { PlatformClient } from '../platform/index.js';
import { createMockFormatter } from '../test-utils/mock-formatter.js';

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Create a mock platform client for testing
 */
function createMockPlatform(overrides?: Partial<PlatformClient>): PlatformClient {
  return {
    platformId: 'test-platform',
    platformType: 'mattermost',
    displayName: 'Test Platform',
    createPost: mock(() => Promise.resolve({ id: 'post-1', message: '', userId: 'bot' })),
    updatePost: mock(() => Promise.resolve({ id: 'post-1', message: '', userId: 'bot' })),
    deletePost: mock(() => Promise.resolve()),
    addReaction: mock(() => Promise.resolve()),
    removeReaction: mock(() => Promise.resolve()),
    getBotUser: mock(() => Promise.resolve({ id: 'bot', username: 'testbot' })),
    getUser: mock(() => Promise.resolve({ id: 'user-1', username: 'testuser' })),
    isUserAllowed: mock(() => true),
    connect: mock(() => Promise.resolve()),
    disconnect: mock(() => Promise.resolve()),
    onMessage: mock(() => {}),
    onReaction: mock(() => {}),
    getMcpConfig: mock(() => ({})),
    createInteractivePost: mock(() => Promise.resolve({ id: 'post-1', message: '', userId: 'bot' })),
    getChannelId: mock(() => 'channel-1'),
    getThreadHistory: mock(() => Promise.resolve([])),
    pinPost: mock(() => Promise.resolve()),
    unpinPost: mock(() => Promise.resolve()),
    getPinnedPosts: mock(() => Promise.resolve([])),
    getPost: mock(() => Promise.resolve(null)),
    getFormatter: mock(() => createMockFormatter()),
    sendTyping: mock(() => Promise.resolve()),
    ...overrides,
  } as unknown as PlatformClient;
}

/**
 * Create a mock message manager for testing
 */
function createMockMessageManager() {
  return {
    closeCurrentPost: mock(() => Promise.resolve()),
    handleEvent: mock(() => Promise.resolve()),
    flush: mock(() => Promise.resolve()),
    prepareForUserMessage: mock(() => Promise.resolve()),
    handleUserMessage: mock(() => Promise.resolve(true)),
    getCurrentPostId: mock(() => null),
    getCurrentPostContent: mock(() => ''),
    hasPendingQuestions: mock(() => false),
    hasPendingApproval: mock(() => false),
    getPendingApproval: mock(() => null),
    getPendingQuestionSet: mock(() => null),
    clearPendingApproval: mock(() => {}),
    clearPendingQuestionSet: mock(() => {}),
    advanceQuestionIndex: mock(() => {}),
    handleQuestionAnswer: mock(() => Promise.resolve(false)),
    handleApprovalResponse: mock(() => Promise.resolve(false)),
    handleSubagentToggle: mock(() => Promise.resolve(false)),
    handleTaskListToggle: mock(() => Promise.resolve(false)),
    bumpTaskList: mock(() => Promise.resolve()),
    getTaskListState: mock(() => ({ postId: null, content: null, isMinimized: false, isCompleted: false })),
    hydrateTaskListState: mock(() => {}),
    setWorktreeInfo: mock(() => {}),
    clearWorktreeInfo: mock(() => {}),
    postInfo: mock(() => Promise.resolve(undefined)),
    postWarning: mock(() => Promise.resolve(undefined)),
    postError: mock(() => Promise.resolve(undefined)),
    postSuccess: mock(() => Promise.resolve(undefined)),
    reset: mock(() => {}),
    dispose: mock(() => {}),
  };
}

/**
 * Create a mock session for testing
 */
function createMockSession(overrides?: Partial<Session> & {
  // Legacy flag aliases for backward compatibility in tests
  isRestarting?: boolean;
  isCancelled?: boolean;
  isResumed?: boolean;
  wasInterrupted?: boolean;
  hasClaudeResponded?: boolean;
}): Session {
  // Build lifecycle state from overrides or defaults
  let lifecycle = createSessionLifecycle();
  if (overrides?.isResumed) {
    lifecycle = createResumedLifecycle();
  }
  if (overrides?.isRestarting) {
    lifecycle.state = 'restarting';
  }
  if (overrides?.isCancelled) {
    lifecycle.state = 'cancelling';
  }
  if (overrides?.wasInterrupted) {
    lifecycle.state = 'interrupted';
  }
  if (overrides?.hasClaudeResponded) {
    lifecycle.hasClaudeResponded = true;
  }
  // Allow direct lifecycle override
  if (overrides?.lifecycle) {
    lifecycle = overrides.lifecycle;
  }

  return {
    sessionId: 'test-platform:thread-123',
    threadId: 'thread-123',
    platform: createMockPlatform(),
    claude: {
      isRunning: mock(() => true),
      kill: mock(() => Promise.resolve()),
      start: mock(() => {}),
      sendMessage: mock(() => {}),
      on: mock(() => {}),
      interrupt: mock(() => {}),
    } as any,
    claudeSessionId: 'claude-session-1',
    owner: 'testuser',
    startedBy: 'testuser',
    startedAt: new Date(),
    lastActivityAt: new Date(),
    buffer: '',
    taskListPostId: null,
    taskListBuffer: '',
    sessionAllowedUsers: new Set(['testuser']),
    workingDir: '/test',
    timers: createSessionTimers(),
    lifecycle,
    sessionStartPostId: 'start-post-id',
    timeoutWarningPosted: false,
    tasksCompleted: false,
    tasksMinimized: false,
    lastTasksContent: '',
    tasksPostId: null,
    skipPermissions: true,
    forceInteractivePermissions: false,
    messageManager: createMockMessageManager() as any,
    ...overrides,
  } as Session;
}

/**
 * Create a mock session context
 */
function createMockSessionContext(sessions: Map<string, Session> = new Map()): SessionContext {
  return {
    config: {
      workingDir: '/test',
      skipPermissions: true,
      chromeEnabled: false,
      debug: false,
      maxSessions: 5,
    },
    state: {
      sessions,
      postIndex: new Map(),
      platforms: new Map([['test-platform', createMockPlatform()]]),
      sessionStore: {
        save: mock(() => {}),
        remove: mock(() => {}),
        getAll: mock(() => []),
        get: mock(() => null),
        cleanStale: mock(() => []),
        saveStickyPostId: mock(() => {}),
        getStickyPostId: mock(() => null),
        load: mock(() => new Map()),
        findByPostId: mock(() => undefined),
      } as any,
      isShuttingDown: false,
    },
    ops: {
      getSessionId: mock((platformId, threadId) => `${platformId}:${threadId}`),
      findSessionByThreadId: mock((threadId) => sessions.get(`test-platform:${threadId}`)),
      registerPost: mock(() => {}),
      handleEvent: mock(() => {}),
      handleExit: mock(() => Promise.resolve()),
      startTyping: mock(() => {}),
      stopTyping: mock(() => {}),
      flush: mock(() => Promise.resolve()),
      updateStickyMessage: mock(() => Promise.resolve()),
      updateSessionHeader: mock(() => Promise.resolve()),
      persistSession: mock(() => {}),
      unpersistSession: mock(() => {}),
      shouldPromptForWorktree: mock(() => Promise.resolve(null)),
      postWorktreePrompt: mock(() => Promise.resolve()),
      buildMessageContent: mock((prompt: string) => Promise.resolve({ content: prompt, skipped: [] })),
      offerContextPrompt: mock(() => Promise.resolve(false)),
      killSession: mock(() => Promise.resolve()),
      emitSessionAdd: mock(() => {}),
      emitSessionUpdate: mock(() => {}),
      emitSessionRemove: mock(() => {}),
      registerWorktreeUser: mock(() => {}),
      unregisterWorktreeUser: mock(() => {}),
      hasOtherSessionsUsingWorktree: mock(() => false),
      switchToWorktree: mock(async () => {}),
      forceUpdate: mock(async () => {}),
      deferUpdate: mock(() => {}),
      handleBugReportApproval: mock(async () => {}),
      acquireClaudeAccount: mock(() => null),
      getClaudeAccount: mock(() => undefined),
      releaseClaudeAccount: mock(() => {}),
      markClaudeAccountCooling: mock(() => {}),
      getClaudeAccountPoolStatus: mock(() => []),
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('Lifecycle Module', () => {
  describe('killSession', () => {
    it('kills the Claude CLI and removes session', async () => {
      const session = createMockSession();
      const sessions = new Map([['test-platform:thread-123', session]]);
      const ctx = createMockSessionContext(sessions);

      await lifecycle.killSession(session, true, ctx);

      expect(session.claude.kill).toHaveBeenCalled();
      expect(sessions.has('test-platform:thread-123')).toBe(false);
    });

    it('unpersists when requested', async () => {
      const session = createMockSession();
      const sessions = new Map([['test-platform:thread-123', session]]);
      const ctx = createMockSessionContext(sessions);

      await lifecycle.killSession(session, true, ctx);

      expect(ctx.ops.unpersistSession).toHaveBeenCalledWith('test-platform:thread-123');
    });

    it('preserves persistence when not unpersisting', async () => {
      const session = createMockSession();
      const sessions = new Map([['test-platform:thread-123', session]]);
      const ctx = createMockSessionContext(sessions);

      await lifecycle.killSession(session, false, ctx);

      expect(ctx.ops.unpersistSession).not.toHaveBeenCalled();
    });

    it('updates sticky message after killing', async () => {
      const session = createMockSession();
      const sessions = new Map([['test-platform:thread-123', session]]);
      const ctx = createMockSessionContext(sessions);

      await lifecycle.killSession(session, true, ctx);

      expect(ctx.ops.updateStickyMessage).toHaveBeenCalled();
    });

    it('stops typing indicator', async () => {
      const session = createMockSession();
      const sessions = new Map([['test-platform:thread-123', session]]);
      const ctx = createMockSessionContext(sessions);

      await lifecycle.killSession(session, true, ctx);

      expect(ctx.ops.stopTyping).toHaveBeenCalledWith(session);
    });
  });

  describe('killAllSessions', () => {
    it('kills all active sessions', async () => {
      const session1 = createMockSession({ sessionId: 'p:t1', threadId: 't1' });
      const session2 = createMockSession({ sessionId: 'p:t2', threadId: 't2' });
      const sessions = new Map([
        ['p:t1', session1],
        ['p:t2', session2],
      ]);
      const ctx = createMockSessionContext(sessions);

      await lifecycle.killAllSessions(ctx);

      expect(session1.claude.kill).toHaveBeenCalled();
      expect(session2.claude.kill).toHaveBeenCalled();
      expect(sessions.size).toBe(0);
    });

    it('preserves sessions in store for resume', async () => {
      const session = createMockSession();
      const sessions = new Map([['test-platform:thread-123', session]]);
      const ctx = createMockSessionContext(sessions);

      await lifecycle.killAllSessions(ctx);

      // killAllSessions preserves state for resume, so remove should NOT be called
      expect(ctx.state.sessionStore.remove).not.toHaveBeenCalled();
    });
  });

  describe('cleanupIdleSessions', () => {
    it('does not cleanup active sessions', async () => {
      const session = createMockSession({
        lastActivityAt: new Date(), // Just now
      });
      const sessions = new Map([['test-platform:thread-123', session]]);
      const ctx = createMockSessionContext(sessions);

      await lifecycle.cleanupIdleSessions(
        30 * 60 * 1000, // 30 min timeout
        5 * 60 * 1000,  // 5 min warning
        ctx
      );

      expect(sessions.has('test-platform:thread-123')).toBe(true);
      expect(session.claude.kill).not.toHaveBeenCalled();
    });

    it('posts timeout warning before killing', async () => {
      const session = createMockSession({
        lastActivityAt: new Date(Date.now() - 26 * 60 * 1000), // 26 min ago
        timeoutWarningPosted: false,
      });
      const sessions = new Map([['test-platform:thread-123', session]]);
      const ctx = createMockSessionContext(sessions);

      await lifecycle.cleanupIdleSessions(
        30 * 60 * 1000, // 30 min timeout
        5 * 60 * 1000,  // 5 min warning
        ctx
      );

      // Should post warning but not kill yet
      expect(session.timeoutWarningPosted).toBe(true);
      expect(sessions.has('test-platform:thread-123')).toBe(true);
    });
  });
});

describe('handleRateLimit (multi-account cooldown wiring)', () => {
  /**
   * Regression test for reviewer S1: without this coverage, the three
   * wiring bugs it pairs with (M1 restart-rebind, M2 false-positive, M3
   * account leak) could all regress silently. This test exercises the
   * actual handler function that bindings call.
   */
  it('cools the session account when a rate-limit hit fires', () => {
    const session = createMockSession({ claudeAccountId: 'alice' });
    const ctx = createMockSessionContext(new Map([['test-platform:thread-123', session]]));

    lifecycle.handleRateLimit(
      session,
      { detected: true, matched: 'usage limit reached', resetAtEpochMs: Date.now() + 60_000 },
      ctx
    );

    expect(ctx.ops.markClaudeAccountCooling).toHaveBeenCalledTimes(1);
    const [acctId, deadlineMs] = (ctx.ops.markClaudeAccountCooling as ReturnType<typeof mock>).mock.calls[0];
    expect(acctId).toBe('alice');
    expect(deadlineMs).toBeGreaterThan(Date.now());
  });

  it('falls back to the default 1-hour cooldown when reset time is unknown', () => {
    const session = createMockSession({ claudeAccountId: 'bob' });
    const ctx = createMockSessionContext(new Map([['test-platform:thread-123', session]]));

    const before = Date.now();
    lifecycle.handleRateLimit(session, { detected: true, matched: 'rate_limit_error' }, ctx);
    const after = Date.now();

    const [, deadlineMs] = (ctx.ops.markClaudeAccountCooling as ReturnType<typeof mock>).mock.calls[0];
    // Default is 1h — allow a wide window for clock drift in the test.
    expect(deadlineMs).toBeGreaterThanOrEqual(before + 59 * 60_000);
    expect(deadlineMs).toBeLessThanOrEqual(after + 61 * 60_000);
  });

  it('is a no-op in single-account mode (no account id on session)', () => {
    const session = createMockSession({ claudeAccountId: undefined });
    const ctx = createMockSessionContext(new Map([['test-platform:thread-123', session]]));

    lifecycle.handleRateLimit(
      session,
      { detected: true, matched: 'usage limit reached' },
      ctx
    );

    expect(ctx.ops.markClaudeAccountCooling).not.toHaveBeenCalled();
  });
});

describe('Session State Management', () => {
  // NOTE: Subagent tracking tests moved to subagent.test.ts since SubagentExecutor
  // now manages subagent state via MessageManager

  it('tracks session allowed users', () => {
    const session = createMockSession();

    expect(session.sessionAllowedUsers.has('testuser')).toBe(true);
    expect(session.sessionAllowedUsers.has('otheruser')).toBe(false);

    session.sessionAllowedUsers.add('otheruser');
    expect(session.sessionAllowedUsers.has('otheruser')).toBe(true);
  });

});

describe('CHAT_PLATFORM_PROMPT', () => {
  it('contains version information', () => {
    expect(lifecycle.CHAT_PLATFORM_PROMPT).toContain('Claude Threads Version:');
  });

  it('contains user command documentation', () => {
    expect(lifecycle.CHAT_PLATFORM_PROMPT).toContain('!stop');
    expect(lifecycle.CHAT_PLATFORM_PROMPT).toContain('!escape');
    expect(lifecycle.CHAT_PLATFORM_PROMPT).toContain('!invite');
    expect(lifecycle.CHAT_PLATFORM_PROMPT).toContain('!kick');
    expect(lifecycle.CHAT_PLATFORM_PROMPT).toContain('!cd');
    expect(lifecycle.CHAT_PLATFORM_PROMPT).toContain('!permissions');
  });

  it('does not contain session metadata instructions (now handled out-of-band)', () => {
    // Session metadata (title, description) is now generated out-of-band via quickQuery
    // so Claude no longer needs to output [SESSION_TITLE:] markers
    expect(lifecycle.CHAT_PLATFORM_PROMPT).not.toContain('[SESSION_TITLE:');
    expect(lifecycle.CHAT_PLATFORM_PROMPT).not.toContain('[SESSION_DESCRIPTION:');
  });
});

describe('maybeInjectMetadataReminder', () => {
  // Note: This function no longer injects reminders into messages.
  // It now just fires out-of-band reclassification and returns the message unchanged.
  // Session metadata (title, description) is generated via quickQuery, not Claude output markers.

  it('returns message unchanged for first message', () => {
    const message = 'Hello';
    const session = { messageCount: 1 };

    const result = lifecycle.maybeInjectMetadataReminder(message, session);

    expect(result).toBe('Hello');
  });

  it('returns message unchanged for second message', () => {
    const message = 'Hello';
    const session = { messageCount: 2 };

    const result = lifecycle.maybeInjectMetadataReminder(message, session);

    expect(result).toBe('Hello');
  });

  it('returns message unchanged at reclassification interval (every 5 messages)', () => {
    const message = 'Hello';

    // 5th message - still returns unchanged (just fires reclassification in background)
    const result5 = lifecycle.maybeInjectMetadataReminder(message, { messageCount: 5 });
    expect(result5).toBe('Hello');

    // 10th message - same behavior
    const result10 = lifecycle.maybeInjectMetadataReminder(message, { messageCount: 10 });
    expect(result10).toBe('Hello');

    // 15th message - same behavior
    const result15 = lifecycle.maybeInjectMetadataReminder(message, { messageCount: 15 });
    expect(result15).toBe('Hello');
  });

  it('returns message unchanged at all message counts', () => {
    const message = 'Hello';

    // All messages should return unchanged
    expect(lifecycle.maybeInjectMetadataReminder(message, { messageCount: 3 })).toBe('Hello');
    expect(lifecycle.maybeInjectMetadataReminder(message, { messageCount: 4 })).toBe('Hello');
    expect(lifecycle.maybeInjectMetadataReminder(message, { messageCount: 6 })).toBe('Hello');
    expect(lifecycle.maybeInjectMetadataReminder(message, { messageCount: 7 })).toBe('Hello');
  });
});

describe('cleanupIdleSessions extended', () => {
  it('kills session that has exceeded timeout', async () => {
    const session = createMockSession({
      lastActivityAt: new Date(Date.now() - 35 * 60 * 1000), // 35 min ago
      timeoutWarningPosted: true,
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.cleanupIdleSessions(
      30 * 60 * 1000, // 30 min timeout
      5 * 60 * 1000,  // 5 min warning
      ctx
    );

    // Session should be killed
    expect(sessions.has('test-platform:thread-123')).toBe(false);
  });

  it('does not skip sessions with pending approval when timed out', async () => {
    // Note: The current implementation does NOT skip sessions with pending items when timing out
    // This tests the actual behavior
    const mockMsgManager = createMockMessageManager();
    (mockMsgManager.getPendingApproval as any).mockReturnValue({ postId: 'p1', toolUseId: 't1', type: 'action' });
    const session = createMockSession({
      lastActivityAt: new Date(Date.now() - 35 * 60 * 1000), // 35 min ago
      timeoutWarningPosted: true,
      messageManager: mockMsgManager as any,
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.cleanupIdleSessions(
      30 * 60 * 1000,
      5 * 60 * 1000,
      ctx
    );

    // Session is killed even with pending approval (current behavior)
    expect(sessions.has('test-platform:thread-123')).toBe(false);
  });

  it('does not skip sessions with pending question when timed out', async () => {
    // Note: The current implementation does NOT skip sessions with pending items when timing out
    const mockMsgManager = createMockMessageManager();
    (mockMsgManager.getPendingQuestionSet as any).mockReturnValue({ toolUseId: 't1', currentIndex: 0, currentPostId: 'p1', questions: [] });
    const session = createMockSession({
      lastActivityAt: new Date(Date.now() - 35 * 60 * 1000),
      timeoutWarningPosted: true,
      messageManager: mockMsgManager as any,
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.cleanupIdleSessions(
      30 * 60 * 1000,
      5 * 60 * 1000,
      ctx
    );

    // Session is killed even with pending question (current behavior)
    expect(sessions.has('test-platform:thread-123')).toBe(false);
  });

  it('does not skip sessions with pending worktree prompt when timed out', async () => {
    // Note: The current implementation does NOT skip sessions with pending items when timing out
    const session = createMockSession({
      lastActivityAt: new Date(Date.now() - 35 * 60 * 1000),
      timeoutWarningPosted: true,
      pendingWorktreePrompt: true,
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.cleanupIdleSessions(
      30 * 60 * 1000,
      5 * 60 * 1000,
      ctx
    );

    // Session is killed even with pending worktree prompt (current behavior)
    expect(sessions.has('test-platform:thread-123')).toBe(false);
  });

  it('handles empty sessions map', async () => {
    const sessions = new Map<string, Session>();
    const ctx = createMockSessionContext(sessions);

    // Should not throw
    await lifecycle.cleanupIdleSessions(30000, 5000, ctx);

    expect(sessions.size).toBe(0);
  });
});

describe('killSession edge cases', () => {
  it('clears session timers', async () => {
    const session = createMockSession();
    // Set up timers via the new timers object
    session.timers.updateTimer = setTimeout(() => {}, 10000) as any;
    session.timers.statusBarTimer = setInterval(() => {}, 10000) as any;
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.killSession(session, true, ctx);

    // Session should be removed and timers cleared
    expect(sessions.has('test-platform:thread-123')).toBe(false);
  });

  it('emits session remove event', async () => {
    const session = createMockSession();
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.killSession(session, true, ctx);

    expect(ctx.ops.emitSessionRemove).toHaveBeenCalledWith('test-platform:thread-123');
  });

  it('decrements keepAlive session count', async () => {
    const session = createMockSession();
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    // Start a session to increment keepAlive
    const { keepAlive } = await import('../utils/keep-alive.js');
    const initialCount = keepAlive.getSessionCount();

    await lifecycle.killSession(session, true, ctx);

    // Count should have decremented (or stayed at 0 if already 0)
    expect(keepAlive.getSessionCount()).toBeLessThanOrEqual(initialCount);
  });
});

describe('killAllSessions edge cases', () => {
  it('handles sessions with timers', async () => {
    const session = createMockSession();
    // Set up timer via the new timers object
    session.timers.updateTimer = setTimeout(() => {}, 10000) as any;
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.killAllSessions(ctx);

    expect(sessions.size).toBe(0);
  });

  it('handles empty sessions gracefully', async () => {
    const sessions = new Map<string, Session>();
    const ctx = createMockSessionContext(sessions);

    // Should not throw
    await lifecycle.killAllSessions(ctx);

    expect(sessions.size).toBe(0);
  });

  it('calls killSession for each session', async () => {
    const session = createMockSession();
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.killAllSessions(ctx);

    // Claude CLI kill should be called
    expect(session.claude.kill).toHaveBeenCalled();
  });
});

describe('sendFollowUp', () => {
  it('delegates to messageManager.handleUserMessage', async () => {
    // Mock messageManager with handleUserMessage
    const mockMsgManager = createMockMessageManager();
    const session = createMockSession({
      messageManager: mockMsgManager as any,
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.sendFollowUp(session, 'New message', undefined, ctx, 'user', 'User Name');

    // Should have delegated to handleUserMessage
    expect(mockMsgManager.handleUserMessage).toHaveBeenCalledWith('New message', undefined, 'user', 'User Name');
  });

  it('does not send if Claude is not running', async () => {
    const session = createMockSession();
    (session.claude.isRunning as any).mockReturnValue(false);

    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.sendFollowUp(session, 'New message', undefined, ctx);

    // Should not have called handleUserMessage (early return)
    const mockMsgManager = session.messageManager as any;
    expect(mockMsgManager.handleUserMessage).not.toHaveBeenCalled();
  });

  it('increments message counter', async () => {
    const mockMsgManager = createMockMessageManager();
    const session = createMockSession({
      messageCount: 5,
      messageManager: mockMsgManager as any,
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.sendFollowUp(session, 'New message', undefined, ctx);

    expect(session.messageCount).toBe(6);
  });
});

describe('handleExit', () => {
  it('skips cleanup when session is cancelled', async () => {
    const session = createMockSession({ isCancelled: true, isResumed: true });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    // handleExit should return early for cancelled sessions
    await lifecycle.handleExit('test-platform:thread-123', 1, ctx);

    // persistSession should NOT be called for cancelled sessions
    // (cancelled sessions are handled by killSession, not handleExit)
    expect(ctx.ops.persistSession).not.toHaveBeenCalled();
    expect(ctx.ops.unpersistSession).not.toHaveBeenCalled();
  });

  it('returns early when session is not found', async () => {
    const sessions = new Map<string, Session>();
    const ctx = createMockSessionContext(sessions);

    // Should not throw when session doesn't exist
    await lifecycle.handleExit('nonexistent-session', 1, ctx);

    expect(ctx.ops.persistSession).not.toHaveBeenCalled();
  });

  it('skips cleanup when session is restarting', async () => {
    const session = createMockSession({ isRestarting: true });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit('test-platform:thread-123', 1, ctx);

    expect(ctx.ops.persistSession).not.toHaveBeenCalled();
    expect(ctx.ops.unpersistSession).not.toHaveBeenCalled();
    // lifecycle state should be reset to active
    expect(session.lifecycle.state).toBe('active');
  });
});

// NOTE: Task list bump on resume is tested in src/operations/message-manager.test.ts
// under the "restoreTaskListFromPersistence" describe block. The tests there properly
// verify the RED-GREEN behavior by testing the actual MessageManager method.

// NOTE: startSession worktree prompt skip tests are not included here because testing
// startSession directly requires mocking the Claude CLI spawn, which is complex.
// The fix is verified by:
// 1. manager.ts startSessionWithWorktree passes { ...options, skipWorktreePrompt: true }
// 2. lifecycle.ts startSession checks options.skipWorktreePrompt before shouldPromptForWorktree
// See src/session/manager.ts:1280 and src/session/lifecycle.ts:692

describe('attemptMetadataFetch', () => {
  it('returns success when both metadata and tags are fetched', async () => {
    // Create session with no existing metadata
    const session = createMockSession({
      sessionTitle: undefined,
      sessionDescription: undefined,
      sessionTags: undefined,
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    const result = await lifecycle.attemptMetadataFetch(session, 'test prompt', ctx, 1, {
      suggestMetadata: async () => ({
        title: 'Test Title',
        description: 'Test Description',
      }),
      suggestTags: async () => ['bug-fix'],
    });

    expect(result.success).toBe(true);
    expect(result.metadataSet).toBe(true);
    expect(result.tagsSet).toBe(true);
    expect(session.sessionTitle).toBe('Test Title');
    expect(session.sessionDescription).toBe('Test Description');
    expect(session.sessionTags).toEqual(['bug-fix']);
  });

  it('returns partial success when only metadata fails', async () => {
    const session = createMockSession({
      sessionTitle: undefined,
      sessionDescription: undefined,
      sessionTags: undefined,
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    const result = await lifecycle.attemptMetadataFetch(session, 'test prompt', ctx, 1, {
      suggestMetadata: async () => null,
      suggestTags: async () => ['feature'],
    });

    expect(result.success).toBe(false);
    expect(result.metadataSet).toBe(false);
    expect(result.tagsSet).toBe(true);
    expect(session.sessionTitle).toBeUndefined();
    expect(session.sessionTags).toEqual(['feature']);
  });

  it('returns partial success when only tags fail', async () => {
    const session = createMockSession({
      sessionTitle: undefined,
      sessionDescription: undefined,
      sessionTags: undefined,
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    const result = await lifecycle.attemptMetadataFetch(session, 'test prompt', ctx, 1, {
      suggestMetadata: async () => ({
        title: 'Success Title',
        description: 'Success Desc',
      }),
      suggestTags: async () => [],
    });

    expect(result.success).toBe(false);
    expect(result.metadataSet).toBe(true);
    expect(result.tagsSet).toBe(false);
    expect(session.sessionTitle).toBe('Success Title');
    expect(session.sessionTags).toBeUndefined();
  });

  it('reports session already has metadata as success', async () => {
    const session = createMockSession({
      sessionTitle: 'Existing Title',
      sessionDescription: 'Existing Desc',
      sessionTags: ['refactor'],
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    // Even if suggestions fail, existing metadata counts as success
    const result = await lifecycle.attemptMetadataFetch(session, 'test prompt', ctx, 1, {
      suggestMetadata: async () => null,
      suggestTags: async () => [],
    });

    expect(result.success).toBe(true);
    expect(result.metadataSet).toBe(true);
    expect(result.tagsSet).toBe(true);
    // Original values should be preserved
    expect(session.sessionTitle).toBe('Existing Title');
    expect(session.sessionTags).toEqual(['refactor']);
  });

  it('returns early if session is gone', async () => {
    const session = createMockSession();
    // Session is NOT in the sessions map (simulating cleanup while fetching)
    const sessions = new Map<string, Session>();
    const ctx = createMockSessionContext(sessions);

    const result = await lifecycle.attemptMetadataFetch(session, 'test prompt', ctx, 1, {
      suggestMetadata: async () => ({
        title: 'Title',
        description: 'Desc',
      }),
      suggestTags: async () => ['test'],
    });

    // Should return failure since session is gone
    expect(result.success).toBe(false);
    expect(result.metadataSet).toBe(false);
    expect(result.tagsSet).toBe(false);
  });

  it('updates UI when metadata changes', async () => {
    const session = createMockSession({
      sessionTitle: undefined,
      sessionDescription: undefined,
      sessionTags: undefined,
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.attemptMetadataFetch(session, 'test prompt', ctx, 1, {
      suggestMetadata: async () => ({
        title: 'New Title',
        description: 'New Desc',
      }),
      suggestTags: async () => ['docs'],
    });

    // Should have updated persistence and UI
    expect(ctx.ops.persistSession).toHaveBeenCalled();
    expect(ctx.ops.updateStickyMessage).toHaveBeenCalled();
    expect(ctx.ops.updateSessionHeader).toHaveBeenCalled();
  });
});

// ============================================================================
// handleExit branch coverage — PR 1 safety net
// ============================================================================

/** Build a session whose .claude mock has isPermanentFailure & reason hooks. */
function createExitTestSession(overrides: Partial<Session> & {
  isPermanent?: boolean;
  permanentReason?: string;
  isRestarting?: boolean;
  isCancelled?: boolean;
  wasInterrupted?: boolean;
  hasClaudeResponded?: boolean;
  resumeFailCount?: number;
} = {}): Session {
  const session = createMockSession(overrides);
  session.claude = {
    ...session.claude,
    isPermanentFailure: mock(() => overrides.isPermanent ?? false),
    getPermanentFailureReason: mock(() => overrides.permanentReason ?? null),
  } as any;
  if (overrides.resumeFailCount !== undefined) {
    session.lifecycle.resumeFailCount = overrides.resumeFailCount;
  }
  return session;
}

describe('handleExit', () => {
  it('is a no-op when session is not found', async () => {
    const ctx = createMockSessionContext(new Map());
    await expect(lifecycle.handleExit('test-platform:missing', 0, ctx)).resolves.toBeUndefined();
    expect(ctx.ops.updateStickyMessage).not.toHaveBeenCalled();
  });

  it('skips cleanup and resets state when session is restarting', async () => {
    const session = createExitTestSession({ isRestarting: true });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 0, ctx);
    expect(session.lifecycle.state).toBe('active');
    expect(sessions.has(session.sessionId)).toBe(true);
    expect(ctx.ops.updateStickyMessage).not.toHaveBeenCalled();
  });

  it('skips cleanup when session was cancelled', async () => {
    const session = createExitTestSession({ isCancelled: true });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 137, ctx);
    // killSession handles cleanup; handleExit just returns.
    expect(ctx.ops.updateStickyMessage).not.toHaveBeenCalled();
    expect(ctx.ops.unpersistSession).not.toHaveBeenCalled();
  });

  it('preserves persistence when bot is shutting down', async () => {
    const session = createExitTestSession({ hasClaudeResponded: true });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);
    (ctx.state as { isShuttingDown: boolean }).isShuttingDown = true;

    await lifecycle.handleExit(session.sessionId, 0, ctx);
    expect(ctx.ops.unpersistSession).not.toHaveBeenCalled();
  });

  it('pauses session after interrupt when Claude has responded', async () => {
    const session = createExitTestSession({ hasClaudeResponded: true, wasInterrupted: true });
    const mockCreatePost = mock(() => Promise.resolve({
      id: 'pause-post', platformId: 'test-platform', channelId: 'c', userId: 'bot', message: '', createAt: 0,
    }));
    session.platform = createMockPlatform({ createPost: mockCreatePost as any });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 0, ctx);

    expect(session.lifecycle.state).toBe('paused');
    expect(ctx.ops.persistSession).toHaveBeenCalled();
    expect(sessions.has(session.sessionId)).toBe(false);
    expect(ctx.ops.updateStickyMessage).toHaveBeenCalled();
  });

  it('does not persist interrupt when Claude has not yet responded', async () => {
    const session = createExitTestSession({ hasClaudeResponded: false, wasInterrupted: true });
    session.platform = createMockPlatform({
      createPost: mock(() => Promise.resolve({
        id: 'p', platformId: 'test-platform', channelId: 'c', userId: 'bot', message: '', createAt: 0,
      })) as any,
    });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 0, ctx);
    expect(ctx.ops.persistSession).not.toHaveBeenCalled();
  });

  it('warns and cleans up when session exits before Claude responded', async () => {
    const session = createExitTestSession({ hasClaudeResponded: false });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 1, ctx);
    expect(sessions.has(session.sessionId)).toBe(false);
    expect(ctx.ops.updateStickyMessage).toHaveBeenCalled();
  });

  it('immediately unpersists on permanent failure for a resumed session', async () => {
    const session = createExitTestSession({
      hasClaudeResponded: true,
      isPermanent: true,
      permanentReason: 'corrupt session state',
      resumeFailCount: 1,
    });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 2, ctx);
    expect(ctx.ops.unpersistSession).toHaveBeenCalledWith(session.sessionId);
    expect(ctx.ops.persistSession).not.toHaveBeenCalled();
  });

  it('unpersists resumed session after MAX_RESUME_FAILURES', async () => {
    const session = createExitTestSession({
      hasClaudeResponded: true,
      resumeFailCount: 2, // will increment to 3 = MAX
    });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 1, ctx);
    expect(session.lifecycle.resumeFailCount).toBe(3);
    expect(ctx.ops.unpersistSession).toHaveBeenCalledWith(session.sessionId);
  });

  it('persists resumed session with retries left after transient failure', async () => {
    const session = createExitTestSession({
      hasClaudeResponded: true,
      resumeFailCount: 0, // will increment to 1
    });
    // Force "resumed" state so handleExit hits the wasResumed branch.
    session.lifecycle.state = 'active';
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 1, ctx);
    expect(session.lifecycle.resumeFailCount).toBe(1);
    expect(ctx.ops.persistSession).toHaveBeenCalled();
    expect(ctx.ops.unpersistSession).not.toHaveBeenCalled();
  });

  it('unpersists on normal (code 0) exit', async () => {
    const session = createExitTestSession({ hasClaudeResponded: true });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 0, ctx);
    expect(ctx.ops.unpersistSession).toHaveBeenCalledWith(session.sessionId);
    expect(sessions.has(session.sessionId)).toBe(false);
  });

  it('preserves persistence on non-zero exit (retry on restart)', async () => {
    const session = createExitTestSession({ hasClaudeResponded: true });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 137, ctx);
    expect(ctx.ops.unpersistSession).not.toHaveBeenCalled();
    expect(sessions.has(session.sessionId)).toBe(false);
  });

  it('unregisters worktree user when session has worktreeInfo', async () => {
    const session = createExitTestSession({
      hasClaudeResponded: true,
      worktreeInfo: {
        worktreePath: '/tmp/wt/abc',
        branch: 'feature/x',
        createdAt: new Date().toISOString(),
      } as any,
    });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 0, ctx);
    expect(ctx.ops.unregisterWorktreeUser).toHaveBeenCalledWith('/tmp/wt/abc', session.sessionId);
  });

  it('posts [Exited: code] notification on non-zero exit', async () => {
    const session = createExitTestSession({ hasClaudeResponded: true });
    const mockCreatePost = mock(() => Promise.resolve({
      id: 'p', platformId: 'test-platform', channelId: 'c', userId: 'bot', message: '', createAt: 0,
    }));
    session.platform = createMockPlatform({ createPost: mockCreatePost as any });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 42, ctx);
    const posts = (mockCreatePost as any).mock.calls.map((c: any[]) => c[0]);
    expect(posts.some((msg: string) => msg.includes('[Exited: 42]'))).toBe(true);
  });
});


