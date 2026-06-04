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
    respondOnlyWhenMentioned: false,
    planApproved: false,
    pendingApproval: null,
    pendingQuestionSet: null,
    messageCount: 0,
    messageManager,
    sessionHeaderMode: 'full' as const,
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
      permissionMode: 'bypass',
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
      githubEmailsStore: {
        get: mock(() => undefined),
        set: mock(() => {}),
        delete: mock(() => false),
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
      getPlatformOverhead: mock(() => ({ sessionHeader: 'full' as const, stickyMessage: 'full' as const })),
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

  it('posts a "Collaborators updated" notice listing the invitee when they have a registered noreply email', async () => {
    // Regression-defender: this notice is the contract that lets Claude pick
    // up the current co-author list mid-session. The email comes from the
    // local store (self-registered via !github-email), NOT from the platform.
    const mockPlatform = createMockPlatform({
      getUserByUsername: mock(() => Promise.resolve({
        id: 'user-2', username: 'newuser', displayName: 'New User',
      })),
    });
    const session = createMockSession({ platform: mockPlatform });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);
    (ctx.state.githubEmailsStore.get as any).mockImplementation(
      (_: string, u: string) => u === 'newuser' ? '111+newuser@users.noreply.github.com' : undefined,
    );

    await commands.inviteUser(session, 'newuser', 'testuser', ctx);

    const calls = (mockPlatform.createPost as any).mock.calls.map((c: any[]) => c[0]);
    const notice = calls.find((m: string) => m.includes('Collaborators updated'));
    expect(notice).toBeTruthy();
    expect(notice).toContain('New User <111+newuser@users.noreply.github.com>');
  });

  it('posts a "no co-authors" notice when the invitee has not registered a noreply email yet', async () => {
    // No registration → not co-authorable. The notice must be posted anyway
    // so an older notice (from a previous invite) does not keep applying.
    const mockPlatform = createMockPlatform({
      getUserByUsername: mock(() => Promise.resolve({ id: 'user-2', username: 'newuser' })),
    });
    const session = createMockSession({ platform: mockPlatform });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.inviteUser(session, 'newuser', 'testuser', ctx);

    const calls = (mockPlatform.createPost as any).mock.calls.map((c: any[]) => c[0]);
    const notice = calls.find((m: string) => m.includes('Collaborators updated'));
    expect(notice).toBeTruthy();
    expect(notice).toContain('no co-authors');
  });

  it('posts the !github-email onboarding nudge when the invitee has not registered yet', async () => {
    // Regression-defender: without this nudge, the new collaborator has no
    // visible signal that they need to register, and silently never gets
    // co-author credit. The link to settings + the !github-email command
    // give them a clear, in-thread path forward.
    const mockPlatform = createMockPlatform({
      getUserByUsername: mock(() => Promise.resolve({ id: 'user-2', username: 'newuser' })),
    });
    const session = createMockSession({ platform: mockPlatform });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.inviteUser(session, 'newuser', 'testuser', ctx);

    const calls = (mockPlatform.createPost as any).mock.calls.map((c: any[]) => c[0]);
    const nudge = calls.find((m: string) => m.includes('!github-email'));
    expect(nudge).toBeTruthy();
    expect(nudge).toContain('https://github.com/settings/emails');
    expect(nudge).toContain('@newuser');
  });

  it('does not nudge an invitee who has already registered a noreply email', async () => {
    // Quietness matters: a thread with a long-running collaboration shouldn't
    // re-paste the registration instructions for someone who has self-registered.
    const mockPlatform = createMockPlatform({
      getUserByUsername: mock(() => Promise.resolve({ id: 'user-2', username: 'newuser' })),
    });
    const session = createMockSession({ platform: mockPlatform });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);
    (ctx.state.githubEmailsStore.get as any).mockImplementation(
      (_: string, u: string) => u === 'newuser' ? '111+newuser@users.noreply.github.com' : undefined,
    );

    await commands.inviteUser(session, 'newuser', 'testuser', ctx);

    const calls = (mockPlatform.createPost as any).mock.calls.map((c: any[]) => c[0]);
    const nudge = calls.find((m: string) => m.includes('!github-email'));
    expect(nudge).toBeFalsy();
  });

  it('persists the session BEFORE the in-thread chat notices run', async () => {
    // Regression-defender: in an earlier draft, the chat-side notice ran
    // before persistSession. If that post threw (network error), the invitee
    // was added to the in-memory set but never written to disk — so a bot
    // restart would silently drop them. Verifies call ordering, not failure
    // semantics, by tracking the call sequence.
    const callOrder: string[] = [];
    const mockPlatform = createMockPlatform({
      getUserByUsername: mock(() => Promise.resolve({ id: 'user-2', username: 'newuser' })),
      createPost: mock((message: string) => {
        callOrder.push(`createPost:${message.substring(0, 30)}`);
        return Promise.resolve({
          id: 'post-x',
          platformId: 'test-platform',
          channelId: 'test-channel',
          userId: 'bot',
          message,
        });
      }),
    });
    const session = createMockSession({ platform: mockPlatform });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);
    (ctx.ops.persistSession as any).mockImplementation(() => callOrder.push('persistSession'));

    await commands.inviteUser(session, 'newuser', 'testuser', ctx);

    const persistIdx = callOrder.indexOf('persistSession');
    const noticeIdx = callOrder.findIndex(s => s.startsWith('createPost:🔑') || s.startsWith('createPost:📝'));
    expect(persistIdx).toBeGreaterThan(-1);
    expect(noticeIdx).toBeGreaterThan(-1);
    expect(persistIdx).toBeLessThan(noticeIdx);
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

  it('persists the session BEFORE the in-thread chat notices run', async () => {
    // Mirror of the invite test: a network failure on the chat-side notice
    // must not roll back the kick. Without this, the kicked user comes back
    // alive on bot restart because disk still has them in sessionAllowedUsers.
    const callOrder: string[] = [];
    const mockPlatform = createMockPlatform({
      getUserByUsername: mock(() => Promise.resolve({ id: 'user-2', username: 'inviteduser' })),
      createPost: mock((message: string) => {
        callOrder.push(`createPost:${message.substring(0, 30)}`);
        return Promise.resolve({
          id: 'post-x',
          platformId: 'test-platform',
          channelId: 'test-channel',
          userId: 'bot',
          message,
        });
      }),
    });
    const session = createMockSession({ platform: mockPlatform });
    session.sessionAllowedUsers.add('inviteduser');
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);
    (ctx.ops.persistSession as any).mockImplementation(() => callOrder.push('persistSession'));

    await commands.kickUser(session, 'inviteduser', 'testuser', ctx);

    const persistIdx = callOrder.indexOf('persistSession');
    const noticeIdx = callOrder.findIndex(s => s.startsWith('createPost:📝'));
    expect(persistIdx).toBeGreaterThan(-1);
    expect(noticeIdx).toBeGreaterThan(-1);
    expect(persistIdx).toBeLessThan(noticeIdx);
  });

  it('posts a "Collaborators updated" notice after a successful kick so Claude drops the kicked co-author', async () => {
    // Regression-defender: without this, the previous "Collaborators updated"
    // notice (with the now-kicked user) would keep applying to future commits.
    const inviteePlatform = createMockPlatform({
      getUserByUsername: mock(() => Promise.resolve({
        id: 'user-2', username: 'inviteduser', displayName: 'Invited', email: 'inv@example.com',
      })),
    });
    const session = createMockSession({ platform: inviteePlatform });
    session.sessionAllowedUsers.add('inviteduser');
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.kickUser(session, 'inviteduser', 'testuser', ctx);

    const calls = (inviteePlatform.createPost as any).mock.calls.map((c: any[]) => c[0]);
    const notice = calls.find((m: string) => m.includes('Collaborators updated'));
    expect(notice).toBeTruthy();
    expect(notice).toContain('no co-authors');
  });
});

