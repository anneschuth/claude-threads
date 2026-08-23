import { describe, it, expect, mock, afterEach, afterAll } from 'bun:test';

// `updateSessionHeader` (reached by most command handlers) probes the real
// environment: `isGitRepository`/`getCurrentBranch` spawn `git` child
// processes and `formatBatteryStatus` execs `pmset` on macOS. Under machine
// load (parallel test files, CI contention) a fork/exec can stall past the
// per-test budget and flake any test that refreshes the session header.
// Mock the probes out — none of these tests assert git or battery rows.
// Same pattern and caveats as the crossSpawn mock in plugin/handler.test.ts.
// IMPORTANT: snapshot the export VALUES before mocking. Bun's module
// namespaces are live bindings — after mock.module the namespace object
// itself yields the mocks, so restoring "the namespace" would restore the
// mocks. The spread copies the real function values at this moment.
const realWorktree = { ...(await import('../../git/worktree.js')) };
const realBattery = { ...(await import('../../utils/battery.js')) };
mock.module('../../git/worktree.js', () => ({
  ...realWorktree,
  isGitRepository: () => Promise.resolve(false),
  getCurrentBranch: () => Promise.resolve(null),
}));
mock.module('../../utils/battery.js', () => ({
  ...realBattery,
  formatBatteryStatus: () => Promise.resolve(null),
}));

// bun's `mock.module` is process-global and one-way — overwrite with the
// pre-mock value snapshot so later test files in the same process (e.g.
// git/worktree.test.ts) get the real implementations back.
afterAll(() => {
  mock.module('../../git/worktree.js', () => realWorktree);
  mock.module('../../utils/battery.js', () => realBattery);
});

