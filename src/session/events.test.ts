/**
 * Tests for events.ts - Pre/post processing and session-specific side effects
 *
 * NOTE: Main event handling (formatting, tool handling) is now tested in
 * src/operations/ tests. This file tests session-specific side effects that
 * wrap the MessageManager.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import {
  handleEventPreProcessing,
  handleEventPostProcessing,
  handleSubagentToggleReaction,
  postCurrentQuestion,
} from './events.js';
import type { SessionContext } from './context.js';
import type { Session } from './types.js';
import type { PlatformClient, PlatformPost } from '../platform/index.js';
import { createMockFormatter } from '../test-utils/mock-formatter.js';

// Mock platform client
function createMockPlatform() {
  const posts: Map<string, string> = new Map();
  let postIdCounter = 1;

  const mockPlatform = {
    getBotUser: mock(async () => ({
      id: 'bot',
      username: 'bot',
      displayName: 'Bot',
    })),
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
    deletePost: mock(async (postId: string): Promise<void> => {
      posts.delete(postId);
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
    pinPost: mock(async (_postId: string): Promise<void> => {}),
    unpinPost: mock(async (_postId: string): Promise<void> => {}),
    sendTyping: mock(() => {}),
    getFormatter: () => createMockFormatter(),
    getThreadHistory: mock(async (_threadId: string, _options?: { limit?: number }) => {
      return [];
    }),
    posts,
  };

  return mockPlatform as unknown as PlatformClient & { posts: Map<string, string> };
}

// Create a minimal session for testing
function createTestSession(platform: PlatformClient): Session {
  return {
    platformId: 'test',
    threadId: 'thread1',
    sessionId: 'test:thread1',
    claudeSessionId: 'uuid-123',
    startedBy: 'testuser',
    startedAt: new Date(),
    lastActivityAt: new Date(),
    sessionNumber: 1,
    platform,
    workingDir: '/test',
    claude: {
      isRunning: () => true,
      sendMessage: mock(() => {}),
      getStatusData: () => null,
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
    subagentUpdateTimer: null,
    timeoutWarningPosted: false,
    isRestarting: false,
    isCancelled: false,
    isResumed: false,
    resumeFailCount: 0,
    wasInterrupted: false,
    inProgressTaskStart: null,
    activeToolStarts: new Map(),
    messageCount: 0,
    statusBarTimer: null,
    hasClaudeResponded: false,
    isProcessing: false,
    recentEvents: [],
  };
}

function createSessionContext(): SessionContext {
  return {
    config: {
      debug: false,
      workingDir: '/test',
      skipPermissions: true,
      chromeEnabled: false,
      maxSessions: 5,
    },
    state: {
      sessions: new Map(),
      postIndex: new Map(),
      platforms: new Map(),
      sessionStore: { save: () => {}, remove: () => {}, load: () => new Map(), findByPostId: () => undefined, cleanStale: () => [] } as any,
      isShuttingDown: false,
    },
    ops: {
      getSessionId: (_p, t) => t,
      findSessionByThreadId: () => undefined,
      registerPost: mock((_postId: string, _threadId: string) => {}),
      flush: mock(async (_session: Session) => {}),
      startTyping: mock((_session: Session) => {}),
      stopTyping: mock((_session: Session) => {}),
      appendContent: mock((_session: Session, _text: string) => {}),
      bumpTasksToBottom: mock(async (_session: Session) => {}),
      updateStickyMessage: mock(async () => {}),
      persistSession: mock((_session: Session) => {}),
      updateSessionHeader: mock(async (_session: Session) => {}),
      unpersistSession: mock((_sessionId: string) => {}),
      buildMessageContent: mock(async (text: string) => text),
      handleEvent: mock((_sessionId: string, _event: any) => {}),
      handleExit: mock(async (_sessionId: string, _code: number) => {}),
      killSession: mock(async (_threadId: string) => {}),
      shouldPromptForWorktree: mock(async (_session: Session) => null),
      postWorktreePrompt: mock(async (_session: Session, _reason: string) => {}),
      offerContextPrompt: mock(async (_session: Session, _queuedPrompt: string) => false),
      emitSessionAdd: mock(() => {}),
      emitSessionUpdate: mock(() => {}),
      emitSessionRemove: mock(() => {}),
      registerWorktreeUser: mock(() => {}),
      unregisterWorktreeUser: mock(() => {}),
      hasOtherSessionsUsingWorktree: mock(() => false),
    },
  };
}

describe('handleEventPreProcessing', () => {
  let platform: PlatformClient;
  let session: Session;
  let ctx: SessionContext;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    ctx = createSessionContext();
  });

  test('resets session activity on any event', () => {
    const oldTime = new Date(Date.now() - 10000);
    session.lastActivityAt = oldTime;

    handleEventPreProcessing(session, { type: 'assistant' }, ctx);

    expect(session.lastActivityAt.getTime()).toBeGreaterThan(oldTime.getTime());
  });

  test('sets hasClaudeResponded on first assistant event', () => {
    expect(session.hasClaudeResponded).toBe(false);

    handleEventPreProcessing(session, { type: 'assistant' }, ctx);

    expect(session.hasClaudeResponded).toBe(true);
    expect(ctx.ops.persistSession).toHaveBeenCalled();
  });

  test('sets hasClaudeResponded on first tool_use event', () => {
    expect(session.hasClaudeResponded).toBe(false);

    handleEventPreProcessing(session, { type: 'tool_use', tool_use: { name: 'Read' } }, ctx);

    expect(session.hasClaudeResponded).toBe(true);
  });

  test('does not set hasClaudeResponded again if already set', () => {
    session.hasClaudeResponded = true;
    const callCount = (ctx.ops.persistSession as ReturnType<typeof mock>).mock.calls.length;

    handleEventPreProcessing(session, { type: 'assistant' }, ctx);

    // Should not persist again
    expect((ctx.ops.persistSession as ReturnType<typeof mock>).mock.calls.length).toBe(callCount);
  });
});

describe('handleEventPostProcessing', () => {
  let platform: PlatformClient;
  let session: Session;
  let ctx: SessionContext;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    ctx = createSessionContext();
  });

  test('stops typing on result event', () => {
    handleEventPostProcessing(session, { type: 'result' }, ctx);

    expect(ctx.ops.stopTyping).toHaveBeenCalled();
    expect(session.isProcessing).toBe(false);
  });

  test('extracts PR URL from assistant text', () => {
    const event = {
      type: 'assistant' as const,
      message: {
        content: [{
          type: 'text',
          text: 'Created PR: https://github.com/user/repo/pull/123',
        }],
      },
    };

    handleEventPostProcessing(session, event, ctx);

    expect(session.pullRequestUrl).toBe('https://github.com/user/repo/pull/123');
    expect(ctx.ops.persistSession).toHaveBeenCalled();
  });

  test('does not overwrite existing PR URL', () => {
    session.pullRequestUrl = 'https://github.com/user/repo/pull/100';

    const event = {
      type: 'assistant' as const,
      message: {
        content: [{
          type: 'text',
          text: 'Created PR: https://github.com/user/repo/pull/200',
        }],
      },
    };

    handleEventPostProcessing(session, event, ctx);

    expect(session.pullRequestUrl).toBe('https://github.com/user/repo/pull/100');
  });

  test('tracks subagent completion from user tool_result event', async () => {
    // Set up a subagent
    session.activeSubagents.set('task_1', {
      postId: 'subagent_post_1',
      startTime: Date.now() - 5000,
      description: 'Test task',
      subagentType: 'Explore',
      isMinimized: false,
      isComplete: false,
      lastUpdateTime: Date.now(),
    });

    const event = {
      type: 'user' as const,
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'task_1',
          content: 'Done',
        }],
      },
    };

    handleEventPostProcessing(session, event, ctx);

    // Wait for async
    await new Promise(resolve => setTimeout(resolve, 10));

    const subagent = session.activeSubagents.get('task_1');
    expect(subagent?.isComplete).toBe(true);
  });
});

describe('handleSubagentToggleReaction', () => {
  let platform: PlatformClient;
  let session: Session;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);

    // Set up a subagent in the session
    session.activeSubagents.set('task_1', {
      postId: 'subagent_post_1',
      startTime: Date.now() - 5000,
      description: 'Test prompt for subagent',
      subagentType: 'general-purpose',
      isMinimized: false,
      isComplete: false,
      lastUpdateTime: Date.now(),
    });
  });

  test('returns false for non-subagent post', async () => {
    const result = await handleSubagentToggleReaction(session, 'other_post', 'added');
    expect(result).toBe(false);
  });

  test('minimizes subagent on reaction added', async () => {
    const subagent = session.activeSubagents.get('task_1')!;
    expect(subagent.isMinimized).toBe(false);

    const result = await handleSubagentToggleReaction(session, 'subagent_post_1', 'added');

    expect(result).toBe(true);
    expect(subagent.isMinimized).toBe(true);
    expect(platform.updatePost).toHaveBeenCalled();
  });

  test('expands subagent on reaction removed', async () => {
    const subagent = session.activeSubagents.get('task_1')!;
    subagent.isMinimized = true;

    const result = await handleSubagentToggleReaction(session, 'subagent_post_1', 'removed');

    expect(result).toBe(true);
    expect(subagent.isMinimized).toBe(false);
    expect(platform.updatePost).toHaveBeenCalled();
  });

  test('skips update if already in desired state', async () => {
    const subagent = session.activeSubagents.get('task_1')!;
    subagent.isMinimized = true;

    const result = await handleSubagentToggleReaction(session, 'subagent_post_1', 'added');

    expect(result).toBe(true);
    // Should not call updatePost since state didn't change
    expect(platform.updatePost).not.toHaveBeenCalled();
  });

  test('works on completed subagent', async () => {
    const subagent = session.activeSubagents.get('task_1')!;
    subagent.isComplete = true;
    subagent.isMinimized = false;

    const result = await handleSubagentToggleReaction(session, 'subagent_post_1', 'added');

    expect(result).toBe(true);
    expect(subagent.isMinimized).toBe(true);
    // Update should include completion indicator
    expect(platform.updatePost).toHaveBeenCalled();
    const updateCall = (platform.updatePost as any).mock.calls[0];
    expect(updateCall[1]).toContain('✅');
  });
});

describe('postCurrentQuestion', () => {
  let platform: PlatformClient;
  let session: Session;
  let ctx: SessionContext;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    ctx = createSessionContext();
  });

  test('does nothing if no pending question set', async () => {
    session.pendingQuestionSet = null;

    await postCurrentQuestion(session, ctx);

    expect(platform.createInteractivePost).not.toHaveBeenCalled();
  });

  test('posts current question with options', async () => {
    session.pendingQuestionSet = {
      toolUseId: 'ask_1',
      currentIndex: 0,
      currentPostId: null,
      questions: [{
        header: 'Test Header',
        question: 'What do you prefer?',
        options: [
          { label: 'Option A', description: 'First option' },
          { label: 'Option B', description: 'Second option' },
        ],
        answer: null,
      }],
    };

    await postCurrentQuestion(session, ctx);

    expect(platform.createInteractivePost).toHaveBeenCalled();
    const call = (platform.createInteractivePost as any).mock.calls[0];
    const message = call[0];

    expect(message).toContain('Test Header');
    expect(message).toContain('What do you prefer?');
    expect(message).toContain('Option A');
    expect(message).toContain('Option B');
  });

  test('registers the question post', async () => {
    session.pendingQuestionSet = {
      toolUseId: 'ask_1',
      currentIndex: 0,
      currentPostId: null,
      questions: [{
        header: 'Header',
        question: 'Question?',
        options: [{ label: 'A', description: 'A' }],
        answer: null,
      }],
    };

    await postCurrentQuestion(session, ctx);

    expect(ctx.ops.registerPost).toHaveBeenCalled();
    expect(session.pendingQuestionSet.currentPostId).toBeTruthy();
  });
});
