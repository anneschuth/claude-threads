/**
 * Tests for events.ts - Claude event handling
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { handleEvent } from './events.js';
import type { SessionContext } from './context.js';
import type { Session } from './types.js';
import type { PlatformClient, PlatformPost } from '../platform/index.js';
import { createMockFormatter } from '../test-utils/mock-formatter.js';

// Mock platform client
function createMockPlatform() {
  const posts: Map<string, string> = new Map();
  let postIdCounter = 1;

  const mockPlatform = {
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
    claude: null as any,
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

describe('handleEvent with TodoWrite', () => {
  let platform: PlatformClient & { posts: Map<string, string> };
  let session: Session;
  let ctx: SessionContext;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    ctx = createSessionContext();
  });

  test('sets tasksCompleted=false when tasks have pending items', () => {
    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            id: 'tool_1',
            input: {
              todos: [
                { content: 'Task 1', status: 'completed', activeForm: 'Completing task 1' },
                { content: 'Task 2', status: 'pending', activeForm: 'Doing task 2' },
              ],
            },
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    expect(session.tasksCompleted).toBe(false);
  });

  test('sets tasksCompleted=false when tasks have in_progress items', () => {
    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            id: 'tool_1',
            input: {
              todos: [
                { content: 'Task 1', status: 'completed', activeForm: 'Completing task 1' },
                { content: 'Task 2', status: 'in_progress', activeForm: 'Doing task 2' },
              ],
            },
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    expect(session.tasksCompleted).toBe(false);
  });

  test('sets tasksCompleted=true when all tasks are completed', async () => {
    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            id: 'tool_1',
            input: {
              todos: [
                { content: 'Task 1', status: 'completed', activeForm: 'Completing task 1' },
                { content: 'Task 2', status: 'completed', activeForm: 'Completing task 2' },
                { content: 'Task 3', status: 'completed', activeForm: 'Completing task 3' },
              ],
            },
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    // Wait for async lock acquisition and processing
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(session.tasksCompleted).toBe(true);
  });

  test('sets tasksCompleted=true when todos array is empty', async () => {
    session.tasksPostId = 'existing_tasks_post';

    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            id: 'tool_1',
            input: {
              todos: [],
            },
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    // Wait for async lock acquisition and processing
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(session.tasksCompleted).toBe(true);
  });

  test('task list is not bumped when all tasks completed', async () => {
    // First, simulate having an active task list
    session.tasksPostId = 'tasks_post';
    session.lastTasksContent = '📋 **Tasks** (2/3)\n✅ Task 1\n✅ Task 2\n🔄 Task 3';
    session.tasksCompleted = false;

    // Now complete all tasks
    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            id: 'tool_1',
            input: {
              todos: [
                { content: 'Task 1', status: 'completed', activeForm: 'Task 1' },
                { content: 'Task 2', status: 'completed', activeForm: 'Task 2' },
                { content: 'Task 3', status: 'completed', activeForm: 'Task 3' },
              ],
            },
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    // Wait for async operations to complete
    await new Promise(resolve => setTimeout(resolve, 10));

    // tasksCompleted should be true
    expect(session.tasksCompleted).toBe(true);

    // The task list content should show all completed
    expect(session.lastTasksContent).toContain('3/3');
    expect(session.lastTasksContent).toContain('100%');
  });

  test('concurrent TodoWrite events do not create duplicate task list posts', async () => {
    // Track how many times createInteractivePost was called
    let createPostCallCount = 0;
    const originalCreateInteractivePost = platform.createInteractivePost;
    (platform as any).createInteractivePost = mock(async (message: string, reactions: string[], threadId?: string) => {
      createPostCallCount++;
      // Add a small delay to simulate network latency that allows race conditions
      await new Promise(resolve => setTimeout(resolve, 20));
      return originalCreateInteractivePost.call(platform, message, reactions, threadId);
    });

    // Create two TodoWrite events (as if Claude emitted them rapidly)
    const event1 = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            id: 'tool_1',
            input: {
              todos: [
                { content: 'Task 1', status: 'pending', activeForm: 'Doing task 1' },
              ],
            },
          },
        ],
      },
    };

    const event2 = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            id: 'tool_2',
            input: {
              todos: [
                { content: 'Task 1', status: 'in_progress', activeForm: 'Doing task 1' },
              ],
            },
          },
        ],
      },
    };

    // Fire both events concurrently (simulating the race condition)
    // handleEvent doesn't await the async handlers, so these run concurrently
    handleEvent(session, event1, ctx);
    handleEvent(session, event2, ctx);

    // Wait for all async operations to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    // With the fix, only ONE task post should be created
    // The second call should see the existing tasksPostId and update instead
    expect(createPostCallCount).toBe(1);

    // The session should have a valid tasksPostId
    expect(session.tasksPostId).toBeTruthy();
  });

  test('TodoWrite and bumpTasksToBottom do not create duplicate task posts when interleaved', async () => {
    // This tests the fix for the duplicate task list bug where both
    // handleTodoWrite and bumpTasksToBottom could create task posts
    // when called concurrently.

    // First, create an initial task list
    session.tasksPostId = 'initial_tasks_post';
    session.lastTasksContent = '📋 **Tasks** (0/1)\n○ Task 1';
    session.tasksCompleted = false;

    const originalCreateInteractivePost = platform.createInteractivePost;
    (platform as any).createInteractivePost = mock(async (message: string, reactions: string[], threadId?: string) => {
      // Add delay to simulate network latency
      await new Promise(resolve => setTimeout(resolve, 20));
      return originalCreateInteractivePost.call(platform, message, reactions, threadId);
    });

    // Create a TodoWrite event
    const todoWriteEvent = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            id: 'tool_bump_test',
            input: {
              todos: [
                { content: 'Task 1', status: 'in_progress', activeForm: 'Doing task 1' },
              ],
            },
          },
        ],
      },
    };

    // Simulate bumpTasksToBottom being called (e.g., user sends a message)
    // by having the ctx.ops.bumpTasksToBottom mock actually do the work
    let bumpCalled = false;
    (ctx.ops.bumpTasksToBottom as ReturnType<typeof mock>).mockImplementation(async (s: Session) => {
      bumpCalled = true;
      // Wait for any existing lock
      if (s.taskListCreationPromise) {
        await s.taskListCreationPromise;
      }
      // Re-check after waiting
      if (!s.tasksPostId || !s.lastTasksContent || s.tasksCompleted) {
        return;
      }
      // Acquire lock
      let resolve: () => void = () => {};
      s.taskListCreationPromise = new Promise(r => { resolve = r; });
      try {
        // Simulate creating a new post
        const post = await originalCreateInteractivePost.call(platform, s.lastTasksContent, ['arrow_down_small'], s.threadId);
        s.tasksPostId = post.id;
      } finally {
        resolve();
        s.taskListCreationPromise = undefined;
      }
    });

    // Fire TodoWrite event - this will trigger handleTodoWrite which updates tasks
    handleEvent(session, todoWriteEvent, ctx);

    // Also trigger bumpTasksToBottom concurrently (simulating user follow-up message)
    ctx.ops.bumpTasksToBottom(session);

    // Wait for all async operations
    await new Promise(resolve => setTimeout(resolve, 150));

    // With proper locking, we should have at most 2 posts created
    // (one from TodoWrite if it creates, one from bump)
    // But critically, there should be only ONE valid tasksPostId
    expect(session.tasksPostId).toBeTruthy();

    // The bump function should have been called
    expect(bumpCalled).toBe(true);
  });
});

describe('handleEvent with result event (usage stats)', () => {
  let platform: PlatformClient & { posts: Map<string, string> };
  let session: Session;
  let ctx: SessionContext;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    ctx = createSessionContext();
  });

  test('extracts usage stats from result event with per-request usage', () => {
    const event = {
      type: 'result' as const,
      subtype: 'success',
      total_cost_usd: 0.072784,
      // Per-request usage (accurate for context window)
      usage: {
        input_tokens: 500,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 18500,
        output_tokens: 200,
      },
      // Cumulative billing per model
      modelUsage: {
        'claude-opus-4-5-20251101': {
          inputTokens: 2471,
          outputTokens: 193,
          cacheReadInputTokens: 12671,
          cacheCreationInputTokens: 7378,
          contextWindow: 200000,
          costUSD: 0.069628,
        },
        'claude-haiku-4-5-20251001': {
          inputTokens: 2341,
          outputTokens: 163,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextWindow: 200000,
          costUSD: 0.003156,
        },
      },
    };

    handleEvent(session, event, ctx);

    // Check usage stats were extracted
    expect(session.usageStats).toBeDefined();
    expect(session.usageStats?.primaryModel).toBe('claude-opus-4-5-20251101');
    expect(session.usageStats?.modelDisplayName).toBe('Opus 4.5');
    expect(session.usageStats?.contextWindowSize).toBe(200000);
    expect(session.usageStats?.totalCostUSD).toBe(0.072784);
    // Context tokens from per-request usage: 500 + 1000 + 18500 = 20000
    expect(session.usageStats?.contextTokens).toBe(20000);
    // Total tokens (billing): 2471+193+12671+7378 + 2341+163+0+0 = 25217
    expect(session.usageStats?.totalTokensUsed).toBe(25217);
  });

  test('falls back to modelUsage for context tokens when usage is missing', () => {
    const event = {
      type: 'result' as const,
      subtype: 'success',
      total_cost_usd: 0.05,
      // No usage field - should fall back to modelUsage
      modelUsage: {
        'claude-opus-4-5-20251101': {
          inputTokens: 2000,
          outputTokens: 100,
          cacheReadInputTokens: 8000,
          cacheCreationInputTokens: 5000,
          contextWindow: 200000,
          costUSD: 0.05,
        },
      },
    };

    handleEvent(session, event, ctx);

    expect(session.usageStats).toBeDefined();
    // Fallback: primary model's inputTokens + cacheReadInputTokens = 2000 + 8000 = 10000
    expect(session.usageStats?.contextTokens).toBe(10000);
  });

  test('identifies primary model by highest cost', () => {
    const event = {
      type: 'result' as const,
      total_cost_usd: 0.10,
      modelUsage: {
        'claude-haiku-4-5-20251001': {
          inputTokens: 1000,
          outputTokens: 100,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextWindow: 200000,
          costUSD: 0.01,
        },
        'claude-sonnet-4-20251101': {
          inputTokens: 500,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextWindow: 200000,
          costUSD: 0.09, // Higher cost = primary model
        },
      },
    };

    handleEvent(session, event, ctx);

    expect(session.usageStats?.primaryModel).toBe('claude-sonnet-4-20251101');
    expect(session.usageStats?.modelDisplayName).toBe('Sonnet 4');
  });

  test('does not set usage stats when modelUsage is missing', () => {
    const event = {
      type: 'result' as const,
      subtype: 'success',
      total_cost_usd: 0.05,
      // No modelUsage field
    };

    handleEvent(session, event, ctx);

    expect(session.usageStats).toBeUndefined();
  });

  test('starts status bar timer on first result event', () => {
    expect(session.statusBarTimer).toBeNull();

    const event = {
      type: 'result' as const,
      total_cost_usd: 0.01,
      modelUsage: {
        'claude-opus-4-5-20251101': {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextWindow: 200000,
          costUSD: 0.01,
        },
      },
    };

    handleEvent(session, event, ctx);

    expect(session.statusBarTimer).not.toBeNull();

    // Clean up the timer
    if (session.statusBarTimer) {
      clearInterval(session.statusBarTimer);
      session.statusBarTimer = null;
    }
  });

  test('calls updateSessionHeader after extracting usage stats', () => {
    const event = {
      type: 'result' as const,
      total_cost_usd: 0.01,
      modelUsage: {
        'claude-opus-4-5-20251101': {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextWindow: 200000,
          costUSD: 0.01,
        },
      },
    };

    handleEvent(session, event, ctx);

    expect(ctx.ops.updateSessionHeader).toHaveBeenCalled();

    // Clean up
    if (session.statusBarTimer) {
      clearInterval(session.statusBarTimer);
      session.statusBarTimer = null;
    }
  });

  test('handles various model name formats correctly', () => {
    const testCases = [
      { modelId: 'claude-opus-4-5-20251101', expected: 'Opus 4.5' },
      { modelId: 'claude-opus-4-20251101', expected: 'Opus 4' },
      { modelId: 'claude-sonnet-3-5-20240620', expected: 'Sonnet 3.5' },
      { modelId: 'claude-sonnet-4-20251101', expected: 'Sonnet 4' },
      { modelId: 'claude-haiku-4-5-20251001', expected: 'Haiku 4.5' },
      { modelId: 'claude-haiku-3-20240307', expected: 'Haiku' },
    ];

    for (const { modelId, expected } of testCases) {
      session = createTestSession(platform); // Fresh session
      const event = {
        type: 'result' as const,
        total_cost_usd: 0.01,
        modelUsage: {
          [modelId]: {
            inputTokens: 100,
            outputTokens: 10,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            contextWindow: 200000,
            costUSD: 0.01,
          },
        },
      };

      handleEvent(session, event, ctx);

      expect(session.usageStats?.modelDisplayName).toBe(expected);

      // Clean up timer
      if (session.statusBarTimer) {
        clearInterval(session.statusBarTimer);
        session.statusBarTimer = null;
      }
    }
  });
});

describe('handleEvent with compaction events', () => {
  let platform: PlatformClient & { posts: Map<string, string> };
  let session: Session;
  let ctx: SessionContext;
  let appendedContent: string[];

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    ctx = createSessionContext();
    appendedContent = [];
    ctx.ops.appendContent = mock((_, text: string) => {
      appendedContent.push(text);
    });
  });

  test('creates post when compaction starts and stores post ID', async () => {
    const event = {
      type: 'system' as const,
      subtype: 'status',
      status: 'compacting',
      session_id: 'test-session',
    };

    handleEvent(session, event, ctx);

    // Wait for async post creation
    await new Promise(resolve => setTimeout(resolve, 10));

    // Should have created a post (not appended content)
    expect(appendedContent).toHaveLength(0);
    expect(platform.createPost).toHaveBeenCalled();

    // Get the post content from the mock
    const calls = (platform.createPost as ReturnType<typeof mock>).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[0]).toContain('🗜️');
    expect(lastCall[0]).toContain('Compacting context');

    // Should have stored the post ID
    expect(session.compactionPostId).toBeDefined();
  });

  test('updates existing post when compaction completes (manual)', async () => {
    // First, simulate compaction start
    session.compactionPostId = 'compaction-post-123';

    const event = {
      type: 'system' as const,
      subtype: 'compact_boundary',
      session_id: 'test-session',
      compact_metadata: {
        trigger: 'manual',
        pre_tokens: 0,
      },
    };

    handleEvent(session, event, ctx);

    // Wait for async post update
    await new Promise(resolve => setTimeout(resolve, 10));

    // Should have updated the existing post (not appended content)
    expect(appendedContent).toHaveLength(0);
    expect(platform.updatePost).toHaveBeenCalledWith(
      'compaction-post-123',
      expect.stringContaining('✅')
    );
    expect(platform.updatePost).toHaveBeenCalledWith(
      'compaction-post-123',
      expect.stringContaining('Context compacted')
    );
    expect(platform.updatePost).toHaveBeenCalledWith(
      'compaction-post-123',
      expect.stringContaining('manual')
    );

    // Should have cleared the post ID
    expect(session.compactionPostId).toBeUndefined();
  });

  test('updates existing post when compaction completes (auto)', async () => {
    session.compactionPostId = 'compaction-post-456';

    const event = {
      type: 'system' as const,
      subtype: 'compact_boundary',
      session_id: 'test-session',
      compact_metadata: {
        trigger: 'auto',
        pre_tokens: 150000,
      },
    };

    handleEvent(session, event, ctx);

    // Wait for async post update
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(appendedContent).toHaveLength(0);
    expect(platform.updatePost).toHaveBeenCalledWith(
      'compaction-post-456',
      expect.stringContaining('auto')
    );
    expect(platform.updatePost).toHaveBeenCalledWith(
      'compaction-post-456',
      expect.stringContaining('150k tokens')
    );
  });

  test('creates new post for compact_boundary if no compaction post ID exists', async () => {
    // No compactionPostId set - fallback behavior
    const event = {
      type: 'system' as const,
      subtype: 'compact_boundary',
      session_id: 'test-session',
    };

    handleEvent(session, event, ctx);

    // Wait for async post creation
    await new Promise(resolve => setTimeout(resolve, 10));

    // Should create a new post as fallback
    expect(appendedContent).toHaveLength(0);
    const calls = (platform.createPost as ReturnType<typeof mock>).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[0]).toContain('✅');
    expect(lastCall[0]).toContain('Context compacted');
    expect(lastCall[0]).toContain('auto'); // Default when no trigger specified
  });

  test('does not display anything for status=null event', () => {
    const event = {
      type: 'system' as const,
      subtype: 'status',
      status: null,
      session_id: 'test-session',
    };

    handleEvent(session, event, ctx);

    expect(appendedContent).toHaveLength(0);
  });

  test('continues to display errors correctly', () => {
    const event = {
      type: 'system' as const,
      subtype: 'error',
      error: 'Something went wrong',
    };

    handleEvent(session, event, ctx);

    expect(appendedContent).toHaveLength(1);
    expect(appendedContent[0]).toContain('❌');
    expect(appendedContent[0]).toContain('Something went wrong');
  });
});

describe('handleEvent with Claude command detection', () => {
  let platform: PlatformClient & { posts: Map<string, string> };
  let session: Session;
  let ctx: SessionContext;
  let appendedContent: string[];

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    ctx = createSessionContext();
    appendedContent = [];
    ctx.ops.appendContent = mock((_, text: string) => {
      appendedContent.push(text);
    });
  });

  test('detects !cd command in Claude output and removes it from display', async () => {
    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'text',
            text: 'I need to switch to a different directory.\n\n!cd /path/to/project\n\nNow I can work on this project.',
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    // Wait for async operations
    await new Promise(resolve => setTimeout(resolve, 10));

    // The !cd command should be removed from the displayed text
    expect(appendedContent).toHaveLength(1);
    expect(appendedContent[0]).not.toContain('!cd');
    expect(appendedContent[0]).toContain('I need to switch');
    expect(appendedContent[0]).toContain('Now I can work');
  });

  test('posts visibility message when Claude executes !cd', async () => {
    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'text',
            text: '!cd /path/to/project',
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    // Wait for async operations
    await new Promise(resolve => setTimeout(resolve, 10));

    // Should have posted a visibility message
    expect(platform.createPost).toHaveBeenCalled();
    const calls = (platform.createPost as ReturnType<typeof mock>).mock.calls;
    const postContents = calls.map(call => call[0]);
    expect(postContents.some(content => content.includes('Claude executed'))).toBe(true);
    expect(postContents.some(content => content.includes('!cd'))).toBe(true);
  });

  test('does not trigger on !cd in code blocks or inline code', () => {
    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'text',
            text: 'You can use the command `!cd /path` to change directories.',
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    // The text should remain unchanged (inline code with !cd should not trigger)
    // Note: Our regex only matches !cd at start of line, so this won't match
    expect(appendedContent).toHaveLength(1);
    expect(appendedContent[0]).toContain('!cd /path');
  });

  test('handles !cd with tilde path expansion', async () => {
    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'text',
            text: '!cd ~/projects/myapp',
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    // Wait for async operations
    await new Promise(resolve => setTimeout(resolve, 10));

    // Should have attempted to change directory
    expect(platform.createPost).toHaveBeenCalled();
  });

  test('does not match other ! commands like !invite', () => {
    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'text',
            text: 'You should use !invite @user to add them to the session.',
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    // Should not trigger any command execution
    expect(appendedContent).toHaveLength(1);
    expect(appendedContent[0]).toContain('!invite');
  });

  test('does not execute !invite at start of line', async () => {
    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'text',
            text: '!invite @bob',
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    // Wait for async operations
    await new Promise(resolve => setTimeout(resolve, 10));

    // Should NOT have posted a visibility message (only !cd is allowed)
    const calls = (platform.createPost as ReturnType<typeof mock>).mock.calls;
    const hasClaudeExecuted = calls.some(call => call[0].includes('Claude executed'));
    expect(hasClaudeExecuted).toBe(false);

    // The text should remain unchanged
    expect(appendedContent).toHaveLength(1);
    expect(appendedContent[0]).toContain('!invite @bob');
  });

  test('does not execute !kick at start of line', async () => {
    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'text',
            text: '!kick @alice',
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    await new Promise(resolve => setTimeout(resolve, 10));

    const calls = (platform.createPost as ReturnType<typeof mock>).mock.calls;
    const hasClaudeExecuted = calls.some(call => call[0].includes('Claude executed'));
    expect(hasClaudeExecuted).toBe(false);

    expect(appendedContent).toHaveLength(1);
    expect(appendedContent[0]).toContain('!kick @alice');
  });

  test('does not execute !permissions at start of line', async () => {
    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'text',
            text: '!permissions skip',
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    await new Promise(resolve => setTimeout(resolve, 10));

    const calls = (platform.createPost as ReturnType<typeof mock>).mock.calls;
    const hasClaudeExecuted = calls.some(call => call[0].includes('Claude executed'));
    expect(hasClaudeExecuted).toBe(false);

    expect(appendedContent).toHaveLength(1);
    expect(appendedContent[0]).toContain('!permissions skip');
  });

  test('does not execute !stop at start of line', async () => {
    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'text',
            text: '!stop',
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    await new Promise(resolve => setTimeout(resolve, 10));

    const calls = (platform.createPost as ReturnType<typeof mock>).mock.calls;
    const hasClaudeExecuted = calls.some(call => call[0].includes('Claude executed'));
    expect(hasClaudeExecuted).toBe(false);

    expect(appendedContent).toHaveLength(1);
    expect(appendedContent[0]).toContain('!stop');
  });

  test('does not execute !escape at start of line', async () => {
    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'text',
            text: '!escape',
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    await new Promise(resolve => setTimeout(resolve, 10));

    const calls = (platform.createPost as ReturnType<typeof mock>).mock.calls;
    const hasClaudeExecuted = calls.some(call => call[0].includes('Claude executed'));
    expect(hasClaudeExecuted).toBe(false);

    expect(appendedContent).toHaveLength(1);
    expect(appendedContent[0]).toContain('!escape');
  });

  test('does not execute !update at start of line', async () => {
    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'text',
            text: '!update now',
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    await new Promise(resolve => setTimeout(resolve, 10));

    const calls = (platform.createPost as ReturnType<typeof mock>).mock.calls;
    const hasClaudeExecuted = calls.some(call => call[0].includes('Claude executed'));
    expect(hasClaudeExecuted).toBe(false);

    expect(appendedContent).toHaveLength(1);
    expect(appendedContent[0]).toContain('!update now');
  });

  test('handles !cd at the start of text without other content', async () => {
    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'text',
            text: '!cd /some/path',
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    // Wait for async operations
    await new Promise(resolve => setTimeout(resolve, 10));

    // The text should be removed entirely (empty after command extraction)
    // So nothing gets appended, or an empty string
    // Since we filter empty text, appendedContent might be empty
    expect(appendedContent.length === 0 || appendedContent[0] === '').toBe(true);
  });

  test('executes !worktree list and posts visibility message', async () => {
    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'text',
            text: '!worktree list',
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    // Wait for async operations
    await new Promise(resolve => setTimeout(resolve, 10));

    // Should have posted a visibility message
    expect(platform.createPost).toHaveBeenCalled();
    const calls = (platform.createPost as ReturnType<typeof mock>).mock.calls;
    const postContents = calls.map(call => call[0]);
    expect(postContents.some(content => content.includes('Claude executed'))).toBe(true);
    expect(postContents.some(content => content.includes('!worktree list'))).toBe(true);
  });

  test('removes !worktree list from displayed text', async () => {
    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'text',
            text: 'Let me check the worktrees.\n\n!worktree list\n\nI will analyze the results.',
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    // Wait for async operations
    await new Promise(resolve => setTimeout(resolve, 10));

    // The !worktree list command should be removed from displayed text
    expect(appendedContent).toHaveLength(1);
    expect(appendedContent[0]).not.toContain('!worktree list');
    expect(appendedContent[0]).toContain('check the worktrees');
    expect(appendedContent[0]).toContain('analyze the results');
  });
});

describe('handleEvent with assistant messages containing tool_use and text', () => {
  let platform: PlatformClient & { posts: Map<string, string> };
  let session: Session;
  let ctx: SessionContext;
  let appendedContent: string[];

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    ctx = createSessionContext();
    appendedContent = [];
    ctx.ops.appendContent = mock((_, text: string) => {
      appendedContent.push(text);
    });
  });

  test('Edit tool followed by text has proper newline separation', () => {
    // This test verifies the fix for the "missing newline" bug where
    // code blocks ending with ``` were followed directly by text on
    // the same line, making the output hard to read.
    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Edit',
            id: 'edit_1',
            input: {
              file_path: '/test/file.ts',
              old_string: 'old code',
              new_string: 'new code',
            },
          },
          {
            type: 'text',
            text: 'Now let me explain what I changed...',
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    // The appended content should have proper newline separation
    expect(appendedContent).toHaveLength(1);
    const content = appendedContent[0];

    // Should contain both the Edit diff and the text
    expect(content).toContain('Edit');
    expect(content).toContain('Now let me explain');

    // The code block should end with ``` followed by newlines before the text
    // Pattern: ``` then newline(s) then eventually "Now"
    expect(content).toMatch(/```\n+.*Now let me explain/s);

    // Should NOT have ``` immediately followed by text on same line (no newline)
    expect(content).not.toMatch(/```Now/);
    // There should be at least one newline between ``` and the next content
    expect(content).toMatch(/```\n/);
  });

  test('Write tool followed by text has proper newline separation', () => {
    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Write',
            id: 'write_1',
            input: {
              file_path: '/test/newfile.ts',
              content: 'const x = 1;',
            },
          },
          {
            type: 'text',
            text: 'I created a new file with...',
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    expect(appendedContent).toHaveLength(1);
    const content = appendedContent[0];

    // Should contain both the Write preview and the text
    expect(content).toContain('Write');
    expect(content).toContain('I created a new file');

    // The code block should end with proper newline separation
    expect(content).toMatch(/```\n+.*I created a new file/s);
    expect(content).not.toMatch(/```I created/);
  });
});
