/**
 * Tests for session/reactions.ts - User reaction handling
 *
 * NOTE: Question, approval, and message approval reaction tests have been moved
 * to operations/executors/interactive.test.ts since that functionality is now
 * handled by InteractiveExecutor via MessageManager.handleReaction().
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import {
  handleExistingWorktreeReaction,
  handleUpdateReaction,
  type UpdateReactionHandler,
} from './reactions.js';
import type { Session } from './types.js';
import type { SessionContext } from './context.js';
import type { PlatformClient, PlatformPost } from '../platform/index.js';
import { createMockFormatter } from '../test-utils/mock-formatter.js';

// Mock platform client
function createMockPlatform() {
  const posts: Map<string, string> = new Map();
  let postIdCounter = 1;

  return {
    createPost: mock(async (message: string, _threadId?: string): Promise<PlatformPost> => {
      const id = `post_${postIdCounter++}`;
      posts.set(id, message);
      return {
        id,
        platformId: 'test',
        channelId: 'channel1',
        userId: 'bot',
        message,
        rootId: _threadId || '',
        createAt: Date.now(),
      };
    }),
    createInteractivePost: mock(async (message: string, _reactions: string[], _threadId?: string): Promise<PlatformPost> => {
      const id = `post_${postIdCounter++}`;
      posts.set(id, message);
      return {
        id,
        platformId: 'test',
        channelId: 'channel1',
        userId: 'bot',
        message,
        rootId: _threadId || '',
        createAt: Date.now(),
      };
    }),
    updatePost: mock(async (postId: string, message: string): Promise<PlatformPost> => {
      posts.set(postId, message);
      return {
        id: postId,
        platformId: 'test',
        channelId: 'channel1',
        userId: 'bot',
        message,
        rootId: '',
        createAt: Date.now(),
      };
    }),
    addReaction: mock(async (_postId: string, _emoji: string): Promise<void> => {}),
    getFormatter: () => createMockFormatter(),
    isUserAllowed: mock((username: string) => username === 'admin'),
    posts,
  } as unknown as PlatformClient & { posts: Map<string, string> };
}

// Create a minimal session for testing
function createTestSession(platform: PlatformClient): Session {
  return {
    platformId: 'test',
    threadId: 'thread1',
    sessionId: 'test:thread1',
    claudeSessionId: 'uuid-123',
    startedBy: 'testuser',
    startedByDisplayName: 'Test User',
    startedAt: new Date(),
    lastActivityAt: new Date(),
    sessionNumber: 1,
    platform,
    workingDir: '/test',
    claude: {
      isRunning: () => true,
      sendMessage: mock(() => {}),
      sendToolResult: mock(() => {}),
    } as any,
    planApproved: false,
    sessionAllowedUsers: new Set(['testuser']),
    forceInteractivePermissions: false,
    sessionStartPostId: 'start_post',
    tasksPostId: null,
    lastTasksContent: null,
    tasksCompleted: false,
    tasksMinimized: false,
    updateTimer: null,
    typingTimer: null,
    timeoutWarningPosted: false,
    isRestarting: false,
    isCancelled: false,
    isResumed: false,
    worktreeInfo: undefined,
    pendingWorktreePrompt: false,
    worktreePromptPostId: undefined,
    worktreePromptDisabled: false,
    queuedPrompt: undefined,
    firstPrompt: 'test prompt',
    needsContextPromptOnNextMessage: false,
    lifecyclePostId: undefined,
    sessionTitle: undefined,
    sessionDescription: undefined,
    pullRequestUrl: undefined,
    messageCount: 0,
    resumeFailCount: 0,
    pendingExistingWorktreePrompt: undefined,
    isProcessing: false,
    hasClaudeResponded: false,
    wasInterrupted: false,
    inProgressTaskStart: null,
    activeToolStarts: new Map(),
    statusBarTimer: null,
    recentEvents: [],
    messageManager: undefined,
  };
}

// Create mock context
function createMockContext(): SessionContext {
  return {
    config: {
      workingDir: '/test',
      skipPermissions: false,
      chromeEnabled: false,
      debug: false,
      maxSessions: 5,
    },
    state: {
      sessions: new Map(),
      postIndex: new Map(),
      platforms: new Map(),
      sessionStore: {} as any,
      isShuttingDown: false,
    },
    ops: {
      getSessionId: (pid, tid) => `${pid}:${tid}`,
      findSessionByThreadId: () => undefined,
      registerPost: mock(() => {}),
      flush: mock(async () => {}),
      startTyping: mock(() => {}),
      stopTyping: mock(() => {}),
      buildMessageContent: mock(async (text) => text),
      bumpTasksToBottom: mock(async () => {}),
      persistSession: mock(() => {}),
      unpersistSession: mock(() => {}),
      updateSessionHeader: mock(async () => {}),
      updateStickyMessage: mock(async () => {}),
      handleEvent: mock(() => {}),
      handleExit: mock(async () => {}),
      killSession: mock(async () => {}),
      shouldPromptForWorktree: mock(async () => null),
      postWorktreePrompt: mock(async () => {}),
      offerContextPrompt: mock(async () => false),
      emitSessionAdd: mock(() => {}),
      emitSessionUpdate: mock(() => {}),
      emitSessionRemove: mock(() => {}),
      registerWorktreeUser: mock(() => {}),
      unregisterWorktreeUser: mock(() => {}),
      hasOtherSessionsUsingWorktree: mock(() => false),
    },
  };
}

// NOTE: handleQuestionReaction, handleApprovalReaction, and handleMessageApprovalReaction
// tests have been removed. These functions were deleted from reactions.ts and their
// functionality is now handled by MessageManager.handleReaction() which routes to
// InteractiveExecutor. Tests for that functionality should be in
// operations/executors/interactive.test.ts

// NOTE: Task list toggle tests have been moved.
// Task toggle is now handled by MessageManager.handleTaskListToggle() which
// delegates to TaskListExecutor.toggleMinimize().
// See src/operations/executors/task-list.ts for the implementation.

describe('handleExistingWorktreeReaction', () => {
  let platform: PlatformClient & { posts: Map<string, string> };
  let session: Session;
  let ctx: SessionContext;
  let switchToWorktree: ReturnType<typeof mock>;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    ctx = createMockContext();
    switchToWorktree = mock(async () => {});
  });

  test('returns false if no pending prompt', async () => {
    session.pendingExistingWorktreePrompt = undefined;
    const result = await handleExistingWorktreeReaction(session, 'post1', '+1', 'testuser', ctx, switchToWorktree);
    expect(result).toBe(false);
  });

  test('returns false if wrong post', async () => {
    session.pendingExistingWorktreePrompt = {
      postId: 'post2',
      branch: 'feature',
      worktreePath: '/path/to/worktree',
      username: 'testuser',
    };
    const result = await handleExistingWorktreeReaction(session, 'post1', '+1', 'testuser', ctx, switchToWorktree);
    expect(result).toBe(false);
  });

  test('returns false if non-owner tries to respond', async () => {
    session.pendingExistingWorktreePrompt = {
      postId: 'post1',
      branch: 'feature',
      worktreePath: '/path/to/worktree',
      username: 'testuser',
    };
    const result = await handleExistingWorktreeReaction(session, 'post1', '+1', 'otheruser', ctx, switchToWorktree);
    expect(result).toBe(false);
  });

  test('joins worktree on approval', async () => {
    session.pendingExistingWorktreePrompt = {
      postId: 'post1',
      branch: 'feature',
      worktreePath: '/path/to/worktree',
      username: 'testuser',
    };

    const result = await handleExistingWorktreeReaction(session, 'post1', '+1', 'testuser', ctx, switchToWorktree);

    expect(result).toBe(true);
    expect(session.pendingExistingWorktreePrompt).toBeUndefined();
    expect(switchToWorktree).toHaveBeenCalledWith('thread1', '/path/to/worktree', 'testuser');
  });

  test('skips worktree on denial', async () => {
    session.pendingExistingWorktreePrompt = {
      postId: 'post1',
      branch: 'feature',
      worktreePath: '/path/to/worktree',
      username: 'testuser',
    };

    const result = await handleExistingWorktreeReaction(session, 'post1', '-1', 'testuser', ctx, switchToWorktree);

    expect(result).toBe(true);
    expect(session.pendingExistingWorktreePrompt).toBeUndefined();
    expect(switchToWorktree).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleUpdateReaction tests
// ---------------------------------------------------------------------------

describe('handleUpdateReaction', () => {
  let platform: ReturnType<typeof createMockPlatform>;
  let session: Session;
  let ctx: SessionContext;
  let updateHandler: UpdateReactionHandler;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    ctx = createMockContext();
    updateHandler = {
      forceUpdate: mock(async () => {}),
      deferUpdate: mock(() => {}),
    };
  });

  test('returns false if no pending prompt', async () => {
    session.pendingUpdatePrompt = undefined;
    const result = await handleUpdateReaction(session, 'post1', '+1', 'testuser', ctx, updateHandler);
    expect(result).toBe(false);
  });

  test('returns false if wrong post', async () => {
    session.pendingUpdatePrompt = { postId: 'post2' };
    const result = await handleUpdateReaction(session, 'post1', '+1', 'testuser', ctx, updateHandler);
    expect(result).toBe(false);
  });

  test('returns false if non-owner tries to respond', async () => {
    session.pendingUpdatePrompt = { postId: 'post1' };
    const result = await handleUpdateReaction(session, 'post1', '+1', 'otheruser', ctx, updateHandler);
    expect(result).toBe(false);
  });

  test('returns false for unrelated emoji', async () => {
    session.pendingUpdatePrompt = { postId: 'post1' };
    const result = await handleUpdateReaction(session, 'post1', 'smile', 'testuser', ctx, updateHandler);
    expect(result).toBe(false);
  });

  test('triggers force update on approval emoji', async () => {
    session.pendingUpdatePrompt = { postId: 'post1' };

    const result = await handleUpdateReaction(session, 'post1', '+1', 'testuser', ctx, updateHandler);

    expect(result).toBe(true);
    expect(session.pendingUpdatePrompt).toBeUndefined();
    expect(updateHandler.forceUpdate).toHaveBeenCalled();
    expect(updateHandler.deferUpdate).not.toHaveBeenCalled();
    expect(platform.updatePost).toHaveBeenCalledWith('post1', expect.stringContaining('Forcing update'));
  });

  test('triggers defer on denial emoji', async () => {
    session.pendingUpdatePrompt = { postId: 'post1' };

    const result = await handleUpdateReaction(session, 'post1', '-1', 'testuser', ctx, updateHandler);

    expect(result).toBe(true);
    expect(session.pendingUpdatePrompt).toBeUndefined();
    expect(updateHandler.deferUpdate).toHaveBeenCalledWith(60);
    expect(updateHandler.forceUpdate).not.toHaveBeenCalled();
    expect(platform.updatePost).toHaveBeenCalledWith('post1', expect.stringContaining('Update deferred'));
  });

  test('allows globally allowed users to respond', async () => {
    session.pendingUpdatePrompt = { postId: 'post1' };
    // Mock isUserAllowed to return true for 'alloweduser'
    (platform as any).isUserAllowed = mock((username: string) => username === 'alloweduser');

    const result = await handleUpdateReaction(session, 'post1', '+1', 'alloweduser', ctx, updateHandler);

    expect(result).toBe(true);
    expect(updateHandler.forceUpdate).toHaveBeenCalled();
  });

  test('persists session after handling', async () => {
    session.pendingUpdatePrompt = { postId: 'post1' };

    await handleUpdateReaction(session, 'post1', '+1', 'testuser', ctx, updateHandler);

    expect(ctx.ops.persistSession).toHaveBeenCalledWith(session);
  });
});
