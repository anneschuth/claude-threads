import { describe, it, expect, mock } from 'bun:test';
import * as commands from './handler.js';
import type { SessionContext } from '../session-context/index.js';
import type { Session } from '../../session/types.js';
import { createSessionTimers, createSessionLifecycle } from '../../session/types.js';
import type { PlatformClient } from '../../platform/index.js';
import { createMockFormatter } from '../../test-utils/mock-formatter.js';

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
    getUserByUsername: mock(() => Promise.resolve({ id: 'user-1', username: 'testuser' })),
    isUserAllowed: mock(() => false),
    connect: mock(() => Promise.resolve()),
    disconnect: mock(() => {}),
    getMcpConfig: mock(() => ({ type: 'mattermost', url: '', token: '', channelId: '', allowedUsers: [] })),
    createInteractivePost: mock(() => Promise.resolve({ id: 'post-1', message: '', userId: 'bot' })),
    getThreadHistory: mock(() => Promise.resolve([])),
    pinPost: mock(() => Promise.resolve()),
    unpinPost: mock(() => Promise.resolve()),
    getPinnedPosts: mock(() => Promise.resolve([])),
    getPost: mock(() => Promise.resolve(null)),
    isBotMentioned: mock(() => false),
    extractPrompt: mock((msg: string) => msg),
    getBotName: mock(() => 'testbot'),
    getFormatter: mock(() => createMockFormatter()),
    sendTyping: mock(() => {}),
    on: mock(() => {}),
    emit: mock(() => true),
    ...overrides,
  } as unknown as PlatformClient;
}

/**
 * Create a mock message manager for testing
 */
function createMockMessageManager(initialApproval?: { postId: string; type: string; toolUseId: string } | null, initialQuestionSet?: any) {
  let pendingApproval = initialApproval ?? null;
  let pendingQuestionSet = initialQuestionSet ?? null;
  return {
    getPendingApproval: () => pendingApproval,
    clearPendingApproval: () => { pendingApproval = null; },
    getPendingQuestionSet: () => pendingQuestionSet,
    clearPendingQuestionSet: () => { pendingQuestionSet = null; },
  } as any;
}

/**
 * Create a mock session for testing
 */