describe('setGitHubEmail', () => {
  function makeCtx() {
    const session = createMockSession();
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);
    return { session, ctx, platform: session.platform };
  }

  it('shows current registration when called without args', async () => {
    const { session, ctx, platform } = makeCtx();
    (ctx.state.githubEmailsStore.get as any).mockReturnValue('111+testuser@users.noreply.github.com');

    await commands.setGitHubEmail(session, 'testuser', undefined, ctx);

    const calls = (platform.createPost as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.find((m: string) => m.includes('111+testuser@users.noreply.github.com'))).toBeTruthy();
  });

  it('shows the registration instructions when not registered yet', async () => {
    const { session, ctx, platform } = makeCtx();
    (ctx.state.githubEmailsStore.get as any).mockReturnValue(undefined);

    await commands.setGitHubEmail(session, 'testuser', undefined, ctx);

    const calls = (platform.createPost as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.find((m: string) =>
      m.includes('!github-email') && m.includes('https://github.com/settings/emails'),
    )).toBeTruthy();
  });

  it('rejects an obviously-not-a-noreply address with a clear message', async () => {
    const { session, ctx, platform } = makeCtx();

    await commands.setGitHubEmail(session, 'testuser', 'testuser@example.com', ctx);

    expect(ctx.state.githubEmailsStore.set).not.toHaveBeenCalled();
    const calls = (platform.createPost as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.find((m: string) =>
      m.includes("doesn't look like") || m.includes('does not look like'),
    )).toBeTruthy();
  });

  it('persists a valid noreply email and confirms', async () => {
    const { session, ctx, platform } = makeCtx();

    await commands.setGitHubEmail(
      session,
      'testuser',
      '12345+testuser@users.noreply.github.com',
      ctx,
    );

    expect(ctx.state.githubEmailsStore.set).toHaveBeenCalledWith(
      'test-platform',
      'testuser',
      '12345+testuser@users.noreply.github.com',
    );
    const calls = (platform.createPost as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.find((m: string) =>
      m.includes('registered') && m.includes('12345+testuser@users.noreply.github.com'),
    )).toBeTruthy();
  });

  it('removes the registration on `reset`', async () => {
    const { session, ctx, platform } = makeCtx();
    (ctx.state.githubEmailsStore.delete as any).mockReturnValue(true);

    await commands.setGitHubEmail(session, 'testuser', 'reset', ctx);

    expect(ctx.state.githubEmailsStore.delete).toHaveBeenCalledWith('test-platform', 'testuser');
    const calls = (platform.createPost as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.find((m: string) => m.includes('removed'))).toBeTruthy();
  });

  it('also accepts `clear` as alias for reset', async () => {
    const { session, ctx } = makeCtx();
    (ctx.state.githubEmailsStore.delete as any).mockReturnValue(true);

    await commands.setGitHubEmail(session, 'testuser', 'clear', ctx);

    expect(ctx.state.githubEmailsStore.delete).toHaveBeenCalledWith('test-platform', 'testuser');
  });

  it('isolates registrations per platform (uses session.platformId, not a global key)', async () => {
    // Regression-defender: same username on different platforms must store
    // independently. Verifies the call passes the session's platformId, not
    // (e.g.) a hard-coded 'default' or the username alone.
    const { session, ctx } = makeCtx();
    session.platformId = 'slack-workspace';

    await commands.setGitHubEmail(
      session,
      'testuser',
      '12345+testuser@users.noreply.github.com',
      ctx,
    );

    expect(ctx.state.githubEmailsStore.set).toHaveBeenCalledWith(
      'slack-workspace',
      'testuser',
      '12345+testuser@users.noreply.github.com',
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

// ===========================================================================
// updateSessionHeader — sessionHeaderMode branching
// Issue #383: per-platform sessionHeader visibility (full | minimal | hidden)
// ===========================================================================

describe('updateSessionHeader (sessionHeaderMode)', () => {
  it('full mode posts a key-value table with Directory / Started by / Session ID', async () => {
    const platform = createMockPlatform();
    const session = createMockSession({ platform, sessionHeaderMode: 'full' });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.updateSessionHeader(session, ctx);

    const updatePost = platform.updatePost as ReturnType<typeof mock>;
    expect(updatePost).toHaveBeenCalledTimes(1);
    const [postId, body] = updatePost.mock.calls[0];
    expect(postId).toBe('start-post-id');
    expect(body).toContain('Directory');
    expect(body).toContain('Started by');
    expect(body).toContain('Session ID');
  });

  it('minimal mode posts only the status bar (no table)', async () => {
    const platform = createMockPlatform();
    const session = createMockSession({ platform, sessionHeaderMode: 'minimal' });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.updateSessionHeader(session, ctx);

    const updatePost = platform.updatePost as ReturnType<typeof mock>;
    expect(updatePost).toHaveBeenCalledTimes(1);
    const body = updatePost.mock.calls[0][1] as string;

    // Negative assertions are the load-bearing ones: minimal mode must NOT
    // emit any of the table fields. Anything still in the status bar is
    // shared with `full` and not under test here.
    expect(body).not.toContain('Directory');
    expect(body).not.toContain('Started by');
    expect(body).not.toContain('Session ID');
    expect(body).not.toContain('Log File');

    // Length sanity check: a single status-bar line. Picking a generous
    // cap (table output is well over 300 chars) so format tweaks to the
    // status bar don't ping this test.
    expect(body.length).toBeLessThan(300);
  });

  it('hidden mode does not call updatePost at all', async () => {
    const platform = createMockPlatform();
    const session = createMockSession({ platform, sessionHeaderMode: 'hidden' });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.updateSessionHeader(session, ctx);

    const updatePost = platform.updatePost as ReturnType<typeof mock>;
    expect(updatePost).not.toHaveBeenCalled();
  });

  it('hidden mode is a no-op even when sessionStartPostId is set', async () => {
    // sessionStartPostId may be present on resumed sessions even though
    // hidden mode means we shouldn't update it. Verify the mode wins.
    const platform = createMockPlatform();
    const session = createMockSession({
      platform,
      sessionHeaderMode: 'hidden',
      sessionStartPostId: 'leftover-from-resume',
    });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.updateSessionHeader(session, ctx);

    const updatePost = platform.updatePost as ReturnType<typeof mock>;
    expect(updatePost).not.toHaveBeenCalled();
  });
});

describe('setRespondOnlyWhenMentioned (#402)', () => {
  it('enables quiet mode on "on" and persists', async () => {
    const session = createMockSession();
    expect(session.respondOnlyWhenMentioned).toBe(false);
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.setRespondOnlyWhenMentioned(session, 'testuser', 'on', ctx);

    expect(session.respondOnlyWhenMentioned).toBe(true);
    expect(ctx.ops.persistSession).toHaveBeenCalledWith(session);
  });

  it('disables quiet mode on "off"', async () => {
    const session = createMockSession({ respondOnlyWhenMentioned: true });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.setRespondOnlyWhenMentioned(session, 'testuser', 'off', ctx);

    expect(session.respondOnlyWhenMentioned).toBe(false);
    expect(ctx.ops.persistSession).toHaveBeenCalledWith(session);
  });

  it('bare !mentions toggles the current value', async () => {
    const session = createMockSession({ respondOnlyWhenMentioned: false });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.setRespondOnlyWhenMentioned(session, 'testuser', undefined, ctx);
    expect(session.respondOnlyWhenMentioned).toBe(true);

    await commands.setRespondOnlyWhenMentioned(session, 'testuser', undefined, ctx);
    expect(session.respondOnlyWhenMentioned).toBe(false);
  });

  it('rejects an unauthorized (non-owner, non-allowed) user and does not change state', async () => {
    // mock platform isUserAllowed returns false by default, so a non-owner is unauthorized.
    const session = createMockSession({ respondOnlyWhenMentioned: false });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.setRespondOnlyWhenMentioned(session, 'outsider', 'on', ctx);

    expect(session.respondOnlyWhenMentioned).toBe(false);
    expect(ctx.ops.persistSession).not.toHaveBeenCalled();
  });
});
