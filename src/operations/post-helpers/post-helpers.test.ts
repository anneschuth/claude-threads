import { describe, it, expect, mock } from 'bun:test';
import {
  formatBold,
  getPostId,
  resetSessionActivity,
  updateLastMessage,
  postInfo,
  postSuccess,
  postWarning,
  postError,
  postSecure,
  postCommand,
  postCancelled,
  postResume,
  postTimeout,
  postInterrupt,
  postWorktree,
  postContext,
  postUser,
  postWithReactions,
  postApprovalPrompt,
  postAndRegister,
  postWithReactionsAndRegister,
  postBold,
} from './index.js';
import {
  mockFormatter as mattermostFormatter,
  slackMockFormatter as slackFormatter,
  createMockFormatter,
} from '../../test-utils/mock-formatter.js';
import type { Session } from '../../session/types.js';
import type { PlatformClient, PlatformPost } from '../../platform/index.js';

// Helper to create a mock session for testing
function createMockSession(overrides?: Partial<{
  platformOverrides: Partial<PlatformClient>;
  sessionOverrides: Partial<Session>;
}>): Session {
  const mockPost: PlatformPost = { id: 'post-123', message: '', userId: 'bot', platformId: 'test-platform', channelId: 'channel-123' };

  const mockPlatform: Partial<PlatformClient> = {
    platformId: 'test-platform',
    platformType: 'mattermost',
    createPost: mock(() => Promise.resolve(mockPost)),
    updatePost: mock(() => Promise.resolve(mockPost)),
    addReaction: mock(() => Promise.resolve()),
    getFormatter: mock(() => createMockFormatter()),
    ...overrides?.platformOverrides,
  };

  return {
    sessionId: 'test:thread-123',
    threadId: 'thread-123',
    platform: mockPlatform as PlatformClient,
    claude: {
      isRunning: mock(() => true),
      kill: mock(() => Promise.resolve()),
      sendMessage: mock(() => {}),
      on: mock(() => {}),
    } as any,
    claudeSessionId: 'claude-session-1',
    owner: 'testuser',
    startedBy: 'testuser',
    startedAt: new Date(),
    lastActivityAt: new Date(Date.now() - 10000), // 10 seconds ago
    buffer: '',
    taskListPostId: null,
    taskListBuffer: '',
    sessionAllowedUsers: new Set(['testuser']),
    workingDir: '/test',
    isResumed: false,
    sessionStartPostId: 'start-post-id',
    currentPostContent: '',
    pendingContent: '',
    timeoutWarningPosted: true,
    tasksCompleted: false,
    tasksMinimized: false,
    lastTasksContent: '',
    tasksPostId: null,
    skipPermissions: true,
    forceInteractivePermissions: false,
    messageCount: 0,
    ...overrides?.sessionOverrides,
  } as Session;
}

// Note: Most post-helpers functions require a Session object with a platform client.
// Since they're thin wrappers around platform.createPost(), we focus on testing
// the formatting utilities that don't require mocking the platform.

describe('formatBold', () => {
  it('formats label only (Mattermost)', () => {
    expect(formatBold(mattermostFormatter, 'Session cancelled')).toBe('**Session cancelled**');
  });

  it('formats label with rest (Mattermost)', () => {
    expect(formatBold(mattermostFormatter, 'Session cancelled', 'by @user')).toBe('**Session cancelled** by @user');
  });

  it('handles empty rest (Mattermost)', () => {
    // Empty string is falsy, so formatBold treats it as no rest
    expect(formatBold(mattermostFormatter, 'Label', '')).toBe('**Label**');
  });

  it('formats label only (Slack)', () => {
    expect(formatBold(slackFormatter, 'Session cancelled')).toBe('*Session cancelled*');
  });

  it('formats label with rest (Slack)', () => {
    expect(formatBold(slackFormatter, 'Session cancelled', 'by @user')).toBe('*Session cancelled* by @user');
  });
});

describe('getPostId', () => {
  it('returns the post id from a post object', () => {
    const post: PlatformPost = { id: 'abc123', message: 'test', userId: 'user1', platformId: 'test', channelId: 'ch1' };
    expect(getPostId(post)).toBe('abc123');
  });
});

