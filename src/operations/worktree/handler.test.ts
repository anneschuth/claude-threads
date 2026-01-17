import { describe, it, expect, mock, beforeEach } from 'bun:test';
import * as worktree from './handler.js';
import type { Session } from '../../session/types.js';
import { createSessionTimers, createSessionLifecycle } from '../../session/types.js';
import type { PlatformClient } from '../../platform/index.js';
import { createMockFormatter } from '../../test-utils/mock-formatter.js';

// Mock the git/worktree module
const mockIsGitRepository = mock(() => Promise.resolve(true));
const mockGetRepositoryRoot = mock(() => Promise.resolve('/repo'));
const mockFindWorktreeByBranch = mock(() => Promise.resolve(null as { path: string; branch: string; isMain: boolean } | null));
const mockCreateWorktree = mock(() => Promise.resolve());
const mockGetWorktreeDir = mock(() => '/repo-worktrees/feature-branch');
const mockRemoveWorktree = mock(() => Promise.resolve());
const mockIsValidWorktreePath = mock((path: string) => path.includes('/.claude-threads/worktrees/'));
const mockWriteWorktreeMetadata = mock(() => Promise.resolve());

mock.module('../../git/worktree.js', () => ({
  isGitRepository: mockIsGitRepository,
  getRepositoryRoot: mockGetRepositoryRoot,
  findWorktreeByBranch: mockFindWorktreeByBranch,
  createWorktree: mockCreateWorktree,
  getWorktreeDir: mockGetWorktreeDir,
  listWorktrees: mock(() => Promise.resolve([])),
  removeWorktree: mockRemoveWorktree,
  hasUncommittedChanges: mock(() => Promise.resolve(false)),
  isValidBranchName: mock(() => true),
  isValidWorktreePath: mockIsValidWorktreePath,
  writeWorktreeMetadata: mockWriteWorktreeMetadata,
}));

// Mock the ClaudeCli class to avoid spawning real processes
mock.module('../../claude/cli.js', () => ({
  ClaudeCli: class MockClaudeCli {
    isRunning() { return true; }
    kill() {}
    start() {}
    sendMessage() {}
    on() {}
    interrupt() {}
  },
}));

// Mock functions for context preservation (passed via options, not mock.module)
const mockGenerateWorkSummary = mock(() => Promise.resolve('Summary of previous work'));
const mockGetThreadMessagesForContext = mock(() => Promise.resolve([
  { id: '1', userId: 'user1', username: 'alice', message: 'Previous message', createAt: 1000 },
]));
const mockFormatContextForClaude = mock((messages: unknown[], summary?: string) => {
  let result = '';
  if (summary) result += `[Summary: ${summary}]\n`;
  if (Array.isArray(messages) && messages.length > 0) result += `[Messages: ${messages.length}]\n`;
  result += '[Current request:]';
  return result;
});

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

// Create mock message manager with state tracking
function createMockMessageManager() {
  // Internal state for testing
  let pendingExistingWorktreePrompt: { postId: string; branch: string; worktreePath: string } | null = null;

  return {
    setPendingExistingWorktreePrompt: mock((prompt: { postId: string; branch: string; worktreePath: string } | null) => {
      pendingExistingWorktreePrompt = prompt;
    }),
    getPendingExistingWorktreePrompt: mock(() => pendingExistingWorktreePrompt),
    hasPendingExistingWorktreePrompt: mock(() => pendingExistingWorktreePrompt !== null),
    clearPendingExistingWorktreePrompt: mock(() => { pendingExistingWorktreePrompt = null; }),
    // Other methods that might be called
    handleEvent: mock(() => Promise.resolve()),
    flush: mock(() => Promise.resolve()),
    handleReaction: mock(() => Promise.resolve(false)),
    setWorktreeInfo: mock(() => {}),
    clearWorktreeInfo: mock(() => {}),
  } as any;
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
    platformId: 'test-platform',
    currentPostId: null,
    messageCount: 0,
    messageManager: createMockMessageManager(),
    timers: createSessionTimers(),
    lifecycle: createSessionLifecycle(),
    ...overrides,
  } as Session;
}

