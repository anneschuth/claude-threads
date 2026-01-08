/**
 * Tests for sticky-thread.ts - thread-level sticky post management
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { Session } from './types.js';
import type { PlatformClient, PlatformPost } from '../platform/index.js';
import {
  acquireStickyLock,
  bumpPlanApprovalToBottom,
  bumpTasksToBottom,
  bumpTasksToBottomWithContent,
  bumpAllStickyPosts,
  hasActiveStickyPosts,
  hasActiveTasks,
  getTaskDisplayContent,
  getMinimizedTaskContent,
} from './sticky-thread.js';

// Helper to create a mock platform
function createMockPlatform(): PlatformClient {
  let postCounter = 0;
  return {
    createPost: mock(async (_content: string, threadId: string): Promise<PlatformPost> => ({
      id: `post_${++postCounter}`,
      platformId: 'test-platform',
      channelId: 'channel1',
      userId: 'bot',
      message: _content,
      rootId: threadId,
      createAt: Date.now(),
    })),
    createInteractivePost: mock(async (_content: string, _reactions: string[], threadId: string): Promise<PlatformPost> => ({
      id: `post_${++postCounter}`,
      platformId: 'test-platform',
      channelId: 'channel1',
      userId: 'bot',
      message: _content,
      rootId: threadId,
      createAt: Date.now(),
    })),
    updatePost: mock(async () => {}),
    deletePost: mock(async () => {}),
    pinPost: mock(async () => {}),
    unpinPost: mock(async () => {}),
    addReaction: mock(async () => {}),
    removeReaction: mock(async () => {}),
    getFormatter: () => ({
      formatBold: (text: string) => `**${text}**`,
      formatItalic: (text: string) => `_${text}_`,
      formatCode: (text: string) => `\`${text}\``,
      formatCodeBlock: (text: string, lang?: string) => `\`\`\`${lang || ''}\n${text}\n\`\`\``,
      formatUserMention: (username: string) => `@${username}`,
      formatHorizontalRule: () => '---',
      formatMarkdown: (text: string) => text,
      formatLink: (text: string, url: string) => `[${text}](${url})`,
    }),
    getMessageLimits: () => ({
      maxLength: 16000,
      softThreshold: 6000,
      hardThreshold: 12000,
    }),
  } as unknown as PlatformClient;
}

// Helper to create a test session
function createTestSession(platform: PlatformClient): Session {
  return {
    platformId: 'test-platform',
    threadId: 'thread1',
    sessionId: 'test-platform:thread1',
    claudeSessionId: 'claude-123',
    startedBy: 'testuser',
    startedAt: new Date(),
    lastActivityAt: new Date(),
    sessionNumber: 1,
    platform,
    workingDir: '/test',
    claude: {} as Session['claude'],
    currentPostId: null,
    currentPostContent: '',
    pendingContent: '',
    pendingApproval: null,
    pendingQuestionSet: null,
    pendingMessageApproval: null,
    planApproved: false,
    sessionAllowedUsers: new Set(['testuser']),
    forceInteractivePermissions: false,
    sessionStartPostId: null,
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
    hasClaudeResponded: false,
    inProgressTaskStart: null,
    activeToolStarts: new Map(),
    messageCount: 0,
    isProcessing: false,
    statusBarTimer: null,
  };
}

describe('acquireStickyLock', () => {
  let session: Session;
  let platform: PlatformClient;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
  });

  test('returns release function immediately when no lock exists', async () => {
    const release = await acquireStickyLock(session);
    expect(typeof release).toBe('function');
    release();
  });

  test('serializes concurrent calls', async () => {
    const order: number[] = [];

    // Start first lock
    const release1Promise = acquireStickyLock(session);
    const release1 = await release1Promise;
    order.push(1);

    // Start second lock (should wait)
    const release2Promise = acquireStickyLock(session);

    // First lock still held, second should be waiting
    setTimeout(() => {
      order.push(2);
      release1();
    }, 10);

    const release2 = await release2Promise;
    order.push(3);
    release2();

    expect(order).toEqual([1, 2, 3]);
  });

  test('sets both stickyPostLock and taskListCreationPromise for compatibility', async () => {
    const release = await acquireStickyLock(session);
    expect(session.stickyPostLock).toBeDefined();
    expect(session.taskListCreationPromise).toBeDefined();
    release();
  });
});

describe('hasActiveTasks', () => {
  let session: Session;
  let platform: PlatformClient;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
  });

  test('returns false when no task post', () => {
    expect(hasActiveTasks(session)).toBe(false);
  });

  test('returns false when no task content', () => {
    session.tasksPostId = 'task_post';
    expect(hasActiveTasks(session)).toBe(false);
  });

  test('returns false when tasks completed', () => {
    session.tasksPostId = 'task_post';
    session.lastTasksContent = 'content';
    session.tasksCompleted = true;
    expect(hasActiveTasks(session)).toBe(false);
  });

  test('returns true when active tasks exist', () => {
    session.tasksPostId = 'task_post';
    session.lastTasksContent = 'content';
    session.tasksCompleted = false;
    expect(hasActiveTasks(session)).toBe(true);
  });
});

describe('hasActiveStickyPosts', () => {
  let session: Session;
  let platform: PlatformClient;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
  });

  test('returns false when no sticky posts', () => {
    expect(hasActiveStickyPosts(session)).toBe(false);
  });

  test('returns true when plan approval pending', () => {
    session.pendingApproval = {
      postId: 'plan_post',
      type: 'plan',
      toolUseId: 'tool1',
      content: 'Plan content',
    };
    expect(hasActiveStickyPosts(session)).toBe(true);
  });

  test('returns true when active tasks exist', () => {
    session.tasksPostId = 'task_post';
    session.lastTasksContent = 'content';
    expect(hasActiveStickyPosts(session)).toBe(true);
  });

  test('returns true when both exist', () => {
    session.pendingApproval = {
      postId: 'plan_post',
      type: 'plan',
      toolUseId: 'tool1',
      content: 'Plan content',
    };
    session.tasksPostId = 'task_post';
    session.lastTasksContent = 'content';
    expect(hasActiveStickyPosts(session)).toBe(true);
  });

  test('returns false when plan approval has no content', () => {
    session.pendingApproval = {
      postId: 'plan_post',
      type: 'plan',
      toolUseId: 'tool1',
      // No content - can't bump
    };
    expect(hasActiveStickyPosts(session)).toBe(false);
  });
});

describe('bumpPlanApprovalToBottom', () => {
  let session: Session;
  let platform: PlatformClient;
  let registerPost: ReturnType<typeof mock>;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    registerPost = mock(() => {});
  });

  test('does nothing when no pending approval', async () => {
    await bumpPlanApprovalToBottom(session, registerPost);
    expect(platform.deletePost).not.toHaveBeenCalled();
    expect(platform.createInteractivePost).not.toHaveBeenCalled();
  });

  test('does nothing when approval type is not plan', async () => {
    session.pendingApproval = {
      postId: 'action_post',
      type: 'action',
      toolUseId: 'tool1',
      content: 'content',
    };
    await bumpPlanApprovalToBottom(session, registerPost);
    expect(platform.deletePost).not.toHaveBeenCalled();
  });

  test('does nothing when no content stored', async () => {
    session.pendingApproval = {
      postId: 'plan_post',
      type: 'plan',
      toolUseId: 'tool1',
      // No content
    };
    await bumpPlanApprovalToBottom(session, registerPost);
    expect(platform.deletePost).not.toHaveBeenCalled();
  });

  test('bumps plan approval to bottom', async () => {
    session.pendingApproval = {
      postId: 'old_plan_post',
      type: 'plan',
      toolUseId: 'tool1',
      content: 'Plan approval content',
    };

    await bumpPlanApprovalToBottom(session, registerPost);

    // Should delete old post
    expect(platform.deletePost).toHaveBeenCalledWith('old_plan_post');
    // Should create new post with same content
    expect(platform.createInteractivePost).toHaveBeenCalledWith(
      'Plan approval content',
      expect.any(Array),
      'thread1'
    );
    // Should update postId
    expect(session.pendingApproval?.postId).toBe('post_1');
    // Should register new post
    expect(registerPost).toHaveBeenCalledWith('post_1', 'thread1');
  });
});

describe('bumpTasksToBottom', () => {
  let session: Session;
  let platform: PlatformClient;
  let registerPost: ReturnType<typeof mock>;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    registerPost = mock(() => {});
  });

  test('does nothing when no task post', async () => {
    await bumpTasksToBottom(session, registerPost);
    expect(platform.deletePost).not.toHaveBeenCalled();
  });

  test('does nothing when tasks completed', async () => {
    session.tasksPostId = 'task_post';
    session.lastTasksContent = 'content';
    session.tasksCompleted = true;
    await bumpTasksToBottom(session, registerPost);
    expect(platform.deletePost).not.toHaveBeenCalled();
  });

  test('bumps task list to bottom', async () => {
    session.tasksPostId = 'old_task_post';
    session.lastTasksContent = '📋 **Tasks** (0/1 · 0%)\n○ Do something';

    await bumpTasksToBottom(session, registerPost);

    // Should unpin and delete old post
    expect(platform.unpinPost).toHaveBeenCalledWith('old_task_post');
    expect(platform.deletePost).toHaveBeenCalledWith('old_task_post');
    // Should create new post
    expect(platform.createInteractivePost).toHaveBeenCalled();
    // Should update tasksPostId
    expect(session.tasksPostId).toBe('post_1');
    // Should pin new post
    expect(platform.pinPost).toHaveBeenCalledWith('post_1');
    // Should register new post
    expect(registerPost).toHaveBeenCalledWith('post_1', 'thread1');
  });
});

describe('bumpTasksToBottomWithContent', () => {
  let session: Session;
  let platform: PlatformClient;
  let registerPost: ReturnType<typeof mock>;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    registerPost = mock(() => {});
  });

  test('repurposes task post for new content', async () => {
    session.tasksPostId = 'old_task_post';
    session.lastTasksContent = '📋 **Tasks** (0/1 · 0%)\n○ Do something';

    const newPostId = await bumpTasksToBottomWithContent(session, 'New content', registerPost);

    // Should return old task post id (repurposed)
    expect(newPostId).toBe('old_task_post');
    // Should update old post with new content
    expect(platform.updatePost).toHaveBeenCalledWith('old_task_post', 'New content');
    // Should remove toggle emoji from repurposed post
    expect(platform.removeReaction).toHaveBeenCalled();
    // Should create new task post at bottom
    expect(platform.createInteractivePost).toHaveBeenCalled();
    // Should update tasksPostId to new post
    expect(session.tasksPostId).toBe('post_1');
  });
});

describe('bumpAllStickyPosts', () => {
  let session: Session;
  let platform: PlatformClient;
  let registerPost: ReturnType<typeof mock>;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    registerPost = mock(() => {});
  });

  test('does nothing when no sticky posts', async () => {
    await bumpAllStickyPosts(session, registerPost);
    expect(platform.deletePost).not.toHaveBeenCalled();
    expect(platform.createInteractivePost).not.toHaveBeenCalled();
  });

  test('bumps only plan approval when no tasks', async () => {
    session.pendingApproval = {
      postId: 'plan_post',
      type: 'plan',
      toolUseId: 'tool1',
      content: 'Plan content',
    };

    await bumpAllStickyPosts(session, registerPost);

    // Should bump plan approval
    expect(platform.deletePost).toHaveBeenCalledWith('plan_post');
    expect(platform.createInteractivePost).toHaveBeenCalledTimes(1);
  });

  test('bumps only tasks when no plan approval', async () => {
    session.tasksPostId = 'task_post';
    session.lastTasksContent = '📋 **Tasks** (0/1 · 0%)\n○ Do something';

    await bumpAllStickyPosts(session, registerPost);

    // Should bump task list
    expect(platform.deletePost).toHaveBeenCalledWith('task_post');
    expect(platform.createInteractivePost).toHaveBeenCalledTimes(1);
  });

  test('bumps plan approval before task list', async () => {
    const deleteOrder: string[] = [];
    (platform.deletePost as ReturnType<typeof mock>).mockImplementation(async (postId: string) => {
      deleteOrder.push(postId);
    });

    session.pendingApproval = {
      postId: 'plan_post',
      type: 'plan',
      toolUseId: 'tool1',
      content: 'Plan content',
    };
    session.tasksPostId = 'task_post';
    session.lastTasksContent = '📋 **Tasks** (0/1 · 0%)\n○ Do something';

    await bumpAllStickyPosts(session, registerPost);

    // Plan should be bumped first, then tasks
    expect(deleteOrder).toEqual(['plan_post', 'task_post']);
  });
});

describe('getTaskDisplayContent', () => {
  let session: Session;
  let platform: PlatformClient;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
  });

  test('returns empty string when no content', () => {
    expect(getTaskDisplayContent(session)).toBe('');
  });

  test('returns full content when not minimized', () => {
    session.lastTasksContent = '📋 **Tasks** (0/1 · 0%)\n○ Do something';
    session.tasksMinimized = false;
    expect(getTaskDisplayContent(session)).toBe('📋 **Tasks** (0/1 · 0%)\n○ Do something');
  });

  test('returns minimized content when minimized', () => {
    session.lastTasksContent = '📋 **Tasks** (1/2 · 50%)\n✓ Done\n🔄 **In progress**';
    session.tasksMinimized = true;
    const result = getTaskDisplayContent(session);
    expect(result).toContain('📋');
    expect(result).toContain('(1/2 · 50%)');
    expect(result).toContain('🔽');
  });
});

describe('getMinimizedTaskContent', () => {
  test('extracts progress from content', () => {
    const formatter = {
      formatHorizontalRule: () => '---',
      formatBold: (text: string) => `**${text}**`,
    };
    const content = '📋 **Tasks** (3/5 · 60%)\n✓ Task 1\n✓ Task 2\n✓ Task 3\n○ Task 4\n○ Task 5';
    const result = getMinimizedTaskContent(content, formatter as ReturnType<PlatformClient['getFormatter']>);
    expect(result).toContain('(3/5 · 60%)');
    expect(result).toContain('🔽');
  });

  test('includes current task name', () => {
    const formatter = {
      formatHorizontalRule: () => '---',
      formatBold: (text: string) => `**${text}**`,
    };
    const content = '📋 **Tasks** (1/3 · 33%)\n✓ Done\n🔄 **Working on this** (45s)\n○ Next';
    const result = getMinimizedTaskContent(content, formatter as ReturnType<PlatformClient['getFormatter']>);
    expect(result).toContain('Working on this');
    expect(result).toContain('(45s)');
  });
});