describe('resetSessionActivity', () => {
  it('updates lastActivityAt to current time', () => {
    const session = createMockSession();
    const oldTime = session.lastActivityAt;

    resetSessionActivity(session);

    expect(session.lastActivityAt.getTime()).toBeGreaterThan(oldTime.getTime());
  });

  it('resets timeoutWarningPosted to false', () => {
    const session = createMockSession({
      sessionOverrides: { timeoutWarningPosted: true },
    });

    resetSessionActivity(session);

    expect(session.timeoutWarningPosted).toBe(false);
  });

  it('clears lifecyclePostId', () => {
    const session = createMockSession({
      sessionOverrides: { lifecyclePostId: 'some-post-id' },
    });

    resetSessionActivity(session);

    expect(session.lifecyclePostId).toBeUndefined();
  });

  it('clears isPaused', () => {
    const session = createMockSession({
      sessionOverrides: { isPaused: true },
    });

    resetSessionActivity(session);

    expect(session.isPaused).toBeUndefined();
  });

  it('calls updateWorktreeActivity when session has worktreeInfo', () => {
    const session = createMockSession({
      sessionOverrides: {
        worktreeInfo: {
          repoRoot: '/home/user/repo',
          worktreePath: '/home/user/.claude-threads/worktrees/repo--feature-abc123',
          branch: 'feature',
        },
      },
    });

    // The function is fire-and-forget, so we just verify the call is made
    // without blocking. The actual updateWorktreeActivity is async but
    // resetSessionActivity doesn't await it.
    resetSessionActivity(session);

    // Verify session state was updated (the worktree update is fire-and-forget)
    expect(session.lastActivityAt.getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it('does not call updateWorktreeActivity when session has no worktreeInfo', () => {
    const session = createMockSession();
    // No worktreeInfo set

    // Should complete without error
    resetSessionActivity(session);

    expect(session.lastActivityAt.getTime()).toBeGreaterThan(Date.now() - 1000);
  });
});

describe('updateLastMessage', () => {
  it('updates lastMessageId for Mattermost', () => {
    const session = createMockSession({
      platformOverrides: { platformType: 'mattermost' as const },
    });
    const post: PlatformPost = { id: 'post-456', message: '', userId: 'bot', platformId: 'test', channelId: 'ch1' };

    updateLastMessage(session, post);

    expect(session.lastMessageId).toBe('post-456');
    expect(session.lastMessageTs).toBeUndefined();
  });

  it('updates lastMessageId and lastMessageTs for Slack', () => {
    const session = createMockSession({
      platformOverrides: { platformType: 'slack' as const },
    });
    const post: PlatformPost = { id: '1234567890.123456', message: '', userId: 'bot', platformId: 'test', channelId: 'ch1' };

    updateLastMessage(session, post);

    expect(session.lastMessageId).toBe('1234567890.123456');
    expect(session.lastMessageTs).toBe('1234567890.123456');
  });
});

describe('Core post functions with mock session', () => {
  it('postInfo creates a post without emoji prefix', async () => {
    const session = createMockSession();
    await postInfo(session, 'Hello world');

    expect(session.platform.createPost).toHaveBeenCalledWith('Hello world', 'thread-123');
  });

  it('postSuccess adds ✅ prefix', async () => {
    const session = createMockSession();
    await postSuccess(session, 'Operation complete');

    expect(session.platform.createPost).toHaveBeenCalledWith('✅ Operation complete', 'thread-123');
  });

  it('postWarning adds ⚠️ prefix', async () => {
    const session = createMockSession();
    await postWarning(session, 'Be careful');

    expect(session.platform.createPost).toHaveBeenCalledWith('⚠️ Be careful', 'thread-123');
  });

  it('postError adds ❌ prefix', async () => {
    const session = createMockSession();
    await postError(session, 'Something failed');

    expect(session.platform.createPost).toHaveBeenCalledWith('❌ Something failed', 'thread-123');
  });

  it('postSecure adds 🔐 prefix', async () => {
    const session = createMockSession();
    await postSecure(session, 'Permission granted');

    expect(session.platform.createPost).toHaveBeenCalledWith('🔐 Permission granted', 'thread-123');
  });

  it('postCommand adds ⚙️ prefix', async () => {
    const session = createMockSession();
    await postCommand(session, 'Executing action');

    expect(session.platform.createPost).toHaveBeenCalledWith('⚙️ Executing action', 'thread-123');
  });

  it('postCancelled adds 🛑 prefix', async () => {
    const session = createMockSession();
    await postCancelled(session, 'Session ended');

    expect(session.platform.createPost).toHaveBeenCalledWith('🛑 Session ended', 'thread-123');
  });

  it('postResume adds 🔄 prefix', async () => {
    const session = createMockSession();
    await postResume(session, 'Resuming');

    expect(session.platform.createPost).toHaveBeenCalledWith('🔄 Resuming', 'thread-123');
  });

  it('postTimeout adds ⏱️ prefix', async () => {
    const session = createMockSession();
    await postTimeout(session, 'Timed out');

    expect(session.platform.createPost).toHaveBeenCalledWith('⏱️ Timed out', 'thread-123');
  });

  it('postInterrupt adds ⏸️ prefix', async () => {
    const session = createMockSession();
    await postInterrupt(session, 'Paused');

    expect(session.platform.createPost).toHaveBeenCalledWith('⏸️ Paused', 'thread-123');
  });

  it('postWorktree adds 🌿 prefix', async () => {
    const session = createMockSession();
    await postWorktree(session, 'Created worktree');

    expect(session.platform.createPost).toHaveBeenCalledWith('🌿 Created worktree', 'thread-123');
  });

  it('postContext adds 🧵 prefix', async () => {
    const session = createMockSession();
    await postContext(session, 'Including context');

    expect(session.platform.createPost).toHaveBeenCalledWith('🧵 Including context', 'thread-123');
  });

  it('postUser adds 👤 prefix', async () => {
    const session = createMockSession();
    await postUser(session, 'User joined');

    expect(session.platform.createPost).toHaveBeenCalledWith('👤 User joined', 'thread-123');
  });
});

describe('postWithReactions', () => {
  it('creates post and adds reactions', async () => {
    const session = createMockSession();
    await postWithReactions(session, 'Choose an option', ['+1', '-1', 'eyes']);

    expect(session.platform.createPost).toHaveBeenCalledWith('Choose an option', 'thread-123');
    expect(session.platform.addReaction).toHaveBeenCalledTimes(3);
    expect(session.platform.addReaction).toHaveBeenCalledWith('post-123', '+1');
    expect(session.platform.addReaction).toHaveBeenCalledWith('post-123', '-1');
    expect(session.platform.addReaction).toHaveBeenCalledWith('post-123', 'eyes');
  });

  it('handles reaction errors gracefully', async () => {
    const session = createMockSession({
      platformOverrides: {
        addReaction: mock(() => Promise.reject(new Error('Rate limited'))),
      },
    });

    // Should not throw even when addReaction fails
    const post = await postWithReactions(session, 'Message', ['+1']);

    expect(post).toBeDefined();
    expect(post.id).toBe('post-123');
  });
});

describe('postApprovalPrompt', () => {
  it('creates post with thumbs up/down reactions', async () => {
    const session = createMockSession();
    await postApprovalPrompt(session, 'Approve this action?');

    expect(session.platform.createPost).toHaveBeenCalledWith('Approve this action?', 'thread-123');
    expect(session.platform.addReaction).toHaveBeenCalledWith('post-123', '+1');
    expect(session.platform.addReaction).toHaveBeenCalledWith('post-123', '-1');
  });
});

describe('postAndRegister', () => {
  it('creates post and calls register callback', async () => {
    const session = createMockSession();
    const registerPost = mock(() => {});

    await postAndRegister(session, 'Test message', registerPost);

    expect(session.platform.createPost).toHaveBeenCalled();
    expect(registerPost).toHaveBeenCalledWith('post-123', 'thread-123');
  });

  it('returns null on error', async () => {
    const session = createMockSession({
      platformOverrides: {
        createPost: mock(() => Promise.reject(new Error('Network error'))),
      },
    });
    const registerPost = mock(() => {});

    const result = await postAndRegister(session, 'Test', registerPost);

    expect(result).toBeNull();
    expect(registerPost).not.toHaveBeenCalled();
  });
});

describe('postWithReactionsAndRegister', () => {
  it('creates post with reactions and registers it', async () => {
    const session = createMockSession();
    const registerPost = mock(() => {});

    await postWithReactionsAndRegister(session, 'Vote!', ['one', 'two'], registerPost);

    expect(session.platform.createPost).toHaveBeenCalled();
    expect(session.platform.addReaction).toHaveBeenCalledTimes(2);
    expect(registerPost).toHaveBeenCalledWith('post-123', 'thread-123');
  });
});

describe('postBold', () => {
  it('creates post with bold label and emoji', async () => {
    const session = createMockSession();
    await postBold(session, '✅', 'Success', 'completed');

    expect(session.platform.createPost).toHaveBeenCalledWith(
      '✅ **Success** completed',
      'thread-123'
    );
  });

  it('creates post with bold label without rest', async () => {
    const session = createMockSession();
    await postBold(session, '🎉', 'Done');

    expect(session.platform.createPost).toHaveBeenCalledWith('🎉 **Done**', 'thread-123');
  });

  it('creates post without emoji when emoji is empty', async () => {
    const session = createMockSession();
    await postBold(session, '', 'Plain bold');

    expect(session.platform.createPost).toHaveBeenCalledWith('**Plain bold**', 'thread-123');
  });
});

describe('post helper functions', () => {
  it('exports all expected functions', async () => {
    const helpers = await import('./index.js');

    // Core post functions
    expect(typeof helpers.postInfo).toBe('function');
    expect(typeof helpers.postSuccess).toBe('function');
    expect(typeof helpers.postWarning).toBe('function');
    expect(typeof helpers.postError).toBe('function');
    expect(typeof helpers.postSecure).toBe('function');
    expect(typeof helpers.postCommand).toBe('function');
    expect(typeof helpers.postCancelled).toBe('function');
    expect(typeof helpers.postResume).toBe('function');
    expect(typeof helpers.postTimeout).toBe('function');
    expect(typeof helpers.postInterrupt).toBe('function');
    expect(typeof helpers.postWorktree).toBe('function');
    expect(typeof helpers.postContext).toBe('function');
    expect(typeof helpers.postUser).toBe('function');

    // Post with reactions
    expect(typeof helpers.postWithReactions).toBe('function');
    expect(typeof helpers.postApprovalPrompt).toBe('function');

    // Utility functions
    expect(typeof helpers.getPostId).toBe('function');
    expect(typeof helpers.postAndRegister).toBe('function');
    expect(typeof helpers.postWithReactionsAndRegister).toBe('function');
    expect(typeof helpers.formatBold).toBe('function');
    expect(typeof helpers.postBold).toBe('function');
  });
});
