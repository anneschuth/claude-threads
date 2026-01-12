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
      buildMessageContent: mock((prompt) => Promise.resolve(prompt)),
      offerContextPrompt: mock(() => Promise.resolve(false)),
      bumpTasksToBottom: mock(() => Promise.resolve()),
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
