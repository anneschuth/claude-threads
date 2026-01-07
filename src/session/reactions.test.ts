/**
 * Tests for session/reactions.ts - User reaction handling
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import {
  handleQuestionReaction,
  handleApprovalReaction,
  handleMessageApprovalReaction,
  handleTaskToggleReaction,
  handleExistingWorktreeReaction,
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
    currentPostId: null,
    currentPostContent: '',
    pendingContent: '',
    pendingApproval: null,
    pendingQuestionSet: null,
    pendingMessageApproval: null,
    planApproved: false,
    sessionAllowedUsers: new Set(['testuser']),
    forceInteractivePermissions: false,
    sessionStartPostId: 'start_post',
    tasksPostId: null,
    lastTasksContent: null,
    tasksCompleted: false,
    tasksMinimized: false,
    activeSubagents: new Map(),
    updateTimer: null,
    typingTimer: null,
    timeoutWarningPosted: false,
    isRestarting: false,
    isResumed: false,
    worktreeInfo: undefined,
    pendingWorktreePrompt: false,
    worktreePromptPostId: undefined,
    worktreePromptDisabled: false,
    queuedPrompt: undefined,
    firstPrompt: 'test prompt',
    pendingContextPrompt: undefined,
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
      appendContent: mock(() => {}),
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

describe('handleQuestionReaction', () => {
  let platform: PlatformClient & { posts: Map<string, string> };
  let session: Session;
  let ctx: SessionContext;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    ctx = createMockContext();
  });

  test('does nothing if no pending question set', async () => {
    session.pendingQuestionSet = null;
    await handleQuestionReaction(session, 'post1', 'one', 'testuser', ctx);
    expect(platform.updatePost).not.toHaveBeenCalled();
  });

  test('does nothing if invalid emoji index', async () => {
    session.pendingQuestionSet = {
      toolUseId: 'tool1',
      questions: [{ header: 'Q1', question: 'What?', options: [{ label: 'A', description: 'Desc A' }], answer: null }],
      currentIndex: 0,
      currentPostId: 'post1',
    };
    // 'invalid' is not a number emoji
    await handleQuestionReaction(session, 'post1', 'invalid', 'testuser', ctx);
    expect(platform.updatePost).not.toHaveBeenCalled();
  });

  test('records answer and moves to next question', async () => {
    session.pendingQuestionSet = {
      toolUseId: 'tool1',
      questions: [
        { header: 'Q1', question: 'First?', options: [{ label: 'A', description: 'Desc A' }, { label: 'B', description: 'Desc B' }], answer: null },
        { header: 'Q2', question: 'Second?', options: [{ label: 'X', description: 'Desc X' }], answer: null },
      ],
      currentIndex: 0,
      currentPostId: 'post1',
    };

    await handleQuestionReaction(session, 'post1', 'one', 'testuser', ctx);

    expect(session.pendingQuestionSet!.questions[0].answer).toBe('A');
    expect(session.pendingQuestionSet!.currentIndex).toBe(1);
    expect(platform.updatePost).toHaveBeenCalled();
  });

  test('sends answers when all questions answered', async () => {
    session.pendingQuestionSet = {
      toolUseId: 'tool1',
      questions: [
        { header: 'Q1', question: 'Only one?', options: [{ label: 'Yes', description: 'Desc' }], answer: null },
      ],
      currentIndex: 0,
      currentPostId: 'post1',
    };

    await handleQuestionReaction(session, 'post1', 'one', 'testuser', ctx);

    expect(session.pendingQuestionSet).toBeNull();
    expect(session.claude.sendMessage).toHaveBeenCalled();
    expect(ctx.ops.startTyping).toHaveBeenCalled();
  });
});

describe('handleApprovalReaction', () => {
  let platform: PlatformClient & { posts: Map<string, string> };
  let session: Session;
  let ctx: SessionContext;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    ctx = createMockContext();
  });

  test('does nothing if no pending approval', async () => {
    session.pendingApproval = null;
    await handleApprovalReaction(session, '+1', 'testuser', ctx);
    expect(platform.updatePost).not.toHaveBeenCalled();
  });

  test('approves plan on thumbs up', async () => {
    session.pendingApproval = { postId: 'post1', toolUseId: 'tool1', type: 'plan' };

    await handleApprovalReaction(session, '+1', 'testuser', ctx);

    expect(session.pendingApproval).toBeNull();
    expect(session.planApproved).toBe(true);
    expect(session.claude.sendMessage).toHaveBeenCalled();
    expect(platform.updatePost).toHaveBeenCalled();
  });

  test('rejects plan on thumbs down', async () => {
    session.pendingApproval = { postId: 'post1', toolUseId: 'tool1', type: 'plan' };

    await handleApprovalReaction(session, '-1', 'testuser', ctx);

    expect(session.pendingApproval).toBeNull();
    expect(session.planApproved).toBe(false);
    expect(session.claude.sendMessage).toHaveBeenCalled();
  });

  test('ignores non-approval emojis', async () => {
    session.pendingApproval = { postId: 'post1', toolUseId: 'tool1', type: 'plan' };

    await handleApprovalReaction(session, 'heart', 'testuser', ctx);

    expect(session.pendingApproval).not.toBeNull();
  });
});

describe('handleMessageApprovalReaction', () => {
  let platform: PlatformClient & { posts: Map<string, string> };
  let session: Session;
  let ctx: SessionContext;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    ctx = createMockContext();
  });

  test('does nothing if no pending message approval', async () => {
    session.pendingMessageApproval = null;
    await handleMessageApprovalReaction(session, '+1', 'testuser', ctx);
    expect(platform.updatePost).not.toHaveBeenCalled();
  });

  test('only session owner can approve', async () => {
    session.pendingMessageApproval = {
      postId: 'post1',
      fromUser: 'outsider',
      originalMessage: 'hello',
    };

    // Random user can't approve
    await handleMessageApprovalReaction(session, '+1', 'randomuser', ctx);
    expect(session.pendingMessageApproval).not.toBeNull();
  });

  test('session owner can approve message', async () => {
    session.pendingMessageApproval = {
      postId: 'post1',
      fromUser: 'outsider',
      originalMessage: 'hello',
    };

    await handleMessageApprovalReaction(session, '+1', 'testuser', ctx);

    expect(session.pendingMessageApproval).toBeNull();
    expect(session.claude.sendMessage).toHaveBeenCalledWith('hello');
    expect(platform.updatePost).toHaveBeenCalled();
  });

  test('globally allowed user can approve', async () => {
    session.pendingMessageApproval = {
      postId: 'post1',
      fromUser: 'outsider',
      originalMessage: 'hello',
    };

    await handleMessageApprovalReaction(session, '+1', 'admin', ctx);

    expect(session.pendingMessageApproval).toBeNull();
  });

  test('invite emoji adds user to session', async () => {
    session.pendingMessageApproval = {
      postId: 'post1',
      fromUser: 'newuser',
      originalMessage: 'hello',
    };

    await handleMessageApprovalReaction(session, 'white_check_mark', 'testuser', ctx);

    expect(session.sessionAllowedUsers.has('newuser')).toBe(true);
    expect(session.pendingMessageApproval).toBeNull();
    expect(ctx.ops.updateSessionHeader).toHaveBeenCalled();
  });

  test('deny emoji rejects message', async () => {
    session.pendingMessageApproval = {
      postId: 'post1',
      fromUser: 'outsider',
      originalMessage: 'hello',
    };

    await handleMessageApprovalReaction(session, '-1', 'testuser', ctx);

    expect(session.pendingMessageApproval).toBeNull();
    expect(session.claude.sendMessage).not.toHaveBeenCalled();
  });
});

describe('handleTaskToggleReaction', () => {
  let platform: PlatformClient & { posts: Map<string, string> };
  let session: Session;
  let ctx: SessionContext;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    ctx = createMockContext();
  });

  test('returns false if no tasks post', async () => {
    session.tasksPostId = null;
    const result = await handleTaskToggleReaction(session, 'added', ctx);
    expect(result).toBe(false);
  });

  test('returns false if no last tasks content', async () => {
    session.tasksPostId = 'tasks1';
    session.lastTasksContent = null;
    const result = await handleTaskToggleReaction(session, 'added', ctx);
    expect(result).toBe(false);
  });

  test('minimizes tasks on reaction added', async () => {
    session.tasksPostId = 'tasks1';
    session.lastTasksContent = '---\n📋 **Tasks** (2/5 · 40%)\n- Task 1\n- Task 2';
    session.tasksMinimized = false;

    const result = await handleTaskToggleReaction(session, 'added', ctx);

    expect(result).toBe(true);
    expect(session.tasksMinimized).toBe(true);
    expect(platform.updatePost).toHaveBeenCalled();
  });

  test('expands tasks on reaction removed', async () => {
    session.tasksPostId = 'tasks1';
    session.lastTasksContent = '---\n📋 **Tasks** (2/5 · 40%)\n- Task 1\n- Task 2';
    session.tasksMinimized = true;

    const result = await handleTaskToggleReaction(session, 'removed', ctx);

    expect(result).toBe(true);
    expect(session.tasksMinimized).toBe(false);
    expect(platform.updatePost).toHaveBeenCalled();
  });

  test('skips update if already in desired state', async () => {
    session.tasksPostId = 'tasks1';
    session.lastTasksContent = '---\n📋 **Tasks** (2/5 · 40%)\n- Task 1';
    session.tasksMinimized = true;

    const result = await handleTaskToggleReaction(session, 'added', ctx);

    expect(result).toBe(true);
    expect(platform.updatePost).not.toHaveBeenCalled();
  });

  test('parses in-progress task for minimized display', async () => {
    session.tasksPostId = 'tasks1';
    session.lastTasksContent = '---\n📋 **Tasks** (1/3 · 33%)\n🔄 **Running tests** (15s)';
    session.tasksMinimized = false;

    await handleTaskToggleReaction(session, 'added', ctx);

    const updateCall = (platform.updatePost as any).mock.calls[0];
    expect(updateCall[1]).toContain('Running tests');
    expect(updateCall[1]).toContain('15s');
  });
});

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
