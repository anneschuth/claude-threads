import { describe, it, expect, mock, beforeEach } from 'bun:test';
import * as worktree from './worktree.js';
import type { Session } from './types.js';
import type { PlatformClient } from '../platform/index.js';
import { createMockFormatter } from '../test-utils/mock-formatter.js';

// Mock the git/worktree module
const mockIsGitRepository = mock(() => Promise.resolve(true));
const mockGetRepositoryRoot = mock(() => Promise.resolve('/repo'));
const mockFindWorktreeByBranch = mock(() => Promise.resolve(null as { path: string; branch: string; isMain: boolean } | null));
const mockCreateWorktree = mock(() => Promise.resolve());
const mockGetWorktreeDir = mock(() => '/repo-worktrees/feature-branch');

mock.module('../git/worktree.js', () => ({
  isGitRepository: mockIsGitRepository,
  getRepositoryRoot: mockGetRepositoryRoot,
  findWorktreeByBranch: mockFindWorktreeByBranch,
  createWorktree: mockCreateWorktree,
  getWorktreeDir: mockGetWorktreeDir,
  listWorktrees: mock(() => Promise.resolve([])),
  removeWorktree: mock(() => Promise.resolve()),
  hasUncommittedChanges: mock(() => Promise.resolve(false)),
  isValidBranchName: mock(() => true),
}));

// Mock the ClaudeCli class to avoid spawning real processes
mock.module('../claude/cli.js', () => ({
  ClaudeCli: class MockClaudeCli {
    isRunning() { return true; }
    kill() {}
    start() {}
    sendMessage() {}
    on() {}
    interrupt() {}
  },
}));

// =============================================================================
// Test Utilities
// =============================================================================

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
    createInteractivePost: mock(() => Promise.resolve({ id: 'interactive-post-1', message: '', userId: 'bot' })),
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
    workingDir: '/test/repo',
    activeSubagents: new Map(),
    isResumed: false,
    sessionStartPostId: 'start-post-id',
    pendingContent: '',
    timeoutWarningPosted: false,
    tasksCompleted: false,
    tasksMinimized: false,
    lastTasksContent: '',
    tasksPostId: null,
    skipPermissions: true,
    forceInteractivePermissions: false,
    platformId: 'test-platform',
    currentPostId: null,
    messageCount: 0,
    ...overrides,
  } as Session;
}