// Dynamic import for clarity of intent — though ordering alone is not what
// makes this work: hoisted static imports load handler.js transitively before
// mock.module runs, and Bun retroactively patches the live bindings of
// already-loaded modules. The mocks apply either way.
const commands = await import('./handler.js');
import type { SessionContext } from '../session-context/index.js';
import type { Session } from '../../session/types.js';
import { createSessionTimers, createSessionLifecycle } from '../../session/types.js';
import type { PlatformClient } from '../../platform/index.js';
import { createMockFormatter } from '../../test-utils/mock-formatter.js';
import { MemoryStore } from '../../memory/store.js';
import { RoutinesStore } from '../../persistence/routines-store.js';
import { WatchesStore } from '../../persistence/watches-store.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
    getMessageLimits: mock(() => ({ maxLength: 16000, hardThreshold: 14000 })),
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
    clearClaudeSessionState: () => {},
    denyPendingBridgeRequests: () => {},
    resolveBridgePlan: () => false,
    getPendingApproval: () => pendingApproval,
    clearPendingApproval: () => { pendingApproval = null; },
    getPendingQuestionSet: () => pendingQuestionSet,
    clearPendingQuestionSet: () => { pendingQuestionSet = null; },
    setPendingRoutinePrompt: mock(() => {}),
    setPendingWatchPrompt: mock(() => {}),
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
      memoryStore: {
        buildChannelMemoryBlock: mock(() => null),
        listChannelEntries: mock(() => []),
        addChannelEntries: mock(() => Promise.resolve({ added: [], duplicates: [], superseded: [] })),
        forgetChannelEntry: mock(() => Promise.resolve({ ok: false, reason: 'empty', matches: [] })),
        clearChannel: mock(() => Promise.resolve()),
        repoMemoryDir: mock(() => '/tmp/test-memory'),
      } as any,
      routinesStore: {
        list: mock(() => []),
        get: mock(() => undefined),
        add: mock(() => Promise.resolve({ ok: true, routine: {} })),
        update: mock(() => Promise.resolve(undefined)),
        remove: mock(() => Promise.resolve(undefined)),
      } as any,
      watchesStore: {
        list: mock(() => []),
        get: mock(() => undefined),
        add: mock(() => Promise.resolve({ ok: true, watch: {} })),
        update: mock(() => Promise.resolve(undefined)),
        remove: mock(() => Promise.resolve(undefined)),
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
      recordSessionStarted: mock(() => {}),
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
      refreshClaudeAccountUsage: mock(async () => {}),
      markClaudeAccountCooling: mock(() => {}),
      getClaudeAccountPoolStatus: mock(() => []),
      getPlatformOverhead: mock(() => ({ sessionHeader: 'full' as const, stickyMessage: 'full' as const })),
      getPlatformMemoryConfig: mock(() => ({ enabled: false, repoLayer: false, channelLayer: false, distillation: false })),
      isRoutinesEnabled: mock(() => true),
      isWatchesEnabled: mock(() => true),
      fireRoutineNow: mock(() => Promise.resolve('ok' as const)),
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

  it('full mode shows the quiet-mode row only when respondOnlyWhenMentioned is on (#402)', async () => {
    const platform = createMockPlatform();

    // Off (default): no quiet-mode row.
    const offSession = createMockSession({ platform, sessionHeaderMode: 'full', respondOnlyWhenMentioned: false });
    await commands.updateSessionHeader(offSession, createMockSessionContext(new Map([[offSession.sessionId, offSession]])));
    const offBody = (platform.updatePost as ReturnType<typeof mock>).mock.calls[0][1] as string;
    expect(offBody).not.toContain('!mentions off');

    // On: the row appears with a hint on how to disable it.
    const onSession = createMockSession({ platform, sessionHeaderMode: 'full', respondOnlyWhenMentioned: true });
    await commands.updateSessionHeader(onSession, createMockSessionContext(new Map([[onSession.sessionId, onSession]])));
    const onBody = (platform.updatePost as ReturnType<typeof mock>).mock.calls[1][1] as string;
    expect(onBody).toContain('!mentions off');
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

describe('restartClaudeSession session-state clearing', () => {
  const withFakeClaudePath = async (fn: () => Promise<void>) => {
    const prev = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = '/nonexistent/claude-binary-for-tests';
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PATH;
      else process.env.CLAUDE_PATH = prev;
    }
  };

  it('awaits the old CLI exit, then clears task/tool state for a fresh session (resume: false)', async () => {
    await withFakeClaudePath(async () => {
      const order: string[] = [];
      const session = createMockSession();
      // kill resolves asynchronously — the clear must happen strictly after,
      // or late events from the dying process would repopulate the state
      (session.claude as unknown as { kill: unknown }).kill = mock(
        () => new Promise<void>(resolve => setTimeout(() => { order.push('kill-done'); resolve(); }, 5))
      );
      (session.messageManager as unknown as { clearClaudeSessionState: unknown }).clearClaudeSessionState =
        mock(() => order.push('clear'));
      const ctx = createMockSessionContext(new Map([[session.sessionId, session]]));

      await commands.restartClaudeSession(
        session,
        { workingDir: '/tmp', resume: false } as never,
        ctx,
        'test restart'
      );

      expect(order).toEqual(['kill-done', 'clear']);
    });
  });

  it('keeps task/tool state on resume restarts (e.g. !permissions)', async () => {
    await withFakeClaudePath(async () => {
      const session = createMockSession();
      (session.claude as unknown as { kill: unknown }).kill = mock(() => Promise.resolve());
      const clearSpy = mock(() => {});
      (session.messageManager as unknown as { clearClaudeSessionState: unknown }).clearClaudeSessionState =
        clearSpy;
      const ctx = createMockSessionContext(new Map([[session.sessionId, session]]));

      await commands.restartClaudeSession(
        session,
        { workingDir: '/tmp', resume: true } as never,
        ctx,
        'test restart'
      );

      expect(clearSpy).not.toHaveBeenCalled();
    });
  });
});

describe('approvePendingPlan with a pending decision-bridge request', () => {
  it('resolves the bridge and does NOT send the stdin message', async () => {
    const mockPlatform = createMockPlatform();
    const session = createMockSession({
      platform: mockPlatform,
      pendingApproval: { postId: 'plan-post-1', type: 'plan', toolUseId: 'tool-1' },
    });
    // Modern CLI: ExitPlanMode is blocked on the MCP permission call with a
    // bridge request pending — a stdin message would just queue while the
    // bridge waits out its timeout.
    const resolveSpy = mock(() => true);
    (session.messageManager as unknown as { resolveBridgePlan: unknown }).resolveBridgePlan = resolveSpy;
    const ctx = createMockSessionContext(new Map([[session.sessionId, session]]));

    await commands.approvePendingPlan(session, 'testuser', ctx);

    expect(resolveSpy).toHaveBeenCalledWith(true);
    expect(session.claude.sendMessage).not.toHaveBeenCalled();
    expect(session.planApproved).toBe(true);
  });

  it('falls back to the stdin message when nothing is pending on the bridge', async () => {
    const mockPlatform = createMockPlatform();
    const session = createMockSession({
      platform: mockPlatform,
      pendingApproval: { postId: 'plan-post-1', type: 'plan', toolUseId: 'tool-1' },
    });
    const ctx = createMockSessionContext(new Map([[session.sessionId, session]]));

    await commands.approvePendingPlan(session, 'testuser', ctx);

    expect(session.claude.sendMessage).toHaveBeenCalledWith(
      'Plan approved! Please proceed with the implementation.'
    );
  });
});

describe('restartClaudeSession pending-bridge handling', () => {
  const withFakeClaude = async (fn: () => Promise<void>) => {
    const prev = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = '/nonexistent/claude-binary-for-tests';
    try { await fn(); } finally {
      if (prev === undefined) delete process.env.CLAUDE_PATH;
      else process.env.CLAUDE_PATH = prev;
    }
  };

  it('denies pending bridge requests even on RESUME restarts (the MCP child always dies)', async () => {
    await withFakeClaude(async () => {
      const session = createMockSession();
      (session.claude as unknown as { kill: unknown }).kill = mock(() => Promise.resolve());
      const denySpy = mock(() => {});
      (session.messageManager as unknown as { denyPendingBridgeRequests: unknown }).denyPendingBridgeRequests = denySpy;
      const ctx = createMockSessionContext(new Map([[session.sessionId, session]]));

      await commands.restartClaudeSession(
        session,
        { workingDir: '/tmp', resume: true } as never,
        ctx,
        'test restart'
      );

      expect(denySpy).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Channel memory commands (!remember / !memory / !memory forget)
// ---------------------------------------------------------------------------

describe('channel memory commands', () => {
  let memRoot: string;

  function createMemoryCtx(sessions: Map<string, Session>, enabled = true): SessionContext {
    const ctx = createMockSessionContext(sessions);
    memRoot = mkdtempSync(join(tmpdir(), 'ct-memcmd-test-'));
    (ctx.state as { memoryStore: unknown }).memoryStore = new MemoryStore(memRoot);
    (ctx.ops as { getPlatformMemoryConfig: unknown }).getPlatformMemoryConfig = mock(() => ({
      enabled,
      repoLayer: enabled,
      channelLayer: enabled,
      distillation: enabled,
    }));
    return ctx;
  }

  afterEach(() => {
    if (memRoot) rmSync(memRoot, { recursive: true, force: true });
  });

  it('rememberEntry stores the note and confirms', async () => {
    const session = createMockSession();
    const ctx = createMemoryCtx(new Map([[session.sessionId, session]]));

    await commands.rememberEntry(session, 'Deploys happen on Tuesdays', 'testuser', ctx);

    const entries = (ctx.state.memoryStore as MemoryStore).listChannelEntries('test-platform');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ text: 'Deploys happen on Tuesdays', source: 'user', addedBy: 'testuser' });
    const calls = (session.platform.createPost as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.some((m: string) => m.includes('Remembered'))).toBe(true);
  });

  it('rememberEntry reports duplicates instead of double-storing', async () => {
    const session = createMockSession();
    const ctx = createMemoryCtx(new Map([[session.sessionId, session]]));

    await commands.rememberEntry(session, 'One true fact', 'testuser', ctx);
    await commands.rememberEntry(session, 'one true fact', 'testuser', ctx);

    const entries = (ctx.state.memoryStore as MemoryStore).listChannelEntries('test-platform');
    expect(entries).toHaveLength(1);
    const calls = (session.platform.createPost as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.some((m: string) => m.includes('Already known'))).toBe(true);
  });

  it('memory commands explain themselves when the channel layer is disabled', async () => {
    const session = createMockSession();
    const ctx = createMemoryCtx(new Map([[session.sessionId, session]]), false);

    await commands.rememberEntry(session, 'a fact', 'testuser', ctx);

    const entries = (ctx.state.memoryStore as MemoryStore).listChannelEntries('test-platform');
    expect(entries).toHaveLength(0);
    const calls = (session.platform.createPost as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.some((m: string) => m.includes('disabled'))).toBe(true);
  });

  it('showMemory lists entries numbered', async () => {
    const session = createMockSession();
    const ctx = createMemoryCtx(new Map([[session.sessionId, session]]));
    await (ctx.state.memoryStore as MemoryStore).addChannelEntries('test-platform', [
      { text: 'first fact', source: 'user', addedBy: 'testuser' },
      { text: 'second fact', source: 'distilled' },
    ]);

    await commands.showMemory(session, 'testuser', ctx);

    const calls = (session.platform.createPost as any).mock.calls.map((c: any[]) => c[0]);
    const listing = calls.find((m: string) => m.includes('Channel memory'));
    expect(listing).toBeDefined();
    expect(listing).toContain('1. ');
    expect(listing).toContain('first fact');
    expect(listing).toContain('2. ');
    expect(listing).toContain('second fact');
  });

  it('forgetMemory removes by number (owner)', async () => {
    const session = createMockSession();
    const ctx = createMemoryCtx(new Map([[session.sessionId, session]]));
    const store = ctx.state.memoryStore as MemoryStore;
    await store.addChannelEntries('test-platform', [
      { text: 'first fact', source: 'user', addedBy: 'testuser' },
      { text: 'second fact', source: 'user', addedBy: 'testuser' },
    ]);

    await commands.forgetMemory(session, '1', 'testuser', ctx);

    const entries = store.listChannelEntries('test-platform');
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('second fact');
  });

  it('forgetMemory is owner-gated: a non-owner cannot remove entries', async () => {
    // Regression-defender: memory is shared channel state; removal follows
    // the same authorization as other session-shaping settings.
    const session = createMockSession(); // startedBy: testuser; isUserAllowed → false
    const ctx = createMemoryCtx(new Map([[session.sessionId, session]]));
    const store = ctx.state.memoryStore as MemoryStore;
    await store.addChannelEntries('test-platform', [
      { text: 'protected fact', source: 'user', addedBy: 'testuser' },
    ]);

    await commands.forgetMemory(session, '1', 'stranger', ctx);

    expect(store.listChannelEntries('test-platform')).toHaveLength(1);
  });

  it('forgetMemory all clears the channel', async () => {
    const session = createMockSession();
    const ctx = createMemoryCtx(new Map([[session.sessionId, session]]));
    const store = ctx.state.memoryStore as MemoryStore;
    await store.addChannelEntries('test-platform', [
      { text: 'first fact', source: 'user', addedBy: 'testuser' },
      { text: 'second fact', source: 'distilled' },
    ]);

    await commands.forgetMemory(session, 'all', 'testuser', ctx);

    expect(store.listChannelEntries('test-platform')).toHaveLength(0);
  });

  it('forgetMemory reports ambiguous text matches without removing', async () => {
    const session = createMockSession();
    const ctx = createMemoryCtx(new Map([[session.sessionId, session]]));
    const store = ctx.state.memoryStore as MemoryStore;
    await store.addChannelEntries('test-platform', [
      { text: 'deploys use blue-green strategy', source: 'user', addedBy: 'testuser' },
      { text: 'deploys require an approval', source: 'user', addedBy: 'testuser' },
    ]);

    await commands.forgetMemory(session, 'deploys', 'testuser', ctx);

    expect(store.listChannelEntries('test-platform')).toHaveLength(2);
    const calls = (session.platform.createPost as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.some((m: string) => m.includes('matches 2'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Routine commands (!routine / !routines)
// ---------------------------------------------------------------------------

describe('routine commands', () => {
  let routinesRoot: string;

  function createRoutinesCtx(sessions: Map<string, Session>, enabled = true): SessionContext {
    const ctx = createMockSessionContext(sessions);
    routinesRoot = mkdtempSync(join(tmpdir(), 'ct-routinecmd-test-'));
    (ctx.state as { routinesStore: unknown }).routinesStore = new RoutinesStore(join(routinesRoot, 'routines.yaml'));
    (ctx.ops as { isRoutinesEnabled: unknown }).isRoutinesEnabled = mock(() => enabled);
    return ctx;
  }

  afterEach(() => {
    if (routinesRoot) rmSync(routinesRoot, { recursive: true, force: true });
  });

  async function seedRoutine(ctx: SessionContext, name = 'Standup summary') {
    const result = await ctx.state.routinesStore.add('test-platform', {
      name,
      prompt: 'summarize open threads',
      schedule: { preset: 'weekdays', time: '09:00', timezone: 'Europe/Amsterdam' },
      createdBy: 'testuser',
    });
    if (!result.ok) throw new Error(result.error);
    return result.routine;
  }

  it('explains itself when routines are disabled for the platform', async () => {
    const session = createMockSession();
    const ctx = createRoutinesCtx(new Map([[session.sessionId, session]]), false);

    await commands.manageRoutines(session, undefined, 'testuser', ctx);

    const calls = (session.platform.createPost as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.some((m: string) => m.includes('disabled'))).toBe(true);
  });

  it('createRoutine is owner-gated', async () => {
    const session = createMockSession(); // startedBy testuser; isUserAllowed → false
    const ctx = createRoutinesCtx(new Map([[session.sessionId, session]]));

    await commands.createRoutine(session, 'every day at 9, do things', 'stranger', ctx);

    const calls = (session.platform.createPost as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.some((m: string) => m.includes('can create routines'))).toBe(true);
    expect((session.messageManager as any).setPendingRoutinePrompt).not.toHaveBeenCalled();
  });

  it('createRoutine posts a confirmation card from the parsed schedule', async () => {
    const session = createMockSession();
    const ctx = createRoutinesCtx(new Map([[session.sessionId, session]]));

    // Inject the parse result directly (module-mocking quick-query leaks
    // across test files, and CLAUDE_PATH stubbing races with those mocks).
    const parse = async () => ({
      ok: true as const,
      parsed: {
        name: 'Standup summary',
        prompt: 'summarize open threads',
        schedule: { preset: 'weekdays' as const, time: '09:00', timezone: 'Europe/Amsterdam' },
      },
      timezoneDefaulted: true,
    });
    await commands.createRoutine(session, 'every weekday at 9, summarize open threads', 'testuser', ctx, parse);

    // Confirmation card posted with the parsed schedule, pending state set.
    const interactive = (session.platform.createInteractivePost as any).mock.calls;
    expect(interactive.length).toBe(1);
    expect(interactive[0][0]).toContain('Standup summary');
    expect(interactive[0][0]).toContain('weekdays at 09:00');
    const setPending = (session.messageManager as any).setPendingRoutinePrompt;
    expect(setPending).toHaveBeenCalledTimes(1);
    expect(setPending.mock.calls[0][0].requestedBy).toBe('testuser');
    // Nothing saved yet — saving happens only on 👍 via the lifecycle listener.
    expect(ctx.state.routinesStore.list('test-platform')).toHaveLength(0);
  });

  it('lists routines numbered with schedule and creator', async () => {
    const session = createMockSession();
    const ctx = createRoutinesCtx(new Map([[session.sessionId, session]]));
    await seedRoutine(ctx);

    await commands.manageRoutines(session, undefined, 'testuser', ctx);

    const calls = (session.platform.createPost as any).mock.calls.map((c: any[]) => c[0]);
    const listing = calls.find((m: string) => m.includes('Routines (1)'));
    expect(listing).toBeDefined();
    expect(listing).toContain('1. ');
    expect(listing).toContain('Standup summary');
    expect(listing).toContain('weekdays at 09:00');
  });

  it('pause/resume/delete are owner-gated; run needs platform allowance, not just an invite', async () => {
    const session = createMockSession();
    // Only 'platformuser' is on the platform allowlist; 'stranger' stands in
    // for a temporarily !invite'd guest (session-allowed, platform-denied).
    (session.platform.isUserAllowed as any) = mock((u: string) => u === 'platformuser');
    const ctx = createRoutinesCtx(new Map([[session.sessionId, session]]));
    const routine = await seedRoutine(ctx);

    await commands.manageRoutines(session, 'pause 1', 'stranger', ctx);
    expect(ctx.state.routinesStore.get('test-platform', routine.id)?.enabled).toBe(true);

    await commands.manageRoutines(session, 'pause 1', 'testuser', ctx);
    expect(ctx.state.routinesStore.get('test-platform', routine.id)?.enabled).toBe(false);

    // A session-invited guest must NOT be able to spawn unattended sessions
    // under the creator's identity via `run`.
    await commands.manageRoutines(session, 'run 1', 'stranger', ctx);
    expect((ctx.ops.fireRoutineNow as any)).toHaveBeenCalledTimes(0);

    // A platform-allowed non-owner may fire.
    await commands.manageRoutines(session, 'run 1', 'platformuser', ctx);
    expect((ctx.ops.fireRoutineNow as any)).toHaveBeenCalledTimes(1);

    await commands.manageRoutines(session, 'delete 1', 'testuser', ctx);
    expect(ctx.state.routinesStore.list('test-platform')).toHaveLength(0);
  });

  it('reports unknown indices and bad subcommands', async () => {
    const session = createMockSession();
    const ctx = createRoutinesCtx(new Map([[session.sessionId, session]]));

    await commands.manageRoutines(session, 'pause 7', 'testuser', ctx);
    await commands.manageRoutines(session, 'frobnicate 1', 'testuser', ctx);

    const calls = (session.platform.createPost as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.some((m: string) => m.includes('No routine 7'))).toBe(true);
    expect(calls.some((m: string) => m.includes('Usage'))).toBe(true);
  });
});

describe('approvals: owner gates on text commands', () => {
  it('rejects !approve from a platform-allowlisted non-participant under owner mode', async () => {
    const mockPlatform = createMockPlatform();
    (mockPlatform.isUserAllowed as any).mockReturnValue(true);
    (mockPlatform as any).approvals = 'owner';
    const session = createMockSession({
      platform: mockPlatform,
      pendingApproval: { postId: 'plan-post-1', type: 'plan', toolUseId: 'tool-1' },
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.approvePendingPlan(session, 'outsider', ctx);

    // Rejected: warning posted, plan untouched.
    expect(mockPlatform.createPost).toHaveBeenCalledWith(
      expect.stringContaining('participants'),
      session.threadId
    );
    expect(session.messageManager?.getPendingApproval()).not.toBeNull();
    expect(session.planApproved).toBeFalsy();
  });

  it('still allows !approve from a session participant under owner mode', async () => {
    const mockPlatform = createMockPlatform();
    (mockPlatform as any).approvals = 'owner';
    const session = createMockSession({
      platform: mockPlatform,
      pendingApproval: { postId: 'plan-post-1', type: 'plan', toolUseId: 'tool-1' },
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.approvePendingPlan(session, 'testuser', ctx);

    expect(session.planApproved).toBe(true);
  });

  it('rejects !invite self-escalation by an allowlisted non-participant under owner mode', async () => {
    const mockPlatform = createMockPlatform();
    (mockPlatform.isUserAllowed as any).mockReturnValue(true);
    (mockPlatform as any).approvals = 'owner';
    const session = createMockSession({ platform: mockPlatform });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.inviteUser(session, 'outsider', 'outsider', ctx);

    expect(session.sessionAllowedUsers.has('outsider')).toBe(false);
    expect(mockPlatform.createPost).toHaveBeenCalledWith(
      expect.stringContaining('participants'),
      session.threadId
    );
  });

  it('keeps legacy invite behavior for allowlisted users without owner mode', async () => {
    const mockPlatform = createMockPlatform();
    (mockPlatform.isUserAllowed as any).mockReturnValue(true);
    const session = createMockSession({ platform: mockPlatform });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await commands.inviteUser(session, 'newuser', 'someoneelse', ctx);

    expect(session.sessionAllowedUsers.has('newuser')).toBe(true);
  });
});

describe('watch commands', () => {
  let watchesRoot: string;

  function createWatchesCtx(sessions: Map<string, Session>, enabled = true): SessionContext {
    const ctx = createMockSessionContext(sessions);
    watchesRoot = mkdtempSync(join(tmpdir(), 'ct-watchcmd-test-'));
    (ctx.state as { watchesStore: unknown }).watchesStore = new WatchesStore(join(watchesRoot, 'watches.yaml'));
    (ctx.ops as { isWatchesEnabled: unknown }).isWatchesEnabled = mock(() => enabled);
    return ctx;
  }

  afterEach(() => {
    if (watchesRoot) rmSync(watchesRoot, { recursive: true, force: true });
  });

  async function seedWatch(ctx: SessionContext, name = 'Incident triage') {
    const result = await ctx.state.watchesStore.add('test-platform', {
      name,
      condition: 'someone reports a production incident',
      prompt: 'triage it',
      keywords: ['incident', 'outage'],
      createdBy: 'testuser',
    });
    if (!result.ok) throw new Error(result.error);
    return result.watch;
  }

  it('explains itself when watches are disabled for the platform', async () => {
    const session = createMockSession();
    const ctx = createWatchesCtx(new Map([[session.sessionId, session]]), false);

    await commands.manageWatches(session, undefined, 'testuser', ctx);

    const calls = (session.platform.createPost as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.some((m: string) => m.includes('disabled'))).toBe(true);
  });

  it('createWatch is owner-gated', async () => {
    const session = createMockSession(); // startedBy testuser; isUserAllowed → false
    const ctx = createWatchesCtx(new Map([[session.sessionId, session]]));

    await commands.createWatch(session, 'when someone reports an incident, triage it', 'stranger', ctx);

    const calls = (session.platform.createPost as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.some((m: string) => m.includes('can create watches'))).toBe(true);
    expect((session.messageManager as any).setPendingWatchPrompt).not.toHaveBeenCalled();
  });

  it('createWatch refuses in direct channel mode (a saved watch could never fire)', async () => {
    // The message handler never evaluates watches in DCM (all traffic routes
    // to the one channel session), so saving here would create a permanently
    // inert watch behind a success message.
    const session = createMockSession();
    (session.platform as any).directChannelMode = { enabled: true, respondTo: 'all_messages' };
    const ctx = createWatchesCtx(new Map([[session.sessionId, session]]));

    await commands.createWatch(session, 'when someone reports an incident, triage it', 'testuser', ctx);

    const calls = (session.platform.createPost as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.some((m: string) => m.includes('direct channel mode'))).toBe(true);
    expect((session.messageManager as any).setPendingWatchPrompt).not.toHaveBeenCalled();
  });

  it('createWatch posts a confirmation card showing condition and keywords', async () => {
    const session = createMockSession();
    const ctx = createWatchesCtx(new Map([[session.sessionId, session]]));

    // Inject the parse result directly (module-mocking quick-query leaks
    // across test files; DI is the house pattern).
    const parse = async () => ({
      ok: true as const,
      parsed: {
        name: 'Incident triage',
        condition: 'someone reports a production incident',
        prompt: 'triage it and post a checklist',
        keywords: ['incident', 'outage', 'down'],
      },
    });

    await commands.createWatch(session, 'when someone reports an incident, triage it', 'testuser', ctx, parse);

    const interactive = (session.platform.createInteractivePost as any).mock.calls;
    expect(interactive).toHaveLength(1);
    const card = interactive[0][0] as string;
    expect(card).toContain('Incident triage');
    expect(card).toContain('someone reports a production incident');
    expect(card).toContain('incident');
    expect(card).toContain('semantic check');
    expect((session.messageManager as any).setPendingWatchPrompt).toHaveBeenCalled();
  });

  it('createWatch surfaces parse errors without saving anything', async () => {
    const session = createMockSession();
    const ctx = createWatchesCtx(new Map([[session.sessionId, session]]));

    const parse = async () => ({ ok: false as const, error: 'not a watch request' });
    await commands.createWatch(session, 'what is the weather', 'testuser', ctx, parse);

    const calls = (session.platform.createPost as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.some((m: string) => m.includes('not a watch request'))).toBe(true);
    expect(ctx.state.watchesStore.list('test-platform')).toHaveLength(0);
  });

  it('lists watches numbered with condition and creator', async () => {
    const session = createMockSession();
    const ctx = createWatchesCtx(new Map([[session.sessionId, session]]));
    await seedWatch(ctx);

    await commands.manageWatches(session, undefined, 'testuser', ctx);

    const calls = (session.platform.createPost as any).mock.calls.map((c: any[]) => c[0]);
    const listing = calls.find((m: string) => m.includes('Watches (1)'));
    expect(listing).toBeDefined();
    expect(listing).toContain('1. ');
    expect(listing).toContain('Incident triage');
    expect(listing).toContain('production incident');
  });

  it('pause/resume/delete are owner-gated', async () => {
    const session = createMockSession();
    const ctx = createWatchesCtx(new Map([[session.sessionId, session]]));
    const watch = await seedWatch(ctx);

    await commands.manageWatches(session, 'pause 1', 'stranger', ctx);
    expect(ctx.state.watchesStore.get('test-platform', watch.id)?.enabled).toBe(true);

    await commands.manageWatches(session, 'pause 1', 'testuser', ctx);
    expect(ctx.state.watchesStore.get('test-platform', watch.id)?.enabled).toBe(false);

    await commands.manageWatches(session, 'resume 1', 'testuser', ctx);
    expect(ctx.state.watchesStore.get('test-platform', watch.id)?.enabled).toBe(true);

    await commands.manageWatches(session, 'delete 1', 'testuser', ctx);
    expect(ctx.state.watchesStore.list('test-platform')).toHaveLength(0);
  });

  it('reports unknown indices and bad subcommands', async () => {
    const session = createMockSession();
    const ctx = createWatchesCtx(new Map([[session.sessionId, session]]));

    await commands.manageWatches(session, 'pause 7', 'testuser', ctx);
    await commands.manageWatches(session, 'run 1', 'testuser', ctx); // no manual run for watches

    const calls = (session.platform.createPost as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.some((m: string) => m.includes('No watch 7'))).toBe(true);
    expect(calls.some((m: string) => m.includes('Usage'))).toBe(true);
  });
});