function createMockOptions() {
  return {
    skipPermissions: true,
    chromeEnabled: false,
    worktreeMode: 'prompt' as const,
    handleEvent: mock(() => {}),
    handleExit: mock(() => Promise.resolve()),
    updateSessionHeader: mock(() => Promise.resolve()),
    flush: mock(() => Promise.resolve()),
    persistSession: mock(() => {}),
    startTyping: mock(() => {}),
    stopTyping: mock(() => {}),
    offerContextPrompt: mock(() => Promise.resolve(false)),
    buildMessageContent: mock((text: string) => Promise.resolve(text)),
    // Context preservation functions (injected to avoid mock.module interference)
    generateWorkSummary: mockGenerateWorkSummary,
    getThreadMessagesForContext: mockGetThreadMessagesForContext,
    formatContextForClaude: mockFormatContextForClaude,
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

      it('removes the x reaction from the prompt post after joining', async () => {
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

        // Should remove the x reaction from the prompt post
        expect(session.platform.removeReaction).toHaveBeenCalledWith('prompt-post-1', 'x');
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

        // Should set pending state for reaction handling via MessageManager
        const pendingPrompt = session.messageManager?.getPendingExistingWorktreePrompt();
        expect(pendingPrompt).toBeDefined();
        expect(pendingPrompt?.branch).toBe('feature-branch');
      });
    });

    describe('when worktree creation fails', () => {
      it('shows failure prompt with retry option (prompt mode)', async () => {
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

        // Should keep pending state so user can retry or skip
        expect(session.pendingWorktreePrompt).toBe(true);
        expect(session.pendingWorktreeFailurePrompt).toBeDefined();
        expect(session.pendingWorktreeFailurePrompt?.failedBranch).toBe('new-branch');

        // Should create interactive post with retry prompt
        expect(session.platform.createInteractivePost).toHaveBeenCalled();

        // Should NOT have sent the queued prompt yet (waiting for user decision)
        expect(options.offerContextPrompt).not.toHaveBeenCalled();

        // Should persist session
        expect(options.persistSession).toHaveBeenCalled();
      });

      it('removes the x reaction from the original prompt post after failure', async () => {
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

        // Should remove the x reaction from the original prompt post
        expect(session.platform.removeReaction).toHaveBeenCalledWith('prompt-post-1', 'x');
      });

      it('shows retry-only prompt in require mode (no skip option)', async () => {
        const session = createMockSession({
          pendingWorktreePrompt: true,
          worktreePromptPostId: 'prompt-post-1',
          queuedPrompt: 'my prompt',
        });
        const options = { ...createMockOptions(), worktreeMode: 'require' as const };

        mockCreateWorktree.mockImplementation(() =>
          Promise.reject(new Error('git worktree add failed'))
        );

        await worktree.createAndSwitchToWorktree(session, 'broken-branch', 'testuser', options);

        // Should remain in pending state for retry
        expect(session.pendingWorktreePrompt).toBe(true);

        // Should create interactive post asking for retry
        expect(session.platform.createInteractivePost).toHaveBeenCalledWith(
          expect.stringContaining('Worktree required but creation failed'),
          [],  // No skip option in require mode
          expect.any(String)
        );

        // The queued prompt should NOT have been sent yet
        expect(options.offerContextPrompt).not.toHaveBeenCalled();
      });

      it('allows user to skip and continue in main repo after failure', async () => {
        const session = createMockSession({
          pendingWorktreePrompt: true,
          worktreePromptPostId: 'prompt-post-1',
          queuedPrompt: 'do something',
          pendingWorktreeFailurePrompt: {
            postId: 'failure-prompt-post',
            failedBranch: 'bad-branch',
            errorMessage: 'Failed',
            username: 'testuser',
          },
        });

        const persistSession = mock(() => {});
        const offerContextPrompt = mock(() => Promise.resolve(false));

        await worktree.handleWorktreeSkip(session, 'testuser', persistSession, offerContextPrompt);

        // Should clear pending state after skip
        expect(session.pendingWorktreePrompt).toBe(false);
        expect(session.pendingWorktreeFailurePrompt).toBeUndefined();

        // Should send the queued prompt
        expect(offerContextPrompt).toHaveBeenCalledWith(session, 'do something', undefined);
      });

      it('allows user to retry with different branch name after failure', async () => {
        const session = createMockSession({
          pendingWorktreePrompt: true,
          worktreePromptPostId: 'failure-prompt-post',
          queuedPrompt: 'do something',
          pendingWorktreeFailurePrompt: {
            postId: 'failure-prompt-post',
            failedBranch: 'bad-branch',
            errorMessage: 'Failed',
            username: 'testuser',
          },
        });

        let createAndSwitchCalled = false;
        const createAndSwitch = mock(async () => {
          createAndSwitchCalled = true;
        });

        const result = await worktree.handleWorktreeBranchResponse(
          session,
          'new-branch-name',
          'testuser',
          'response-post-id',
          createAndSwitch
        );

        // Should handle the response
        expect(result).toBe(true);

        // Should clear the failure prompt state
        expect(session.pendingWorktreeFailurePrompt).toBeUndefined();

        // Should call createAndSwitch with the new branch name
        expect(createAndSwitchCalled).toBe(true);
        expect(createAndSwitch).toHaveBeenCalledWith(
          session.threadId,
          'new-branch-name',
          'testuser'
        );
      });

      it('handles retry response even when not in initial pending state', async () => {
        // Session has failure prompt but pendingWorktreePrompt is false
        const session = createMockSession({
          pendingWorktreePrompt: false,  // Not in initial pending state
          pendingWorktreeFailurePrompt: {
            postId: 'failure-prompt-post',
            failedBranch: 'bad-branch',
            errorMessage: 'Failed',
            username: 'testuser',
          },
        });

        const createAndSwitch = mock(async () => {});

        const result = await worktree.handleWorktreeBranchResponse(
          session,
          'retry-branch',
          'testuser',
          'response-post-id',
          createAndSwitch
        );

        // Should still handle the response due to failure prompt
        expect(result).toBe(true);
        expect(createAndSwitch).toHaveBeenCalled();
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

      it('removes the x reaction from the prompt post after success', async () => {
        const session = createMockSession({
          pendingWorktreePrompt: true,
          worktreePromptPostId: 'prompt-post-1',
          queuedPrompt: 'do something',
        });
        const options = createMockOptions();

        await worktree.createAndSwitchToWorktree(session, 'new-branch', 'testuser', options);

        // Should remove the x reaction from the prompt post
        expect(session.platform.removeReaction).toHaveBeenCalledWith('prompt-post-1', 'x');
      });
    });

    describe('mid-session worktree creation (context preservation)', () => {
      beforeEach(() => {
        // Reset mocks for context-related functions
        mockGenerateWorkSummary.mockReset();
        mockGetThreadMessagesForContext.mockReset();
        mockFormatContextForClaude.mockReset();

        // Set default implementations
        mockGenerateWorkSummary.mockImplementation(() => Promise.resolve('Summary of previous work'));
        mockGetThreadMessagesForContext.mockImplementation(() => Promise.resolve([
          { id: '1', userId: 'user1', username: 'alice', message: 'Previous message', createAt: 1000 },
        ]));
        mockFormatContextForClaude.mockImplementation((messages: unknown[], summary?: string) => {
          let result = '';
          if (summary) result += `[Summary: ${summary}]\n`;
          if (Array.isArray(messages) && messages.length > 0) result += `[Messages: ${messages.length}]\n`;
          result += '[Current request:]';
          return result;
        });
      });

      it('generates work summary before creating worktree', async () => {
        const session = createMockSession({
          pendingWorktreePrompt: false,  // Mid-session, not at session start
          firstPrompt: 'continue my work',
        });
        const options = createMockOptions();

        await worktree.createAndSwitchToWorktree(session, 'new-branch', 'testuser', options);

        // Should generate work summary
        expect(mockGenerateWorkSummary).toHaveBeenCalledWith(session);
      });

      it('auto-includes all thread context without prompting for mid-session worktree', async () => {
        const session = createMockSession({
          pendingWorktreePrompt: false,  // Mid-session
          firstPrompt: 'continue my work',
        });
        const options = createMockOptions();

        await worktree.createAndSwitchToWorktree(session, 'new-branch', 'testuser', options);

        // Should NOT call offerContextPrompt (auto-include instead)
        expect(options.offerContextPrompt).not.toHaveBeenCalled();

        // Should fetch thread messages
        expect(mockGetThreadMessagesForContext).toHaveBeenCalledWith(session, 50, undefined);

        // Should format context with work summary and messages
        expect(mockFormatContextForClaude).toHaveBeenCalled();

        // Should build and send the message directly
        expect(options.buildMessageContent).toHaveBeenCalled();
        expect(options.startTyping).toHaveBeenCalled();
      });

      it('includes work summary in formatted context', async () => {
        const session = createMockSession({
          pendingWorktreePrompt: false,
          firstPrompt: 'continue my work',
        });
        const options = createMockOptions();

        await worktree.createAndSwitchToWorktree(session, 'new-branch', 'testuser', options);

        // formatContextForClaude should be called with messages and summary
        expect(mockFormatContextForClaude).toHaveBeenCalledWith(
          expect.any(Array),
          'Summary of previous work'
        );
      });

      it('still uses offerContextPrompt for session-start worktree (wasPending=true)', async () => {
        const session = createMockSession({
          pendingWorktreePrompt: true,  // Session start
          worktreePromptPostId: 'prompt-post-1',
          queuedPrompt: 'start my work',
        });
        const options = createMockOptions();

        await worktree.createAndSwitchToWorktree(session, 'new-branch', 'testuser', options);

        // Should use offerContextPrompt (let user choose context)
        expect(options.offerContextPrompt).toHaveBeenCalledWith(
          session,
          'start my work',
          undefined,
          undefined
        );

        // Should NOT auto-include context
        expect(mockGenerateWorkSummary).not.toHaveBeenCalled();
      });

      it('increments message count when auto-including context', async () => {
        const session = createMockSession({
          pendingWorktreePrompt: false,
          firstPrompt: 'continue my work',
          messageCount: 5,
        });
        const options = createMockOptions();

        await worktree.createAndSwitchToWorktree(session, 'new-branch', 'testuser', options);

        // Message count should be incremented
        expect(session.messageCount).toBe(6);
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

  describe('handleWorktreeSkip', () => {
    it('removes the x reaction from the prompt post when skipping', async () => {
      const session = createMockSession({
        pendingWorktreePrompt: true,
        worktreePromptPostId: 'prompt-post-1',
        queuedPrompt: 'do something',
      });

      const persistSession = mock(() => {});
      const offerContextPrompt = mock(() => Promise.resolve(false));

      await worktree.handleWorktreeSkip(session, 'testuser', persistSession, offerContextPrompt);

      // Should update the prompt post
      expect(session.platform.updatePost).toHaveBeenCalledWith(
        'prompt-post-1',
        expect.stringContaining('Continuing in main repo')
      );

      // Should remove the x reaction from the prompt post
      expect(session.platform.removeReaction).toHaveBeenCalledWith('prompt-post-1', 'x');

      // Should clear pending state
      expect(session.pendingWorktreePrompt).toBe(false);
      expect(session.worktreePromptPostId).toBeUndefined();
    });

    it('does nothing if not pending', async () => {
      const session = createMockSession({
        pendingWorktreePrompt: false,
      });

      const persistSession = mock(() => {});
      const offerContextPrompt = mock(() => Promise.resolve(false));

      await worktree.handleWorktreeSkip(session, 'testuser', persistSession, offerContextPrompt);

      // Should not update any post
      expect(session.platform.updatePost).not.toHaveBeenCalled();
      expect(session.platform.removeReaction).not.toHaveBeenCalled();
    });

    it('rejects unauthorized users', async () => {
      const platform = createMockPlatform({
        isUserAllowed: mock(() => false),
      });
      const session = createMockSession({
        pendingWorktreePrompt: true,
        worktreePromptPostId: 'prompt-post-1',
        startedBy: 'owner',
        platform,
      });

      const persistSession = mock(() => {});
      const offerContextPrompt = mock(() => Promise.resolve(false));

      await worktree.handleWorktreeSkip(session, 'unauthorized-user', persistSession, offerContextPrompt);

      // Should not update any post
      expect(platform.updatePost).not.toHaveBeenCalled();
      expect(platform.removeReaction).not.toHaveBeenCalled();
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

  describe('cleanupWorktree', () => {
    beforeEach(() => {
      // Reset the isValidWorktreePath mock to a reasonable default
      mockIsValidWorktreePath.mockReset();
      mockIsValidWorktreePath.mockImplementation((path: string) => path.includes('/.claude-threads/worktrees/'));
    });

    it('succeeds when session has no worktree', async () => {
      const session = createMockSession({
        worktreeInfo: undefined,
      });

      const result = await worktree.cleanupWorktree(session, () => false);

      expect(result.success).toBe(true);
    });

    it('skips cleanup when session is not worktree owner', async () => {
      const session = createMockSession({
        worktreeInfo: { repoRoot: '/repo', worktreePath: '/home/user/.claude-threads/worktrees/repo-wt', branch: 'feature' },
        isWorktreeOwner: false,
      });

      const result = await worktree.cleanupWorktree(session, () => false);

      expect(result.success).toBe(true);
      // Should not attempt to remove worktree
    });

    it('skips cleanup when other sessions are using the worktree', async () => {
      // Set mock to return true for this test's path
      mockIsValidWorktreePath.mockReturnValue(true);

      const session = createMockSession({
        worktreeInfo: { repoRoot: '/repo', worktreePath: '/home/user/.claude-threads/worktrees/repo-wt', branch: 'feature' },
        isWorktreeOwner: true,
      });

      const result = await worktree.cleanupWorktree(session, () => true);

      expect(result.success).toBe(true);
      // Should not attempt to remove worktree
    });

    it('fails when worktree path is not in centralized location', async () => {
      const session = createMockSession({
        worktreeInfo: { repoRoot: '/repo', worktreePath: '/random/path', branch: 'feature' },
        isWorktreeOwner: true,
      });

      const result = await worktree.cleanupWorktree(session, () => false);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid path pattern');
    });
  });

  describe('worktree ownership tracking', () => {
    it('sets isWorktreeOwner=false when joining existing worktree', async () => {
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

      expect(session.isWorktreeOwner).toBe(false);
    });

    it('sets isWorktreeOwner=true when creating new worktree', async () => {
      const session = createMockSession({
        pendingWorktreePrompt: true,
        worktreePromptPostId: 'prompt-post-1',
        queuedPrompt: 'do something',
      });
      const options = createMockOptions();

      // No existing worktree
      mockFindWorktreeByBranch.mockImplementation(() => Promise.resolve(null));

      await worktree.createAndSwitchToWorktree(session, 'new-branch', 'testuser', options);

      expect(session.isWorktreeOwner).toBe(true);
    });

    it('syncs worktree info to message manager when joining existing worktree', async () => {
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

      // Should sync worktree info to message manager for tool output path shortening
      expect(session.messageManager?.setWorktreeInfo).toHaveBeenCalledWith(
        '/repo-worktrees/feature-branch',
        'feature-branch'
      );
    });

    it('syncs worktree info to message manager when creating new worktree', async () => {
      const session = createMockSession({
        pendingWorktreePrompt: true,
        worktreePromptPostId: 'prompt-post-1',
        queuedPrompt: 'do something',
      });
      const options = createMockOptions();

      // No existing worktree
      mockFindWorktreeByBranch.mockImplementation(() => Promise.resolve(null));

      await worktree.createAndSwitchToWorktree(session, 'new-branch', 'testuser', options);

      // Should sync worktree info to message manager for tool output path shortening
      expect(session.messageManager?.setWorktreeInfo).toHaveBeenCalled();
    });
  });

  describe('cleanupWorktreeCommand', () => {
    beforeEach(() => {
      mockIsValidWorktreePath.mockReset();
      mockIsValidWorktreePath.mockImplementation((path: string) => path.includes('/.claude-threads/worktrees/'));
      mockRemoveWorktree.mockReset();
      mockRemoveWorktree.mockResolvedValue(undefined);
    });

    it('cleans up worktree and switches back to repo root', async () => {
      mockIsValidWorktreePath.mockReturnValue(true);

      const session = createMockSession({
        worktreeInfo: {
          repoRoot: '/original/repo',
          worktreePath: '/home/user/.claude-threads/worktrees/repo-wt',
          branch: 'feature',
        },
        isWorktreeOwner: true,
      });

      const changeDirectoryCalled: string[] = [];
      const changeDirectory = mock(async (threadId: string, path: string) => {
        changeDirectoryCalled.push(path);
      });

      await worktree.cleanupWorktreeCommand(
        session,
        'testuser',
        () => false,
        changeDirectory
      );

      // Should switch back to repo root
      expect(changeDirectoryCalled).toContain('/original/repo');
      // Should clear worktree info
      expect(session.worktreeInfo).toBeUndefined();
      expect(session.isWorktreeOwner).toBeUndefined();
      // Should clear worktree info on message manager (for tool output path shortening)
      expect(session.messageManager?.clearWorktreeInfo).toHaveBeenCalled();
      // Should remove worktree
      expect(mockRemoveWorktree).toHaveBeenCalled();
    });

    it('refuses cleanup when not in a worktree', async () => {
      const session = createMockSession({
        worktreeInfo: undefined,
      });

      await worktree.cleanupWorktreeCommand(
        session,
        'testuser',
        () => false,
        mock()
      );

      // Should not attempt removal
      expect(mockRemoveWorktree).not.toHaveBeenCalled();
    });

    it('refuses cleanup when other sessions are using worktree', async () => {
      mockIsValidWorktreePath.mockReturnValue(true);

      const session = createMockSession({
        worktreeInfo: {
          repoRoot: '/repo',
          worktreePath: '/home/user/.claude-threads/worktrees/repo-wt',
          branch: 'feature',
        },
        isWorktreeOwner: true,
      });

      await worktree.cleanupWorktreeCommand(
        session,
        'testuser',
        () => true, // Other sessions using it
        mock()
      );

      // Should not remove worktree
      expect(mockRemoveWorktree).not.toHaveBeenCalled();
      // Should not clear worktree info
      expect(session.worktreeInfo).toBeDefined();
    });
  });
});
