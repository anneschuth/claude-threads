/**
 * Tests for TaskListExecutor
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { TaskListExecutor } from './task-list.js';
import type { ExecutorContext, RegisterPostCallback, UpdateLastMessageCallback } from './types.js';
import type { PlatformClient, PlatformFormatter, PlatformPost } from '../../platform/index.js';
import { PostTracker, type RegisterPostOptions } from '../post-tracker.js';
import { DefaultContentBreaker } from '../content-breaker.js';
import { createTaskListOp, type TaskItem } from '../types.js';
import { MINIMIZE_TOGGLE_EMOJIS } from '../../utils/emoji.js';

// Mock formatter
const mockFormatter: PlatformFormatter = {
  formatBold: (text: string) => `**${text}**`,
  formatItalic: (text: string) => `_${text}_`,
  formatCode: (text: string) => `\`${text}\``,
  formatCodeBlock: (text: string, lang?: string) =>
    lang ? `\`\`\`${lang}\n${text}\n\`\`\`` : `\`\`\`\n${text}\n\`\`\``,
  formatLink: (text: string, url: string) => `[${text}](${url})`,
  formatStrikethrough: (text: string) => `~~${text}~~`,
  formatMarkdown: (text: string) => text,
  formatUserMention: (userId: string) => `@${userId}`,
  formatHorizontalRule: () => '---',
  formatBlockquote: (text: string) => `> ${text}`,
  formatListItem: (text: string) => `- ${text}`,
  formatNumberedListItem: (n: number, text: string) => `${n}. ${text}`,
  formatHeading: (text: string, level: number) => `${'#'.repeat(level)} ${text}`,
  escapeText: (text: string) => text,
  formatTable: (_headers: string[], _rows: string[][]) => '',
  formatKeyValueList: (_items: [string, string, string][]) => '',
};

// Create mock platform
function createMockPlatform(): PlatformClient {
  const posts = new Map<string, { content: string }>();
  let postIdCounter = 0;

  return {
    getFormatter: () => mockFormatter,
    createPost: mock(async (content: string, _threadId: string): Promise<PlatformPost> => {
      const id = `post_${++postIdCounter}`;
      posts.set(id, { content });
      return { id, platformId: 'test', channelId: 'channel-1', message: content, createAt: Date.now(), userId: 'bot' };
    }),
    createInteractivePost: mock(async (content: string, _reactions: string[], _threadId?: string): Promise<PlatformPost> => {
      const id = `post_${++postIdCounter}`;
      posts.set(id, { content });
      return { id, platformId: 'test', channelId: 'channel-1', message: content, createAt: Date.now(), userId: 'bot' };
    }),
    updatePost: mock(async (postId: string, content: string): Promise<PlatformPost> => {
      const post = posts.get(postId);
      if (post) {
        post.content = content;
      }
      return { id: postId, platformId: 'test', channelId: 'channel-1', message: content, createAt: Date.now(), userId: 'bot' };
    }),
    deletePost: mock(async (_postId: string): Promise<void> => {}),
    pinPost: mock(async (_postId: string): Promise<void> => {}),
    unpinPost: mock(async (_postId: string): Promise<void> => {}),
    addReaction: mock(async (_postId: string, _emoji: string): Promise<void> => {}),
    removeReaction: mock(async (_postId: string, _emoji: string): Promise<void> => {}),
    getMessageLimits: () => ({ maxLength: 16000, hardThreshold: 12000 }),
  } as unknown as PlatformClient;
}

// Sample tasks for testing
function createSampleTasks(): TaskItem[] {
  return [
    { content: 'First task', status: 'completed', activeForm: 'Completing first task' },
    { content: 'Second task', status: 'in_progress', activeForm: 'Working on second task' },
    { content: 'Third task', status: 'pending', activeForm: 'Will do third task' },
  ];
}

function createAllPendingTasks(): TaskItem[] {
  return [
    { content: 'Task 1', status: 'pending', activeForm: 'Starting task 1' },
    { content: 'Task 2', status: 'pending', activeForm: 'Starting task 2' },
  ];
}

function createAllCompletedTasks(): TaskItem[] {
  return [
    { content: 'Task 1', status: 'completed', activeForm: 'Completed task 1' },
    { content: 'Task 2', status: 'completed', activeForm: 'Completed task 2' },
  ];
}

describe('TaskListExecutor', () => {
  let executor: TaskListExecutor;
  let platform: PlatformClient;
  let postTracker: PostTracker;
  let contentBreaker: DefaultContentBreaker;
  let registeredPosts: Map<string, RegisterPostOptions | undefined>;
  let lastMessage: PlatformPost | null;

  let registerPostMock: RegisterPostCallback;
  let updateLastMessageMock: UpdateLastMessageCallback;

  beforeEach(() => {
    platform = createMockPlatform();
    postTracker = new PostTracker();
    contentBreaker = new DefaultContentBreaker();
    registeredPosts = new Map();
    lastMessage = null;

    registerPostMock = mock((postId: string, options?: RegisterPostOptions) => {
      registeredPosts.set(postId, options);
    });
    updateLastMessageMock = mock((post: PlatformPost) => {
      lastMessage = post;
    });

    executor = new TaskListExecutor({
      registerPost: registerPostMock,
      updateLastMessage: updateLastMessageMock,
    });
  });

  function getContext(): ExecutorContext {
    const threadId = 'thread-123';
    return {
      sessionId: 'test:session-1',
      threadId,
      platform,
      postTracker,
      contentBreaker,
      formatter: mockFormatter,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, debugJson: () => {}, forSession: () => ({} as any) } as any,
      createPost: async (content, options) => {
        const post = await platform.createPost(content, threadId);
        registerPostMock(post.id, options);
        updateLastMessageMock(post);
        return post;
      },
      createInteractivePost: async (content, reactions, options) => {
        const post = await platform.createInteractivePost(content, reactions, threadId);
        registerPostMock(post.id, options);
        updateLastMessageMock(post);
        return post;
      },
    };
  }

  // ===========================================================================
  // Constructor and Initial State (5 tests)
  // ===========================================================================
  describe('Constructor and Initial State', () => {
    it('creates executor with correct initial state', () => {
      const state = executor.getState();
      expect(state).toBeDefined();
      expect(typeof state).toBe('object');
    });

    it('initial state has null tasksPostId', () => {
      const state = executor.getState();
      expect(state.tasksPostId).toBeNull();
    });

    it('initial state has null lastTasksContent', () => {
      const state = executor.getState();
      expect(state.lastTasksContent).toBeNull();
    });

    it('initial state has tasksCompleted as false', () => {
      const state = executor.getState();
      expect(state.tasksCompleted).toBe(false);
    });

    it('initial state has tasksMinimized as false', () => {
      const state = executor.getState();
      expect(state.tasksMinimized).toBe(false);
    });

    it('initial state has null inProgressTaskStart', () => {
      const state = executor.getState();
      expect(state.inProgressTaskStart).toBeNull();
    });

    it('stores registerPost and updateLastMessage callbacks', async () => {
      const ctx = getContext();
      const tasks = createSampleTasks();
      const op = createTaskListOp('test', 'update', tasks);

      await executor.execute(op, ctx);

      expect(registerPostMock).toHaveBeenCalled();
      expect(updateLastMessageMock).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // execute() Method - Different Actions (10 tests)
  // ===========================================================================
  describe('execute() Method - Different Actions', () => {
    it('update action creates new task post when none exists', async () => {
      const ctx = getContext();
      const tasks = createSampleTasks();
      const op = createTaskListOp('test', 'update', tasks);

      await executor.execute(op, ctx);

      expect(platform.createInteractivePost).toHaveBeenCalled();
      expect(executor.getState().tasksPostId).toBe('post_1');
    });

    it('update action updates existing task post', async () => {
      const ctx = getContext();
      const tasks = createSampleTasks();

      // First update creates a post
      await executor.execute(createTaskListOp('test', 'update', tasks), ctx);
      expect(executor.getState().tasksPostId).toBe('post_1');

      // Second update should update the same post
      const newTasks = [...tasks];
      newTasks[2] = { content: 'Third task', status: 'in_progress', activeForm: 'Working on third' };
      await executor.execute(createTaskListOp('test', 'update', newTasks), ctx);

      expect(platform.updatePost).toHaveBeenCalled();
      expect(executor.getState().tasksPostId).toBe('post_1');
    });

    it('complete action marks tasks as complete', async () => {
      const ctx = getContext();
      const tasks = createAllCompletedTasks();

      // First create a task post
      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);

      // Then complete it
      const op = createTaskListOp('test', 'complete', tasks);
      await executor.execute(op, ctx);

      expect(executor.getState().tasksCompleted).toBe(true);
    });

    it('complete action unpins task post', async () => {
      const ctx = getContext();

      // Create task post
      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);

      // Complete it
      await executor.execute(createTaskListOp('test', 'complete', createAllCompletedTasks()), ctx);

      expect(platform.unpinPost).toHaveBeenCalled();
    });

    it('bump_to_bottom action moves task list to bottom', async () => {
      const ctx = getContext();

      // Create task post
      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      const originalPostId = executor.getState().tasksPostId;

      // Bump to bottom
      await executor.execute(createTaskListOp('test', 'bump_to_bottom', []), ctx);

      expect(platform.deletePost).toHaveBeenCalledWith(originalPostId);
      expect(executor.getState().tasksPostId).toBe('post_2');
    });

    it('toggle_minimize action switches between full and minimized views', async () => {
      const ctx = getContext();

      // Create task post
      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      expect(executor.getState().tasksMinimized).toBe(false);

      // Toggle minimize
      await executor.execute(createTaskListOp('test', 'toggle_minimize', []), ctx);
      expect(executor.getState().tasksMinimized).toBe(true);

      // Toggle again
      await executor.execute(createTaskListOp('test', 'toggle_minimize', []), ctx);
      expect(executor.getState().tasksMinimized).toBe(false);
    });

    it('handles unknown action gracefully', async () => {
      const ctx = getContext();
      const op = createTaskListOp('test', 'unknown_action' as 'update', []);

      // Should not throw
      await executor.execute(op, ctx);
    });

    it('update action sets tasksCompleted to false', async () => {
      const ctx = getContext();

      // Create and complete task list
      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      await executor.execute(createTaskListOp('test', 'complete', createAllCompletedTasks()), ctx);
      expect(executor.getState().tasksCompleted).toBe(true);

      // Update should reset tasksCompleted
      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      expect(executor.getState().tasksCompleted).toBe(false);
    });

    it('update action stores lastTasksContent', async () => {
      const ctx = getContext();
      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);

      expect(executor.getState().lastTasksContent).not.toBeNull();
      expect(executor.getState().lastTasksContent).toContain('Tasks');
    });

    it('handles platform errors gracefully in execute', async () => {
      const ctx = getContext();
      (platform.createInteractivePost as ReturnType<typeof mock>) = mock(async () => {
        throw new Error('Platform error');
      });

      // Should throw (error not caught at execute level)
      await expect(executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx))
        .rejects.toThrow('Platform error');
    });
  });

  // ===========================================================================
  // updateTaskList() Internal Logic (10 tests)
  // ===========================================================================
  describe('updateTaskList() Internal Logic', () => {
    it('creates new post with correct formatting', async () => {
      const ctx = getContext();
      const tasks = createSampleTasks();
      await executor.execute(createTaskListOp('test', 'update', tasks), ctx);

      const callArgs = (platform.createInteractivePost as ReturnType<typeof mock>).mock.calls[0];
      const content = callArgs[0] as string;

      expect(content).toContain('---'); // horizontal rule
      expect(content).toContain('**Tasks**'); // bold Tasks
      expect(content).toContain('1/3'); // 1 completed out of 3
    });

    it('updates existing post content', async () => {
      const ctx = getContext();

      // Create post
      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);

      // Update same post
      await executor.execute(createTaskListOp('test', 'update', createAllCompletedTasks()), ctx);

      expect(platform.updatePost).toHaveBeenCalled();
      const callArgs = (platform.updatePost as ReturnType<typeof mock>).mock.calls[0];
      const content = callArgs[1] as string;
      expect(content).toContain('2/2'); // 2 completed out of 2
    });

    it('pins new task post', async () => {
      const ctx = getContext();
      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);

      expect(platform.pinPost).toHaveBeenCalledWith('post_1');
    });

    it('handles platform.updatePost errors gracefully', async () => {
      const ctx = getContext();

      // Create post first
      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);

      // Make updatePost fail
      (platform.updatePost as ReturnType<typeof mock>) = mock(async () => {
        throw new Error('Update failed');
      });

      // Second update should create new post instead
      await executor.execute(createTaskListOp('test', 'update', createAllCompletedTasks()), ctx);

      expect(executor.getState().tasksPostId).toBe('post_2');
    });

    it('deletes old task post when updatePost fails and new post is created', async () => {
      // This test ensures we don't end up with TWO task lists visible
      // when updatePost fails and we create a new task list post.
      // Just unpinning isn't enough - the old post is still visible!
      const ctx = getContext();

      // Create initial task post (post_1)
      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      expect(executor.getState().tasksPostId).toBe('post_1');

      // Verify post_1 was pinned
      expect(platform.pinPost).toHaveBeenCalledWith('post_1');

      // Reset mocks to track new calls
      (platform.deletePost as ReturnType<typeof mock>).mockClear();
      (platform.pinPost as ReturnType<typeof mock>).mockClear();

      // Make updatePost fail
      (platform.updatePost as ReturnType<typeof mock>) = mock(async () => {
        throw new Error('Update failed');
      });

      // Second update should create new post AND delete the old one
      await executor.execute(createTaskListOp('test', 'update', createAllPendingTasks()), ctx);

      // Verify old post (post_1) was DELETED (not just unpinned)
      expect(platform.deletePost).toHaveBeenCalledWith('post_1');

      // Verify new post (post_2) was pinned
      expect(platform.pinPost).toHaveBeenCalledWith('post_2');

      // Verify we now have the new post ID
      expect(executor.getState().tasksPostId).toBe('post_2');
    });

    it('tracks in-progress task timing', async () => {
      const ctx = getContext();
      const tasks = createSampleTasks(); // Has one in_progress task

      await executor.execute(createTaskListOp('test', 'update', tasks), ctx);

      expect(executor.getState().inProgressTaskStart).not.toBeNull();
      expect(typeof executor.getState().inProgressTaskStart).toBe('number');
    });

    it('clears in-progress timing when no task is in progress', async () => {
      const ctx = getContext();

      // First update with in-progress task
      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      expect(executor.getState().inProgressTaskStart).not.toBeNull();

      // Update with no in-progress task
      await executor.execute(createTaskListOp('test', 'update', createAllPendingTasks()), ctx);
      expect(executor.getState().inProgressTaskStart).toBeNull();
    });

    it('formats task list with progress indicators', async () => {
      const ctx = getContext();
      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);

      const content = executor.getState().lastTasksContent!;
      expect(content).toContain('33%'); // 1 of 3 = 33%
      expect(content).toContain('✅'); // completed task
      expect(content).toContain('🔄'); // in-progress task
      expect(content).toContain('⬜'); // pending task
    });

    it('uses activeForm for in-progress tasks', async () => {
      const ctx = getContext();
      const tasks = [
        { content: 'Test task', status: 'in_progress' as const, activeForm: 'Testing actively' },
      ];

      await executor.execute(createTaskListOp('test', 'update', tasks), ctx);

      const content = executor.getState().lastTasksContent!;
      expect(content).toContain('Testing actively');
    });

    it('uses strikethrough for completed tasks', async () => {
      const ctx = getContext();
      const tasks = [
        { content: 'Done task', status: 'completed' as const, activeForm: 'Completing' },
      ];

      await executor.execute(createTaskListOp('test', 'update', tasks), ctx);

      const content = executor.getState().lastTasksContent!;
      expect(content).toContain('~~Done task~~');
    });

    it('displays minimized content when tasksMinimized is true', async () => {
      const ctx = getContext();

      // Create post
      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);

      // Minimize
      await executor.execute(createTaskListOp('test', 'toggle_minimize', []), ctx);

      // Update - should use minimized format
      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);

      const updateCalls = (platform.updatePost as ReturnType<typeof mock>).mock.calls;
      const lastUpdateContent = updateCalls[updateCalls.length - 1][1] as string;
      expect(lastUpdateContent).toContain('🔽'); // minimized indicator
    });
  });

  // ===========================================================================
  // completeTaskList() (6 tests)
  // ===========================================================================
  describe('completeTaskList()', () => {
    it('shows full task list on completion', async () => {
      const ctx = getContext();

      // Create and minimize
      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      await executor.execute(createTaskListOp('test', 'toggle_minimize', []), ctx);
      expect(executor.getState().tasksMinimized).toBe(true);

      // Complete - should show full list regardless of minimize state
      await executor.execute(createTaskListOp('test', 'complete', createAllCompletedTasks()), ctx);

      const updateCalls = (platform.updatePost as ReturnType<typeof mock>).mock.calls;
      const lastContent = updateCalls[updateCalls.length - 1][1] as string;
      // Full list doesn't have the minimized indicator
      expect(lastContent).not.toContain('🔽');
    });

    it('unpins the task post', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      (platform.unpinPost as ReturnType<typeof mock>).mockClear();

      await executor.execute(createTaskListOp('test', 'complete', createAllCompletedTasks()), ctx);

      expect(platform.unpinPost).toHaveBeenCalledWith('post_1');
    });

    it('handles missing tasksPostId gracefully', async () => {
      const ctx = getContext();

      // Complete without ever creating a task post
      await executor.execute(createTaskListOp('test', 'complete', createAllCompletedTasks()), ctx);

      // Should not throw, and should not try to update
      expect(platform.updatePost).not.toHaveBeenCalled();
    });

    it('clears inProgressTaskStart on completion', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      expect(executor.getState().inProgressTaskStart).not.toBeNull();

      await executor.execute(createTaskListOp('test', 'complete', createAllCompletedTasks()), ctx);
      expect(executor.getState().inProgressTaskStart).toBeNull();
    });

    it('stores final task content', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      await executor.execute(createTaskListOp('test', 'complete', createAllCompletedTasks()), ctx);

      expect(executor.getState().lastTasksContent).toContain('100%'); // all completed
    });

    it('ignores unpinPost errors', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);

      (platform.unpinPost as ReturnType<typeof mock>) = mock(async () => {
        throw new Error('Unpin failed');
      });

      // Should not throw
      await executor.execute(createTaskListOp('test', 'complete', createAllCompletedTasks()), ctx);
      expect(executor.getState().tasksCompleted).toBe(true);
    });
  });

  // ===========================================================================
  // bumpToBottom() (6 tests)
  // ===========================================================================
  describe('bumpToBottom()', () => {
    it('deletes old post and creates new one at bottom', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      const oldPostId = executor.getState().tasksPostId;

      const result = await executor.bumpToBottom(ctx);

      expect(platform.deletePost).toHaveBeenCalledWith(oldPostId);
      expect(platform.createInteractivePost).toHaveBeenCalledTimes(2); // initial + bump
      expect(result).toBe(oldPostId);
    });

    it('preserves minimize state when bumping', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      await executor.execute(createTaskListOp('test', 'toggle_minimize', []), ctx);

      await executor.bumpToBottom(ctx);

      const createCalls = (platform.createInteractivePost as ReturnType<typeof mock>).mock.calls;
      const lastContent = createCalls[createCalls.length - 1][0] as string;
      expect(lastContent).toContain('🔽'); // still minimized
    });

    it('returns old post ID correctly', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      const oldPostId = executor.getState().tasksPostId;

      const result = await executor.bumpToBottom(ctx);

      expect(result).toBe(oldPostId);
      expect(executor.getState().tasksPostId).toBe('post_2');
    });

    it('returns null when no task content exists', async () => {
      const ctx = getContext();

      const result = await executor.bumpToBottom(ctx);

      expect(result).toBeNull();
    });

    it('returns null when tasksCompleted is true', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      await executor.execute(createTaskListOp('test', 'complete', createAllCompletedTasks()), ctx);

      const result = await executor.bumpToBottom(ctx);

      expect(result).toBeNull();
    });

    it('pins new post after bump', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      (platform.pinPost as ReturnType<typeof mock>).mockClear();

      await executor.bumpToBottom(ctx);

      expect(platform.pinPost).toHaveBeenCalledWith('post_2');
    });
  });

  // ===========================================================================
  // toggleMinimize() (6 tests)
  // ===========================================================================
  describe('toggleMinimize()', () => {
    it('switches from full to minimized view', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      expect(executor.getState().tasksMinimized).toBe(false);

      await executor.toggleMinimize(ctx);

      expect(executor.getState().tasksMinimized).toBe(true);
    });

    it('switches from minimized to full view', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      await executor.toggleMinimize(ctx);
      expect(executor.getState().tasksMinimized).toBe(true);

      await executor.toggleMinimize(ctx);

      expect(executor.getState().tasksMinimized).toBe(false);
    });

    it('parses progress from minimized content', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      await executor.toggleMinimize(ctx);

      const updateCalls = (platform.updatePost as ReturnType<typeof mock>).mock.calls;
      const minimizedContent = updateCalls[updateCalls.length - 1][1] as string;

      // Should contain parsed progress
      expect(minimizedContent).toContain('1/3');
      expect(minimizedContent).toContain('33%');
    });

    it('shows in-progress task in minimized view', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      await executor.toggleMinimize(ctx);

      const updateCalls = (platform.updatePost as ReturnType<typeof mock>).mock.calls;
      const minimizedContent = updateCalls[updateCalls.length - 1][1] as string;

      expect(minimizedContent).toContain('🔄');
    });

    it('updates post with new content', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      (platform.updatePost as ReturnType<typeof mock>).mockClear();

      await executor.toggleMinimize(ctx);

      expect(platform.updatePost).toHaveBeenCalledWith('post_1', expect.any(String));
    });

    it('does nothing when no task post exists', async () => {
      const ctx = getContext();

      await executor.toggleMinimize(ctx);

      expect(platform.updatePost).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // handleReaction() (6 tests)
  // ===========================================================================
  describe('handleReaction()', () => {
    it('recognizes minimize toggle emoji', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);

      const result = await executor.handleReaction(
        'post_1',
        MINIMIZE_TOGGLE_EMOJIS[0],
        'added',
        ctx
      );

      expect(result).toBe(true);
    });

    it('returns true when handling toggle emoji', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);

      const result = await executor.handleReaction(
        'post_1',
        MINIMIZE_TOGGLE_EMOJIS[0],
        'added',
        ctx
      );

      expect(result).toBe(true);
    });

    it('returns false for non-toggle emojis', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);

      const result = await executor.handleReaction(
        'post_1',
        '+1', // thumbs up, not toggle
        'added',
        ctx
      );

      expect(result).toBe(false);
    });

    it('only responds to added action, not removed', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      const initialState = executor.getState().tasksMinimized;

      const result = await executor.handleReaction(
        'post_1',
        MINIMIZE_TOGGLE_EMOJIS[0],
        'removed',
        ctx
      );

      expect(result).toBe(true);
      // State should NOT change for 'removed' action
      expect(executor.getState().tasksMinimized).toBe(initialState);
    });

    it('ignores reactions on non-task posts', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);

      const result = await executor.handleReaction(
        'other-post-id',
        MINIMIZE_TOGGLE_EMOJIS[0],
        'added',
        ctx
      );

      expect(result).toBe(false);
    });

    it('handles reaction when tasksPostId is null', async () => {
      const ctx = getContext();

      const result = await executor.handleReaction(
        'post_1',
        MINIMIZE_TOGGLE_EMOJIS[0],
        'added',
        ctx
      );

      expect(result).toBe(false);
    });
  });

  // ===========================================================================
  // bumpAndGetOldPost() (5 tests)
  // ===========================================================================
  describe('bumpAndGetOldPost()', () => {
    it('returns old post ID when bumping', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);

      const result = await executor.bumpAndGetOldPost(ctx, 'New content');

      expect(result).toBe('post_1');
    });

    it('creates new task post at bottom', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      (platform.createInteractivePost as ReturnType<typeof mock>).mockClear();

      await executor.bumpAndGetOldPost(ctx, 'New content');

      expect(platform.createInteractivePost).toHaveBeenCalled();
      expect(executor.getState().tasksPostId).toBe('post_2');
    });

    it('repurposes old post with new content', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);

      await executor.bumpAndGetOldPost(ctx, 'Replacement content');

      expect(platform.updatePost).toHaveBeenCalledWith('post_1', 'Replacement content');
    });

    it('returns null when no active tasks', async () => {
      const ctx = getContext();

      const result = await executor.bumpAndGetOldPost(ctx, 'Content');

      expect(result).toBeNull();
    });

    it('returns null when tasksCompleted is true', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      await executor.execute(createTaskListOp('test', 'complete', createAllCompletedTasks()), ctx);

      const result = await executor.bumpAndGetOldPost(ctx, 'Content');

      expect(result).toBeNull();
    });

    it('deletes old post when updatePost fails during bump', async () => {
      // If we can't repurpose the old task post for content, we should delete it
      // to avoid having an orphaned task list post visible to users
      const ctx = getContext();

      // Create initial task post (post_1)
      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      expect(executor.getState().tasksPostId).toBe('post_1');

      // Reset mocks to track new calls
      (platform.deletePost as ReturnType<typeof mock>).mockClear();

      // Make updatePost fail
      (platform.updatePost as ReturnType<typeof mock>) = mock(async () => {
        throw new Error('Update failed');
      });

      // Bump should delete the old post when it can't be repurposed
      const result = await executor.bumpAndGetOldPost(ctx, 'New content');

      // Should return null since repurposing failed
      expect(result).toBeNull();

      // Old post (post_1) should be DELETED, not left orphaned
      expect(platform.deletePost).toHaveBeenCalledWith('post_1');

      // New task list (post_2) should be created
      expect(executor.getState().tasksPostId).toBe('post_2');
    });
  });

  // ===========================================================================
  // State Management (6 tests)
  // ===========================================================================
  describe('State Management', () => {
    it('hydrateState() restores from persisted data', () => {
      executor.hydrateState({
        tasksPostId: 'persisted-post-123',
        lastTasksContent: 'Persisted content',
        tasksCompleted: true,
        tasksMinimized: true,
      });

      const state = executor.getState();
      expect(state.tasksPostId).toBe('persisted-post-123');
      expect(state.lastTasksContent).toBe('Persisted content');
      expect(state.tasksCompleted).toBe(true);
      expect(state.tasksMinimized).toBe(true);
    });

    it('hydrateState() handles partial/missing data', () => {
      executor.hydrateState({
        tasksPostId: 'post-123',
        // other fields missing
      });

      const state = executor.getState();
      expect(state.tasksPostId).toBe('post-123');
      expect(state.lastTasksContent).toBeNull();
      expect(state.tasksCompleted).toBe(false);
      expect(state.tasksMinimized).toBe(false);
    });

    it('hydrateState() does not persist inProgressTaskStart', () => {
      executor.hydrateState({
        tasksPostId: 'post-123',
        lastTasksContent: 'Content',
        tasksCompleted: false,
        tasksMinimized: false,
      });

      expect(executor.getState().inProgressTaskStart).toBeNull();
    });

    it('reset() clears all state to initial values', async () => {
      const ctx = getContext();

      // Set up some state
      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      await executor.toggleMinimize(ctx);

      // Reset
      executor.reset();

      const state = executor.getState();
      expect(state.tasksPostId).toBeNull();
      expect(state.lastTasksContent).toBeNull();
      expect(state.tasksCompleted).toBe(false);
      expect(state.tasksMinimized).toBe(false);
      expect(state.inProgressTaskStart).toBeNull();
    });

    it('getState() returns readonly copy of state', () => {
      const state1 = executor.getState();
      const state2 = executor.getState();

      // Should be different object references
      expect(state1).not.toBe(state2);
      expect(state1).toEqual(state2);
    });

    it('getTasksPostId() returns current post ID', async () => {
      expect(executor.getTasksPostId()).toBeNull();

      const ctx = getContext();
      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);

      expect(executor.getTasksPostId()).toBe('post_1');
    });
  });

  // ===========================================================================
  // hasActiveTasks() (4 tests)
  // ===========================================================================
  describe('hasActiveTasks()', () => {
    it('returns false when no task post exists', () => {
      expect(executor.hasActiveTasks()).toBe(false);
    });

    it('returns false when no task content exists', async () => {
      // Manually set post ID but no content (edge case)
      executor.hydrateState({ tasksPostId: 'post-1' });
      expect(executor.hasActiveTasks()).toBe(false);
    });

    it('returns true when active tasks exist', async () => {
      const ctx = getContext();
      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);

      expect(executor.hasActiveTasks()).toBe(true);
    });

    it('returns false when tasks are completed', async () => {
      const ctx = getContext();
      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);
      await executor.execute(createTaskListOp('test', 'complete', createAllCompletedTasks()), ctx);

      expect(executor.hasActiveTasks()).toBe(false);
    });
  });

  // ===========================================================================
  // Edge Cases and Error Handling (5 tests)
  // ===========================================================================
  describe('Edge Cases and Error Handling', () => {
    it('handles empty task list', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', []), ctx);

      const content = executor.getState().lastTasksContent!;
      expect(content).toContain('0/0');
      expect(content).toContain('0%');
    });

    it('calculates correct percentage for large task lists', async () => {
      const ctx = getContext();
      const tasks: TaskItem[] = [];
      for (let i = 0; i < 10; i++) {
        tasks.push({
          content: `Task ${i + 1}`,
          status: i < 7 ? 'completed' : 'pending',
          activeForm: `Task ${i + 1}`,
        });
      }

      await executor.execute(createTaskListOp('test', 'update', tasks), ctx);

      const content = executor.getState().lastTasksContent!;
      expect(content).toContain('7/10');
      expect(content).toContain('70%');
    });

    it('handles removeReaction errors gracefully during bump', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);

      (platform.removeReaction as ReturnType<typeof mock>) = mock(async () => {
        throw new Error('Remove reaction failed');
      });

      // Should not throw
      await executor.bumpToBottom(ctx);
      expect(executor.getState().tasksPostId).toBe('post_2');
    });

    it('registers post with correct interaction type', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);

      expect(registerPostMock).toHaveBeenCalledWith('post_1', {
        type: 'task_list',
        interactionType: 'toggle_minimize',
      });
    });

    it('calls updateLastMessage with created post', async () => {
      const ctx = getContext();

      await executor.execute(createTaskListOp('test', 'update', createSampleTasks()), ctx);

      expect(updateLastMessageMock).toHaveBeenCalled();
      expect(lastMessage?.id).toBe('post_1');
    });
  });

  describe('Duplicate task list prevention', () => {
    /**
     * These tests verify that duplicate task lists are not created when
     * platform operations fail.
     *
     * The key scenarios that can cause duplicates:
     * 1. updatePost fails AND deletePost fails - old post remains, new post created
     * 2. bumpToBottom creates new post AND updateTaskList also creates new post (race)
     */

    it('should NOT create duplicate when updatePost fails - should keep old post (FIX)', async () => {
      const ctx = getContext();

      // Create initial task list
      const tasks = [
        { content: 'Task 1', status: 'in_progress' as const, activeForm: 'Task 1' },
      ];
      await executor.execute(createTaskListOp('test', 'update', tasks), ctx);
      expect(executor.getState().tasksPostId).toBe('post_1');

      // Make updatePost fail (simulates network error or stale post reference)
      const updatePostMock = platform.updatePost as ReturnType<typeof mock>;
      updatePostMock.mockImplementation(async () => {
        throw new Error('Post not found');
      });

      // Make deletePost also fail (simulates the post doesn't exist on platform)
      const deletePostMock = platform.deletePost as ReturnType<typeof mock>;
      deletePostMock.mockImplementation(async () => {
        throw new Error('Delete failed - post not found');
      });

      // Update with new content
      const newTasks = [
        { content: 'New Task 1', status: 'in_progress' as const, activeForm: 'New Task 1' },
      ];
      await executor.execute(createTaskListOp('test', 'update', newTasks), ctx);

      // EXPECTED BEHAVIOR (after fix):
      // If delete fails, we should NOT create a new post because
      // the old post might still exist. This prevents duplicates.
      // Instead, we should set tasksPostId to null and the next update
      // will create a fresh post.

      // For now, this test will FAIL because the current behavior creates
      // a new post even when delete fails (causing duplicates).

      // With the fix:
      // - If delete throws, don't create new post
      // - Set tasksPostId to null
      // - Log a warning
      // - Next update will create fresh post
      expect(executor.getState().tasksPostId).toBeNull();
      expect(platform.createInteractivePost).toHaveBeenCalledTimes(1); // Only initial creation
    });

    it('bumpToBottom followed by failed updateTaskList does NOT create duplicate (FIXED)', async () => {
      const ctx = getContext();

      // Create initial task list at 75%
      const tasks75 = [
        { content: 'Task 1', status: 'completed' as const, activeForm: 'Task 1' },
        { content: 'Task 2', status: 'completed' as const, activeForm: 'Task 2' },
        { content: 'Task 3', status: 'completed' as const, activeForm: 'Task 3' },
        { content: 'Task 4', status: 'in_progress' as const, activeForm: 'Task 4' },
      ];
      await executor.execute(createTaskListOp('test', 'update', tasks75), ctx);

      const originalPostId = executor.getState().tasksPostId;
      expect(originalPostId).toBe('post_1');

      // bumpToBottom (delete succeeds, creates new post)
      await executor.execute(createTaskListOp('test', 'bump_to_bottom', []), ctx);

      // After bump: tasksPostId should be post_2
      expect(executor.getState().tasksPostId).toBe('post_2');

      // Now make BOTH updatePost AND deletePost fail for the update operation
      const updatePostMock = platform.updatePost as ReturnType<typeof mock>;
      const deletePostMock = platform.deletePost as ReturnType<typeof mock>;

      updatePostMock.mockImplementation(async () => {
        throw new Error('Post not found');
      });
      deletePostMock.mockImplementation(async () => {
        throw new Error('Delete failed');
      });

      // Update with 100% completion - this should fail gracefully
      const tasks100 = tasks75.map(t => ({ ...t, status: 'completed' as const }));
      await executor.execute(createTaskListOp('test', 'update', tasks100), ctx);

      // FIXED BEHAVIOR: When both update and delete fail, we DON'T create a new post
      // This prevents duplicates
      expect(executor.getState().tasksPostId).toBeNull();
      // Only 2 posts created: post_1 (initial) and post_2 (from bump)
      expect(platform.createInteractivePost).toHaveBeenCalledTimes(2);
    });

    it('should clean up old task post when starting fresh task list after completed tasks', async () => {
      const ctx = getContext();

      // Create and complete a task list
      const tasks = [
        { content: 'Task 1', status: 'completed' as const, activeForm: 'Task 1' },
      ];
      await executor.execute(createTaskListOp('test', 'update', tasks), ctx);
      await executor.execute(createTaskListOp('test', 'complete', tasks), ctx);

      expect(executor.getState().tasksCompleted).toBe(true);
      expect(executor.getState().tasksPostId).toBe('post_1');

      // Now create a fresh task list (Claude started new work)
      const newTasks = [
        { content: 'New Task 1', status: 'in_progress' as const, activeForm: 'New Task 1' },
      ];
      await executor.execute(createTaskListOp('test', 'update', newTasks), ctx);

      // The old completed post should be reused (not left behind as a duplicate)
      expect(executor.getState().tasksPostId).toBe('post_1');
      // No new post should be created
      expect(platform.createInteractivePost).toHaveBeenCalledTimes(1);
    });

    /**
     * This test verifies the fix for the race condition where bumpToBottom and
     * bumpAndGetOldPost could both try to create new task posts, causing duplicates.
     *
     * Scenario that caused duplicates (BEFORE FIX):
     * 1. bumpToBottom() deletes old post, creates new post at 1768291703.603889
     * 2. bumpAndGetOldPost() still has reference to deleted post 1768291688.505399
     * 3. bumpAndGetOldPost() tries to repurpose deleted post -> fails
     * 4. bumpAndGetOldPost() creates ANOTHER task post -> DUPLICATE!
     *
     * The fix: Only ONE bump mechanism should exist. We removed SubagentExecutor's
     * bump callback, so only ContentExecutor's bumpAndGetOldPost handles bumping.
     */
    it('should NOT create duplicate task posts when bumpToBottom runs before bumpAndGetOldPost', async () => {
      const ctx = getContext();

      // Create initial task list
      const tasks = [
        { content: 'Task 1', status: 'in_progress' as const, activeForm: 'Doing task 1' },
        { content: 'Task 2', status: 'pending' as const, activeForm: 'Task 2' },
      ];
      await executor.execute(createTaskListOp('test', 'update', tasks), ctx);
      expect(executor.getState().tasksPostId).toBe('post_1');

      // Track the number of createInteractivePost calls
      const createPostCallsBefore = (platform.createInteractivePost as ReturnType<typeof mock>).mock.calls.length;

      // Simulate: bumpToBottom is called first (this was previously triggered by SubagentExecutor)
      await executor.bumpToBottom(ctx);

      // Task list should now be at post_2
      expect(executor.getState().tasksPostId).toBe('post_2');

      // Now simulate: bumpAndGetOldPost is called
      // It should detect that a bump already happened (tasksPostId changed) and NOT create another post
      const repurposedPostId = await executor.bumpAndGetOldPost(ctx, 'Some content to post');

      // The current task post (post_2) should have been repurposed for content
      expect(repurposedPostId).toBe('post_2');

      // A new task post (post_3) should be created at the bottom
      expect(executor.getState().tasksPostId).toBe('post_3');

      // CRITICAL: We should NOT have any orphaned task posts (duplicates)
      // Total createInteractivePost calls: 1 (initial) + 1 (bumpToBottom) + 1 (bumpAndGetOldPost) = 3
      const createPostCallsAfter = (platform.createInteractivePost as ReturnType<typeof mock>).mock.calls.length;
      expect(createPostCallsAfter).toBe(createPostCallsBefore + 2); // +1 for bumpToBottom, +1 for bumpAndGetOldPost
    });

    /**
     * Regression test: Simultaneous bumpToBottom and bumpAndGetOldPost calls
     *
     * Reproduces the race condition from production (timestamp 1768292703816)
     * where both methods were called simultaneously, causing duplicate task posts.
     *
     * Root cause: Both methods read tasksPostId before either modifies it.
     * Fix: Calls should be serialized - only one bump operation at a time.
     */
    it('should NOT create duplicate task posts when bumpToBottom and bumpAndGetOldPost run SIMULTANEOUSLY', async () => {
      const ctx = getContext();

      // Create initial task list
      const tasks = [
        { content: 'Task 1', status: 'in_progress' as const, activeForm: 'Doing task 1' },
        { content: 'Task 2', status: 'pending' as const, activeForm: 'Task 2' },
      ];
      await executor.execute(createTaskListOp('test', 'update', tasks), ctx);
      expect(executor.getState().tasksPostId).toBe('post_1');

      // Track post creations
      const createPostCallsBefore = (platform.createInteractivePost as ReturnType<typeof mock>).mock.calls.length;

      // Run BOTH operations SIMULTANEOUSLY (this is the race condition)
      // In production, these are triggered by: user message + content flush
      await Promise.all([
        executor.bumpToBottom(ctx),
        executor.bumpAndGetOldPost(ctx, 'Content to post'),
      ]);

      // Count total createInteractivePost calls
      const createPostCallsAfter = (platform.createInteractivePost as ReturnType<typeof mock>).mock.calls.length;

      // CRITICAL: Should only create at most 2 new posts (one from each method)
      // The IDEAL behavior: only 1 new task post is created (both methods coordinate)
      // Current buggy behavior might create 3+ posts due to race
      const newPostsCreated = createPostCallsAfter - createPostCallsBefore;

      // This is the elegant expectation: only 1 bump happens, creating 1 new task post
      // The other method either reuses the result or is a no-op
      expect(newPostsCreated).toBe(1);

      // The state should be consistent - one valid tasksPostId
      const finalTasksPostId = executor.getState().tasksPostId;
      expect(finalTasksPostId).toBeTruthy();
    });
  });
});