function createMockOptions() {
  return {
    skipPermissions: true,
    chromeEnabled: false,
    handleEvent: mock(() => {}),
    handleExit: mock(() => Promise.resolve()),
    updateSessionHeader: mock(() => Promise.resolve()),
    flush: mock(() => Promise.resolve()),
    persistSession: mock(() => {}),
    startTyping: mock(() => {}),
    stopTyping: mock(() => {}),
    offerContextPrompt: mock(() => Promise.resolve(false)),
    registerPost: mock(() => {}),
    updateStickyMessage: mock(() => Promise.resolve()),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('Worktree Module', () => {
  beforeEach(() => {
    // Reset mocks
    mockIsGitRepository.mockReset();
    mockGetRepositoryRoot.mockReset();
    mockFindWorktreeByBranch.mockReset();
    mockCreateWorktree.mockReset();

    // Set default return values
    mockIsGitRepository.mockImplementation(() => Promise.resolve(true));
    mockGetRepositoryRoot.mockImplementation(() => Promise.resolve('/repo'));
    mockFindWorktreeByBranch.mockImplementation(() => Promise.resolve(null));
    mockCreateWorktree.mockImplementation(() => Promise.resolve());
  });

  describe('createAndSwitchToWorktree', () => {
    describe('when worktree already exists and pendingWorktreePrompt is true (inline branch syntax)', () => {
      it('auto-joins existing worktree without showing confirmation prompt', async () => {
        const session = createMockSession({
          pendingWorktreePrompt: true,
          worktreePromptPostId: 'prompt-post-1',
          queuedPrompt: 'do something',
        });
        const options = createMockOptions();

        // Mock existing worktree
        mockFindWorktreeByBranch.mockImplementation(() =>
          Promise.resolve({
            path: '/repo-worktrees/feature-branch',
            branch: 'feature-branch',
            isMain: false,
          })
        );

        await worktree.createAndSwitchToWorktree(session, 'feature-branch', 'testuser', options);

        // Should NOT create an interactive post (confirmation prompt)
        expect(session.platform.createInteractivePost).not.toHaveBeenCalled();

        // Should update the worktree prompt post
        expect(session.platform.updatePost).toHaveBeenCalled();

        // Should clear pending state
        expect(session.pendingWorktreePrompt).toBe(false);
        expect(session.worktreePromptPostId).toBeUndefined();
        expect(session.queuedPrompt).toBeUndefined();

        // Should update working directory
        expect(session.workingDir).toBe('/repo-worktrees/feature-branch');

        // Should offer context prompt with queued message
        expect(options.offerContextPrompt).toHaveBeenCalledWith(
          session,
          'do something',
          undefined,  // queuedFiles
          undefined   // excludePostId
        );

        // Should persist session
        expect(options.persistSession).toHaveBeenCalled();
      });

      it('restarts Claude CLI in the worktree directory', async () => {
        const killMock = mock(() => Promise.resolve());
        const session = createMockSession({
          pendingWorktreePrompt: true,
          worktreePromptPostId: 'prompt-post-1',
          queuedPrompt: 'do something',
        });
        // Replace the claude mock with one that has a trackable kill
        (session.claude as any).kill = killMock;
        const options = createMockOptions();

        mockFindWorktreeByBranch.mockImplementation(() =>
          Promise.resolve({
            path: '/repo-worktrees/feature-branch',
            branch: 'feature-branch',
            isMain: false,
          })
        );

        await worktree.createAndSwitchToWorktree(session, 'feature-branch', 'testuser', options);

        // Should kill and restart Claude CLI
        expect(killMock).toHaveBeenCalled();
        expect(options.stopTyping).toHaveBeenCalled();
      });
    });

    describe('when worktree already exists but pendingWorktreePrompt is false (mid-session)', () => {
      it('shows confirmation prompt asking to join or skip', async () => {
        const session = createMockSession({
          pendingWorktreePrompt: false,
        });
        const options = createMockOptions();

        mockFindWorktreeByBranch.mockImplementation(() =>
          Promise.resolve({
            path: '/repo-worktrees/feature-branch',
            branch: 'feature-branch',
            isMain: false,
          })
        );

        await worktree.createAndSwitchToWorktree(session, 'feature-branch', 'testuser', options);

        // Should create interactive post for confirmation
        expect(session.platform.createInteractivePost).toHaveBeenCalled();

        // Should set pending state for reaction handling
        expect(session.pendingExistingWorktreePrompt).toBeDefined();
        expect(session.pendingExistingWorktreePrompt?.branch).toBe('feature-branch');
      });
    });

    describe('when worktree creation fails', () => {
      it('clears pending state and continues without worktree', async () => {
        const session = createMockSession({
          pendingWorktreePrompt: true,
          worktreePromptPostId: 'prompt-post-1',
          queuedPrompt: 'do something',
        });
        const options = createMockOptions();

        // Mock worktree creation failure
        mockCreateWorktree.mockImplementation(() =>
          Promise.reject(new Error('Failed to create worktree'))
        );

        await worktree.createAndSwitchToWorktree(session, 'new-branch', 'testuser', options);

        // Should clear pending state
        expect(session.pendingWorktreePrompt).toBe(false);
        expect(session.worktreePromptPostId).toBeUndefined();
        expect(session.queuedPrompt).toBeUndefined();

        // Should update the prompt post with failure message
        expect(session.platform.updatePost).toHaveBeenCalled();

        // Should persist session
        expect(options.persistSession).toHaveBeenCalled();

        // Should still offer context prompt with queued message
        expect(options.offerContextPrompt).toHaveBeenCalledWith(
          session,
          'do something',
          undefined,  // queuedFiles
          undefined   // excludePostId
        );
      });

      it('does not leave session stuck in pending state', async () => {
        const session = createMockSession({
          pendingWorktreePrompt: true,
          worktreePromptPostId: 'prompt-post-1',
          queuedPrompt: 'my prompt',
        });
        const options = createMockOptions();

        mockCreateWorktree.mockImplementation(() =>
          Promise.reject(new Error('git worktree add failed'))
        );

        await worktree.createAndSwitchToWorktree(session, 'broken-branch', 'testuser', options);

        // Session should not be stuck
        expect(session.pendingWorktreePrompt).toBe(false);

        // The queued prompt should have been sent
        expect(options.offerContextPrompt).toHaveBeenCalled();
      });
    });

    describe('when worktree creation succeeds', () => {
      it('creates worktree and sends queued prompt', async () => {
        const session = createMockSession({
          pendingWorktreePrompt: true,
          worktreePromptPostId: 'prompt-post-1',
          queuedPrompt: 'do something',
        });
        const options = createMockOptions();

        await worktree.createAndSwitchToWorktree(session, 'new-branch', 'testuser', options);

        // Should create worktree
        expect(mockCreateWorktree).toHaveBeenCalled();

        // Should clear pending state
        expect(session.pendingWorktreePrompt).toBe(false);

        // Should update working directory
        expect(session.workingDir).toBe('/repo-worktrees/feature-branch');

        // Should send queued prompt
        expect(options.offerContextPrompt).toHaveBeenCalledWith(
          session,
          'do something',
          undefined,  // queuedFiles
          undefined   // excludePostId
        );
      });
    });

    describe('authorization checks', () => {
      it('rejects unauthorized users', async () => {
        const platform = createMockPlatform({
          isUserAllowed: mock(() => false),
        });
        const session = createMockSession({
          startedBy: 'owner',
          platform,
        });
        const options = createMockOptions();

        await worktree.createAndSwitchToWorktree(session, 'feature-branch', 'unauthorized-user', options);

        // Should post warning
        expect(platform.createPost).toHaveBeenCalled();

        // Should not attempt to create worktree
        expect(mockCreateWorktree).not.toHaveBeenCalled();
      });

      it('allows session owner', async () => {
        const session = createMockSession({
          startedBy: 'testuser',
        });
        const options = createMockOptions();

        await worktree.createAndSwitchToWorktree(session, 'feature-branch', 'testuser', options);

        // Should attempt to create worktree (or find existing)
        expect(mockGetRepositoryRoot).toHaveBeenCalled();
      });
    });
  });

  describe('shouldPromptForWorktree', () => {
    it('returns null when worktreeMode is off', async () => {
      const session = createMockSession();
      const result = await worktree.shouldPromptForWorktree(session, 'off', () => false);
      expect(result).toBeNull();
    });

    it('returns null when worktreePromptDisabled is true', async () => {
      const session = createMockSession({ worktreePromptDisabled: true });
      const result = await worktree.shouldPromptForWorktree(session, 'prompt', () => false);
      expect(result).toBeNull();
    });

    it('returns null when already in a worktree', async () => {
      const session = createMockSession({
        worktreeInfo: { repoRoot: '/repo', worktreePath: '/repo-wt', branch: 'feature' },
      });
      const result = await worktree.shouldPromptForWorktree(session, 'prompt', () => false);
      expect(result).toBeNull();
    });

    it('returns "require" when worktreeMode is require', async () => {
      const session = createMockSession();
      const result = await worktree.shouldPromptForWorktree(session, 'require', () => false);
      expect(result).toBe('require');
    });
  });
});
