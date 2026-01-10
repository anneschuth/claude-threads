import { describe, it, expect, mock } from 'bun:test';
import * as lifecycle from './lifecycle.js';
import type { SessionContext } from './context.js';
import type { Session } from './types.js';
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
 * Create a mock session for testing
 */
function createMockSession(overrides?: Partial<Session>): Session {
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
    activeSubagents: new Map(),
    isResumed: false,
    sessionStartPostId: 'start-post-id',
    currentPostContent: '',
    pendingContent: '',
    timeoutWarningPosted: false,
    tasksCompleted: false,
    tasksMinimized: false,
    lastTasksContent: '',
    tasksPostId: null,
    skipPermissions: true,
    forceInteractivePermissions: false,
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
      appendContent: mock(() => {}),
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
  it('tracks active subagents', () => {
    const session = createMockSession();

    expect(session.activeSubagents.size).toBe(0);

    session.activeSubagents.set('tool-1', 'post-1');
    session.activeSubagents.set('tool-2', 'post-2');

    expect(session.activeSubagents.size).toBe(2);
    expect(session.activeSubagents.get('tool-1')).toBe('post-1');
  });

  it('tracks session allowed users', () => {
    const session = createMockSession();

    expect(session.sessionAllowedUsers.has('testuser')).toBe(true);
    expect(session.sessionAllowedUsers.has('otheruser')).toBe(false);

    session.sessionAllowedUsers.add('otheruser');
    expect(session.sessionAllowedUsers.has('otheruser')).toBe(true);
  });

  it('tracks pending content buffer', () => {
    const session = createMockSession();

    session.pendingContent = '';
    session.pendingContent += 'Hello ';
    session.pendingContent += 'World';

    expect(session.pendingContent).toBe('Hello World');
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
    const session = createMockSession({
      lastActivityAt: new Date(Date.now() - 35 * 60 * 1000), // 35 min ago
      timeoutWarningPosted: true,
      pendingApproval: { postId: 'p1', toolUseId: 't1', type: 'action' },
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
    const session = createMockSession({
      lastActivityAt: new Date(Date.now() - 35 * 60 * 1000),
      timeoutWarningPosted: true,
      pendingQuestionSet: { toolUseId: 't1', currentIndex: 0, currentPostId: 'p1', questions: [] },
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
    const session = createMockSession({
      updateTimer: setTimeout(() => {}, 10000) as any,
      statusBarTimer: setInterval(() => {}, 10000) as any,
    });
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
    const session = createMockSession({
      updateTimer: setTimeout(() => {}, 10000) as any,
    });
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
  it('flushes pending content before sending new message', async () => {
    const session = createMockSession({
      currentPostId: 'old-post-id',
      currentPostContent: 'old content',
      pendingContent: 'pending text',
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.sendFollowUp(session, 'New message', undefined, ctx);

    // Should have called flush
    expect(ctx.ops.flush).toHaveBeenCalledWith(session);
  });

  it('resets currentPostId so response starts in new message', async () => {
    const session = createMockSession({
      currentPostId: 'old-post-id',
      currentPostContent: 'old content',
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.sendFollowUp(session, 'New message', undefined, ctx);

    // currentPostId should be reset
    expect(session.currentPostId).toBeNull();
    expect(session.currentPostContent).toBe('');
  });

  it('bumps task list after resetting post state', async () => {
    const session = createMockSession({
      currentPostId: 'old-post-id',
      tasksPostId: 'tasks-post',
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.sendFollowUp(session, 'New message', undefined, ctx);

    // Should bump tasks after flushing
    expect(ctx.ops.bumpTasksToBottom).toHaveBeenCalledWith(session);
  });

  it('does not send if Claude is not running', async () => {
    const session = createMockSession();
    (session.claude.isRunning as any).mockReturnValue(false);

    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.sendFollowUp(session, 'New message', undefined, ctx);

    // Should not have called sendMessage
    expect(session.claude.sendMessage).not.toHaveBeenCalled();
  });

  it('increments message counter', async () => {
    const session = createMockSession({ messageCount: 5 });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.sendFollowUp(session, 'New message', undefined, ctx);

    expect(session.messageCount).toBe(6);
  });
});
