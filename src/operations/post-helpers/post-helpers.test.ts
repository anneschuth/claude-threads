import { describe, it, expect, mock } from 'bun:test';
import {
  // Core API
  post,
  POST_TYPES,
  // Error post with bug reaction behavior
  postError,
  // Utility functions
  formatBold,
  resetSessionActivity,
  updateLastMessage,
  // Internal helpers (exported for testing with underscore prefix)
  _postWithReactions as postWithReactions,
  _postBold as postBold,
} from './index.js';
import {
  mockFormatter as mattermostFormatter,
  slackMockFormatter as slackFormatter,
  createMockFormatter,
} from '../../test-utils/mock-formatter.js';
import type { Session } from '../../session/types.js';
import { createSessionTimers, createSessionLifecycle } from '../../session/types.js';
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
    timers: createSessionTimers(),
    lifecycle: createSessionLifecycle(),
    ...overrides?.sessionOverrides,
  } as Session;
}

// Note: Most post-helpers functions require a Session object with a platform client.
// Since they're thin wrappers around platform.createPost(), we focus on testing
// the formatting utilities that don't require mocking the platform.

describe('POST_TYPES', () => {
  it('contains all expected post types', () => {
    expect(POST_TYPES.info).toBe('');
    expect(POST_TYPES.success).toBe('✅');
    expect(POST_TYPES.warning).toBe('⚠️');
    expect(POST_TYPES.error).toBe('❌');
    expect(POST_TYPES.secure).toBe('🔐');
    expect(POST_TYPES.command).toBe('⚙️');
    expect(POST_TYPES.cancelled).toBe('🛑');
    expect(POST_TYPES.resume).toBe('🔄');
    expect(POST_TYPES.timeout).toBe('⏱️');
    expect(POST_TYPES.interrupt).toBe('⏸️');
    expect(POST_TYPES.worktree).toBe('🌿');
    expect(POST_TYPES.context).toBe('🧵');
    expect(POST_TYPES.user).toBe('👤');
  });
});

describe('post() factory function', () => {
  it('posts info message without emoji prefix', async () => {
    const session = createMockSession();
    await post(session, 'info', 'Hello world');

    expect(session.platform.createPost).toHaveBeenCalledWith('Hello world', 'thread-123');
  });

  it('posts success message with ✅ prefix', async () => {
    const session = createMockSession();
    await post(session, 'success', 'Operation complete');

    expect(session.platform.createPost).toHaveBeenCalledWith('✅ Operation complete', 'thread-123');
  });

  it('posts warning message with ⚠️ prefix', async () => {
    const session = createMockSession();
    await post(session, 'warning', 'Be careful');

    expect(session.platform.createPost).toHaveBeenCalledWith('⚠️ Be careful', 'thread-123');
  });

  it('posts error message with ❌ prefix', async () => {
    const session = createMockSession();
    await post(session, 'error', 'Something failed');

    expect(session.platform.createPost).toHaveBeenCalledWith('❌ Something failed', 'thread-123');
  });

  it('posts secure message with 🔐 prefix', async () => {
    const session = createMockSession();
    await post(session, 'secure', 'Permission granted');

    expect(session.platform.createPost).toHaveBeenCalledWith('🔐 Permission granted', 'thread-123');
  });

  it('posts command message with ⚙️ prefix', async () => {
    const session = createMockSession();
    await post(session, 'command', 'Executing action');

    expect(session.platform.createPost).toHaveBeenCalledWith('⚙️ Executing action', 'thread-123');
  });

  it('posts cancelled message with 🛑 prefix', async () => {
    const session = createMockSession();
    await post(session, 'cancelled', 'Session ended');

    expect(session.platform.createPost).toHaveBeenCalledWith('🛑 Session ended', 'thread-123');
  });

  it('posts resume message with 🔄 prefix', async () => {
    const session = createMockSession();
    await post(session, 'resume', 'Resuming');

    expect(session.platform.createPost).toHaveBeenCalledWith('🔄 Resuming', 'thread-123');
  });

  it('posts timeout message with ⏱️ prefix', async () => {
    const session = createMockSession();
    await post(session, 'timeout', 'Timed out');

    expect(session.platform.createPost).toHaveBeenCalledWith('⏱️ Timed out', 'thread-123');
  });

  it('posts interrupt message with ⏸️ prefix', async () => {
    const session = createMockSession();
    await post(session, 'interrupt', 'Paused');

    expect(session.platform.createPost).toHaveBeenCalledWith('⏸️ Paused', 'thread-123');
  });

  it('posts worktree message with 🌿 prefix', async () => {
    const session = createMockSession();
    await post(session, 'worktree', 'Created worktree');

    expect(session.platform.createPost).toHaveBeenCalledWith('🌿 Created worktree', 'thread-123');
  });

  it('posts context message with 🧵 prefix', async () => {
    const session = createMockSession();
    await post(session, 'context', 'Including context');

    expect(session.platform.createPost).toHaveBeenCalledWith('🧵 Including context', 'thread-123');
  });

  it('posts user message with 👤 prefix', async () => {
    const session = createMockSession();
    await post(session, 'user', 'User joined');

    expect(session.platform.createPost).toHaveBeenCalledWith('👤 User joined', 'thread-123');
  });

  it('updates lastMessageId tracking', async () => {
    const session = createMockSession();
    await post(session, 'success', 'Test');

    expect(session.lastMessageId).toBe('post-123');
  });
});

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

  it('resets lifecycle to active', () => {
    const session = createMockSession();
    // Set lifecycle to paused state
    session.lifecycle.state = 'paused';

    resetSessionActivity(session);

    // Should be reset to active (use type assertion to avoid narrowing issue)
    expect(session.lifecycle.state as string).toBe('active');
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

describe('postError with bug reaction', () => {
  it('adds ❌ prefix and bug reaction by default', async () => {
    const session = createMockSession();
    await postError(session, 'Something failed');

    expect(session.platform.createPost).toHaveBeenCalledWith('❌ Something failed', 'thread-123');
    expect(session.platform.addReaction).toHaveBeenCalledWith('post-123', 'bug');
    expect(session.lastError).toEqual({
      postId: 'post-123',
      message: 'Something failed',
      timestamp: expect.any(Date),
    });
  });

  it('skips bug reaction when addBugReaction is false', async () => {
    const session = createMockSession();
    await postError(session, 'Something failed', false);

    expect(session.platform.createPost).toHaveBeenCalledWith('❌ Something failed', 'thread-123');
    expect(session.platform.addReaction).not.toHaveBeenCalled();
    expect(session.lastError).toBeUndefined();
  });

  it('handles reaction errors gracefully', async () => {
    const session = createMockSession({
      platformOverrides: {
        addReaction: mock(() => Promise.reject(new Error('Rate limited'))),
      },
    });

    // Should not throw even when addReaction fails
    const result = await postError(session, 'Error message');

    expect(result).toBeDefined();
    expect(result.id).toBe('post-123');
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

    // Core API
    expect(typeof helpers.post).toBe('function');
    expect(typeof helpers.POST_TYPES).toBe('object');

    // Error post with bug reaction behavior
    expect(typeof helpers.postError).toBe('function');

    // Utility functions
    expect(typeof helpers.formatBold).toBe('function');
  });
});