function createMockSession(overrides?: Partial<Session> & { pendingApproval?: { postId: string; type: string; toolUseId: string } | null; pendingQuestionSet?: any }): Session {
  // Extract pendingApproval and pendingQuestionSet from overrides to create messageManager
  const { pendingApproval, pendingQuestionSet, ...restOverrides } = overrides ?? {};
  const messageManager = createMockMessageManager(pendingApproval, pendingQuestionSet);

  return {
    sessionId: 'test-platform:thread-123',
    platformId: 'test-platform',
    threadId: 'thread-123',
    platform: createMockPlatform(),
    claude: {
      isRunning: mock(() => true),
      kill: mock(() => {}),
      start: mock(() => {}),
      sendMessage: mock(() => {}),
      on: mock(() => {}),
      interrupt: mock(() => true),
    } as any,
    claudeSessionId: 'claude-session-1',
    startedBy: 'testuser',
    startedAt: new Date(),
    lastActivityAt: new Date(),
    sessionNumber: 1,
    sessionAllowedUsers: new Set(['testuser']),
    workingDir: '/test',
    sessionStartPostId: 'start-post-id',
    currentPostContent: '',
    currentPostId: null,
    timeoutWarningPosted: false,
    tasksCompleted: false,
    tasksMinimized: false,
    lastTasksContent: null,
    tasksPostId: null,
    forceInteractivePermissions: false,
    planApproved: false,
    pendingApproval: null,
    pendingQuestionSet: null,
    messageCount: 0,
    messageManager,
    timers: createSessionTimers(),
    lifecycle: createSessionLifecycle(),
    ...restOverrides,
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

describe('inviteUser', () => {
  it('adds user to session when they exist', async () => {
    const mockPlatform = createMockPlatform({
      getUserByUsername: mock(() => Promise.resolve({ id: 'user-2', username: 'newuser' })),
    });
    const session = createMockSession({ platform: mockPlatform });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.inviteUser(session, 'newuser', 'testuser', ctx);

    expect(session.sessionAllowedUsers.has('newuser')).toBe(true);
    expect(mockPlatform.createPost).toHaveBeenCalledWith(
      expect.stringContaining('@newuser can now participate'),
      session.threadId
    );
  });

  it('shows warning when user does not exist', async () => {
    const mockPlatform = createMockPlatform({
      getUserByUsername: mock(() => Promise.resolve(null)),
    });
    const session = createMockSession({ platform: mockPlatform });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.inviteUser(session, 'nonexistent', 'testuser', ctx);

    expect(session.sessionAllowedUsers.has('nonexistent')).toBe(false);
    expect(mockPlatform.createPost).toHaveBeenCalledWith(
      expect.stringContaining('does not exist'),
      session.threadId
    );
  });

  it('rejects invite from non-owner', async () => {
    const mockPlatform = createMockPlatform({
      getUserByUsername: mock(() => Promise.resolve({ id: 'user-2', username: 'newuser' })),
      isUserAllowed: mock(() => false),
    });
    const session = createMockSession({ platform: mockPlatform });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.inviteUser(session, 'newuser', 'otheruser', ctx);

    expect(session.sessionAllowedUsers.has('newuser')).toBe(false);
    expect(mockPlatform.createPost).toHaveBeenCalledWith(
      expect.stringContaining('Only @testuser'),
      session.threadId
    );
  });
});

describe('kickUser', () => {
  it('removes user from session when they exist', async () => {
    const mockPlatform = createMockPlatform({
      getUserByUsername: mock(() => Promise.resolve({ id: 'user-2', username: 'inviteduser' })),
    });
    const session = createMockSession({ platform: mockPlatform });
    session.sessionAllowedUsers.add('inviteduser');
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.kickUser(session, 'inviteduser', 'testuser', ctx);

    expect(session.sessionAllowedUsers.has('inviteduser')).toBe(false);
    expect(mockPlatform.createPost).toHaveBeenCalledWith(
      expect.stringContaining('@inviteduser removed'),
      session.threadId
    );
  });

  it('shows warning when user does not exist', async () => {
    const mockPlatform = createMockPlatform({
      getUserByUsername: mock(() => Promise.resolve(null)),
    });
    const session = createMockSession({ platform: mockPlatform });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.kickUser(session, 'nonexistent', 'testuser', ctx);

    expect(mockPlatform.createPost).toHaveBeenCalledWith(
      expect.stringContaining('does not exist'),
      session.threadId
    );
  });

  it('cannot kick session owner', async () => {
    const mockPlatform = createMockPlatform({
      getUserByUsername: mock(() => Promise.resolve({ id: 'user-1', username: 'testuser' })),
    });
    const session = createMockSession({ platform: mockPlatform });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.kickUser(session, 'testuser', 'testuser', ctx);

    // Should still be in allowed users
    expect(session.sessionAllowedUsers.has('testuser')).toBe(true);
    expect(mockPlatform.createPost).toHaveBeenCalledWith(
      expect.stringContaining('Cannot kick session owner'),
      session.threadId
    );
  });

  it('cannot kick globally allowed users', async () => {
    const mockPlatform = createMockPlatform({
      getUserByUsername: mock(() => Promise.resolve({ id: 'user-2', username: 'globaluser' })),
      isUserAllowed: mock((username: string) => username === 'globaluser'),
    });
    const session = createMockSession({ platform: mockPlatform });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.kickUser(session, 'globaluser', 'testuser', ctx);

    expect(mockPlatform.createPost).toHaveBeenCalledWith(
      expect.stringContaining('globally allowed'),
      session.threadId
    );
  });

  it('shows warning when user was not in session', async () => {
    const mockPlatform = createMockPlatform({
      getUserByUsername: mock(() => Promise.resolve({ id: 'user-2', username: 'someuser' })),
    });
    const session = createMockSession({ platform: mockPlatform });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.kickUser(session, 'someuser', 'testuser', ctx);

    expect(mockPlatform.createPost).toHaveBeenCalledWith(
      expect.stringContaining('was not in this session'),
      session.threadId
    );
  });
});

describe('cancelSession', () => {
  it('kills the session and posts cancellation message', async () => {
    const mockPlatform = createMockPlatform();
    const session = createMockSession({ platform: mockPlatform });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.cancelSession(session, 'testuser', ctx);

    expect(session.lifecycle.state).toBe('cancelling');
    expect(mockPlatform.createPost).toHaveBeenCalledWith(
      expect.stringContaining('Session cancelled'),
      session.threadId
    );
    expect(ctx.ops.killSession).toHaveBeenCalledWith(session.threadId);
  });
});

describe('interruptSession', () => {
  it('interrupts a running session', async () => {
    const mockPlatform = createMockPlatform();
    const session = createMockSession({ platform: mockPlatform });

    await commands.interruptSession(session, 'testuser');

    expect(session.lifecycle.state).toBe('interrupted');
    expect(session.claude.interrupt).toHaveBeenCalled();
    expect(mockPlatform.createPost).toHaveBeenCalledWith(
      expect.stringContaining('Interrupted'),
      session.threadId
    );
  });

  it('does nothing when session is idle', async () => {
    const mockPlatform = createMockPlatform();
    const session = createMockSession({
      platform: mockPlatform,
      claude: {
        isRunning: mock(() => false),
        interrupt: mock(() => false),
      } as any,
    });

    await commands.interruptSession(session, 'testuser');

    expect(mockPlatform.createPost).toHaveBeenCalledWith(
      expect.stringContaining('idle'),
      session.threadId
    );
  });
});

describe('approvePendingPlan', () => {
  it('approves pending plan and sends message to Claude', async () => {
    const mockPlatform = createMockPlatform();
    const session = createMockSession({
      platform: mockPlatform,
      pendingApproval: { postId: 'plan-post-1', type: 'plan', toolUseId: 'tool-1' },
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.approvePendingPlan(session, 'testuser', ctx);

    // Should update the approval post
    expect(mockPlatform.updatePost).toHaveBeenCalledWith(
      'plan-post-1',
      expect.stringContaining('Plan approved')
    );

    // Should clear the pending approval (via messageManager)
    expect(session.messageManager?.getPendingApproval()).toBeNull();

    // Should mark as approved
    expect(session.planApproved).toBe(true);

    // Should send message to Claude
    expect(session.claude.sendMessage).toHaveBeenCalledWith(
      'Plan approved! Please proceed with the implementation.'
    );

    // Should start typing
    expect(ctx.ops.startTyping).toHaveBeenCalledWith(session);
  });

  it('shows info message when no pending plan', async () => {
    const mockPlatform = createMockPlatform();
    const session = createMockSession({
      platform: mockPlatform,
      pendingApproval: null,
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.approvePendingPlan(session, 'testuser', ctx);

    // Should post info message
    expect(mockPlatform.createPost).toHaveBeenCalledWith(
      expect.stringContaining('No pending plan'),
      session.threadId
    );

    // Should not update any post
    expect(mockPlatform.updatePost).not.toHaveBeenCalled();
  });

  it('does not approve non-plan pending approval', async () => {
    const mockPlatform = createMockPlatform();
    const session = createMockSession({
      platform: mockPlatform,
      pendingApproval: { postId: 'action-post-1', type: 'action', toolUseId: 'tool-1' },
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.approvePendingPlan(session, 'testuser', ctx);

    // Should show "no pending plan" info since it's an action, not a plan
    expect(mockPlatform.createPost).toHaveBeenCalledWith(
      expect.stringContaining('No pending plan'),
      session.threadId
    );

    // Should not clear the action pending approval (via messageManager)
    expect(session.messageManager?.getPendingApproval()).not.toBeNull();
  });

  it('does not send message if Claude is not running', async () => {
    const mockPlatform = createMockPlatform();
    const session = createMockSession({
      platform: mockPlatform,
      pendingApproval: { postId: 'plan-post-1', type: 'plan', toolUseId: 'tool-1' },
      claude: {
        isRunning: mock(() => false),
        kill: mock(() => {}),
        start: mock(() => {}),
        sendMessage: mock(() => {}),
        on: mock(() => {}),
        interrupt: mock(() => false),
      } as any,
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.approvePendingPlan(session, 'testuser', ctx);

    // Should still clear and mark approved (via messageManager)
    expect(session.messageManager?.getPendingApproval()).toBeNull();
    expect(session.planApproved).toBe(true);

    // Should not send message since Claude not running
    expect(session.claude.sendMessage).not.toHaveBeenCalled();
    expect(ctx.ops.startTyping).not.toHaveBeenCalled();
  });

  it('clears stale pendingQuestionSet when approving plan', async () => {
    const mockPlatform = createMockPlatform();
    const session = createMockSession({
      platform: mockPlatform,
      pendingApproval: { postId: 'plan-post-1', type: 'plan', toolUseId: 'tool-1' },
      // Simulate a stale question from plan mode
      pendingQuestionSet: {
        toolUseId: 'oldTool',
        questions: [{ header: 'Stale', question: 'Old?', options: [{ label: 'A', description: 'Desc' }], answer: null }],
        currentIndex: 0,
        currentPostId: 'oldPost',
      },
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.approvePendingPlan(session, 'testuser', ctx);

    // Should clear pending approval (via messageManager)
    expect(session.messageManager?.getPendingApproval()).toBeNull();
    // Should clear stale questions (via messageManager)
    expect(session.messageManager?.getPendingQuestionSet()).toBeNull();
    // Should mark as approved
    expect(session.planApproved).toBe(true);
  });
});
