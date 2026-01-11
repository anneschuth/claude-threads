/**
 * Tests for ContentExecutor
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { ContentExecutor } from './content.js';
import type { ExecutorContext } from './types.js';
import type { PlatformClient, PlatformFormatter, PlatformPost } from '../../platform/index.js';
import { PostTracker, type RegisterPostOptions } from '../post-tracker.js';
import { DefaultContentBreaker } from '../content-breaker.js';
import { createAppendContentOp, createFlushOp } from '../types.js';

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
    updatePost: mock(async (postId: string, content: string): Promise<void> => {
      const post = posts.get(postId);
      if (post) {
        post.content = content;
      }
    }),
    getMessageLimits: () => ({ maxLength: 16000, hardThreshold: 12000 }),
  } as unknown as PlatformClient;
}

describe('ContentExecutor', () => {
  let executor: ContentExecutor;
  let platform: PlatformClient;
  let postTracker: PostTracker;
  let contentBreaker: DefaultContentBreaker;
  let registeredPosts: Map<string, RegisterPostOptions | undefined>;
  let lastMessage: PlatformPost | null;

  beforeEach(() => {
    platform = createMockPlatform();
    postTracker = new PostTracker();
    contentBreaker = new DefaultContentBreaker();
    registeredPosts = new Map();
    lastMessage = null;

    executor = new ContentExecutor({
      registerPost: (postId, options) => {
        registeredPosts.set(postId, options ?? { type: 'content' });
      },
      updateLastMessage: (post) => {
        lastMessage = post;
      },
    });
  });

  function getContext(): ExecutorContext {
    return {
      sessionId: 'test:session-1',
      threadId: 'thread-123',
      platform,
      postTracker,
      contentBreaker,
    };
  }

  describe('Initialization', () => {
    it('creates executor with empty state', () => {
      const state = executor.getState();
      expect(state.currentPostId).toBeNull();
      expect(state.currentPostContent).toBe('');
      expect(state.pendingContent).toBe('');
      expect(state.updateTimer).toBeNull();
    });

    it('resets state correctly', async () => {
      await executor.executeAppend(createAppendContentOp('test', 'Hello'), getContext());
      executor.reset();

      const state = executor.getState();
      expect(state.pendingContent).toBe('');
    });
  });

  describe('Append Content', () => {
    it('appends content to pending', async () => {
      const ctx = getContext();
      await executor.executeAppend(createAppendContentOp('test', 'Hello'), ctx);

      expect(executor.getState().pendingContent).toBe('Hello');
    });

    it('accumulates multiple appends', async () => {
      const ctx = getContext();
      await executor.executeAppend(createAppendContentOp('test', 'Hello '), ctx);
      await executor.executeAppend(createAppendContentOp('test', 'World'), ctx);

      expect(executor.getState().pendingContent).toBe('Hello World');
    });
  });

  describe('Flush', () => {
    it('does nothing when no pending content', async () => {
      const ctx = getContext();
      await executor.executeFlush(createFlushOp('test', 'explicit'), ctx);

      expect(platform.createPost).not.toHaveBeenCalled();
    });

    it('creates post when flushing content', async () => {
      const ctx = getContext();
      await executor.executeAppend(createAppendContentOp('test', 'Hello World'), ctx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), ctx);

      expect(platform.createPost).toHaveBeenCalledWith('Hello World', 'thread-123');
      expect(executor.getState().currentPostId).toBe('post_1');
      expect(executor.getState().pendingContent).toBe('');
    });

    it('updates existing post when currentPostId is set', async () => {
      const ctx = getContext();

      // First flush creates a post
      await executor.executeAppend(createAppendContentOp('test', 'Hello\n'), ctx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), ctx);

      // Second flush updates the same post
      // Content is trimmed during formatting, but newlines create separation
      await executor.executeAppend(createAppendContentOp('test', 'World'), ctx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), ctx);

      expect(platform.createPost).toHaveBeenCalledTimes(1);
      expect(platform.updatePost).toHaveBeenCalledTimes(1);
      // Content is combined with previous post content
      expect(platform.updatePost).toHaveBeenCalledWith('post_1', 'HelloWorld');
    });

    it('registers post for reaction routing', async () => {
      const ctx = getContext();
      await executor.executeAppend(createAppendContentOp('test', 'Hello'), ctx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), ctx);

      expect(registeredPosts.has('post_1')).toBe(true);
      expect(registeredPosts.get('post_1')?.type).toBe('content');
    });

    it('updates lastMessage after creating post', async () => {
      const ctx = getContext();
      await executor.executeAppend(createAppendContentOp('test', 'Hello'), ctx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), ctx);

      expect(lastMessage).not.toBeNull();
      expect(lastMessage?.id).toBe('post_1');
    });

    it('clears pending content after flush', async () => {
      const ctx = getContext();
      await executor.executeAppend(createAppendContentOp('test', 'Hello'), ctx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), ctx);

      expect(executor.getState().pendingContent).toBe('');
    });

    it('preserves content added during async flush', async () => {
      const ctx = getContext();

      // Simulate content being added during async operation
      let addedDuringFlush = false;
      const originalCreatePost = platform.createPost;
      (platform.createPost as ReturnType<typeof mock>) = mock(async (content: string, threadId: string) => {
        // Add more content during the async createPost call
        if (!addedDuringFlush) {
          addedDuringFlush = true;
          await executor.executeAppend(createAppendContentOp('test', ' extra'), ctx);
        }
        return originalCreatePost(content, threadId);
      });

      await executor.executeAppend(createAppendContentOp('test', 'Hello'), ctx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), ctx);

      // The extra content should be preserved
      expect(executor.getState().pendingContent).toBe(' extra');
    });
  });

  describe('Schedule Flush', () => {
    it('schedules delayed flush', async () => {
      const ctx = getContext();
      await executor.executeAppend(createAppendContentOp('test', 'Hello'), ctx);
      executor.scheduleFlush(ctx, 10);

      expect(executor.getState().updateTimer).not.toBeNull();

      // Wait for timer
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(executor.getState().updateTimer).toBeNull();
      expect(platform.createPost).toHaveBeenCalled();
    });

    it('does not double-schedule', async () => {
      const ctx = getContext();
      await executor.executeAppend(createAppendContentOp('test', 'Hello'), ctx);

      executor.scheduleFlush(ctx, 100);
      const timer1 = executor.getState().updateTimer;

      executor.scheduleFlush(ctx, 100);
      const timer2 = executor.getState().updateTimer;

      // Same timer reference
      expect(timer1).toBe(timer2);

      // Cleanup
      executor.reset();
    });
  });

  describe('Task List Bump Integration', () => {
    it('uses bumped post ID when onBumpTaskList returns one', async () => {
      const executorWithBump = new ContentExecutor({
        registerPost: (postId, options) => {
          registeredPosts.set(postId, options ?? { type: 'content' });
        },
        updateLastMessage: (post) => {
          lastMessage = post;
        },
        onBumpTaskList: async () => 'bumped_task_post_id',
      });

      const ctx = getContext();
      await executorWithBump.executeAppend(createAppendContentOp('test', 'Hello'), ctx);
      await executorWithBump.executeFlush(createFlushOp('test', 'explicit'), ctx);

      expect(executorWithBump.getState().currentPostId).toBe('bumped_task_post_id');
      // createPost should not be called since we reused the task list post
      expect(platform.createPost).not.toHaveBeenCalled();
    });

    it('creates new post when onBumpTaskList returns null', async () => {
      const executorWithBump = new ContentExecutor({
        registerPost: (postId, options) => {
          registeredPosts.set(postId, options ?? { type: 'content' });
        },
        updateLastMessage: (post) => {
          lastMessage = post;
        },
        onBumpTaskList: async () => null,
      });

      const ctx = getContext();
      await executorWithBump.executeAppend(createAppendContentOp('test', 'Hello'), ctx);
      await executorWithBump.executeFlush(createFlushOp('test', 'explicit'), ctx);

      expect(platform.createPost).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('handles updatePost failure gracefully', async () => {
      const ctx = getContext();

      // First flush creates a post
      await executor.executeAppend(createAppendContentOp('test', 'Hello'), ctx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), ctx);

      // Make updatePost fail
      (platform.updatePost as ReturnType<typeof mock>) = mock(async () => {
        throw new Error('Update failed');
      });

      // Second flush should handle the error
      await executor.executeAppend(createAppendContentOp('test', ' World'), ctx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), ctx);

      // currentPostId should be cleared after failure
      expect(executor.getState().currentPostId).toBeNull();
    });
  });
});
