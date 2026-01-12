/**
 * Tests for SystemExecutor
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { SystemExecutor } from './system.js';
import type { ExecutorContext } from './types.js';
import type { PlatformClient, PlatformFormatter, PlatformPost } from '../../platform/index.js';
import type { SystemMessageOp, StatusUpdateOp, LifecycleOp } from '../types.js';
import { DefaultContentBreaker } from '../content-breaker.js';
import { PostTracker } from '../post-tracker.js';
import { createMessageManagerEvents } from '../message-manager-events.js';

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
function createMockPlatform(): PlatformClient & { posts: Map<string, { content: string }> } {
  const posts = new Map<string, { content: string }>();
  let postIdCounter = 0;

  return {
    posts,
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
    deletePost: mock(async (postId: string): Promise<void> => {
      posts.delete(postId);
    }),
    getMessageLimits: () => ({ maxLength: 16000, hardThreshold: 12000 }),
  } as unknown as PlatformClient & { posts: Map<string, { content: string }> };
}

// Create context for tests
function createTestContext(platform?: PlatformClient): ExecutorContext {
  return {
    sessionId: 'test:session-1',
    threadId: 'thread-123',
    platform: platform ?? createMockPlatform(),
    postTracker: new PostTracker(),
    contentBreaker: new DefaultContentBreaker(),
  };
}

describe('SystemExecutor', () => {
  let executor: SystemExecutor;
  let ctx: ExecutorContext;
  let registeredPosts: Map<string, unknown>;
  let statusUpdates: Partial<StatusUpdateOp>[];
  let lifecycleEvents: string[];

  beforeEach(() => {
    registeredPosts = new Map();
    statusUpdates = [];
    lifecycleEvents = [];

    // Create event emitter and subscribe to events
    const events = createMessageManagerEvents();
    events.on('status:update', (status) => {
      statusUpdates.push(status);
    });
    events.on('lifecycle:event', ({ event }) => {
      lifecycleEvents.push(event);
    });

    executor = new SystemExecutor({
      registerPost: (postId, options) => {
        registeredPosts.set(postId, options);
      },
      updateLastMessage: (_post) => {
        // Track last message if needed
      },
      events,
    });

    ctx = createTestContext();
  });

  describe('System Messages', () => {
    it('posts an info message', async () => {
      const op: SystemMessageOp = {
        type: 'system_message',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        message: 'Session started',
        level: 'info',
      };

      await executor.execute(op, ctx);

      expect(ctx.platform.createPost).toHaveBeenCalled();
      expect(registeredPosts.size).toBe(1);
    });

    it('posts a warning message with correct indicator', async () => {
      const op: SystemMessageOp = {
        type: 'system_message',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        message: 'Rate limit approaching',
        level: 'warning',
      };

      await executor.execute(op, ctx);

      const platform = ctx.platform as PlatformClient & { posts: Map<string, { content: string }> };
      const postContent = Array.from(platform.posts.values())[0]?.content;
      expect(postContent).toContain('⚠️');
    });

    it('posts an error message with correct indicator', async () => {
      const op: SystemMessageOp = {
        type: 'system_message',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        message: 'Connection failed',
        level: 'error',
      };

      await executor.execute(op, ctx);

      const platform = ctx.platform as PlatformClient & { posts: Map<string, { content: string }> };
      const postContent = Array.from(platform.posts.values())[0]?.content;
      expect(postContent).toContain('❌');
    });

    it('posts a success message with correct indicator', async () => {
      const op: SystemMessageOp = {
        type: 'system_message',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        message: 'Task completed',
        level: 'success',
      };

      await executor.execute(op, ctx);

      const platform = ctx.platform as PlatformClient & { posts: Map<string, { content: string }> };
      const postContent = Array.from(platform.posts.values())[0]?.content;
      expect(postContent).toContain('✅');
    });

    it('tracks ephemeral posts', async () => {
      const op: SystemMessageOp = {
        type: 'system_message',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        message: 'Temporary message',
        level: 'info',
        ephemeral: true,
      };

      await executor.execute(op, ctx);

      // Ephemeral posts should be tracked for cleanup
      expect(registeredPosts.size).toBe(1);
    });
  });

  describe('Status Updates', () => {
    it('notifies status update handler', async () => {
      const op: StatusUpdateOp = {
        type: 'status_update',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        modelId: 'claude-opus-4-5-20251101',
        modelDisplayName: 'Claude Opus 4.5',
        contextWindowSize: 200000,
        contextTokens: 50000,
        totalCostUSD: 1.25,
      };

      await executor.execute(op, ctx);

      expect(statusUpdates).toHaveLength(1);
      expect(statusUpdates[0].modelId).toBe('claude-opus-4-5-20251101');
      expect(statusUpdates[0].contextTokens).toBe(50000);
      expect(statusUpdates[0].totalCostUSD).toBe(1.25);
    });

    it('passes partial updates', async () => {
      const op: StatusUpdateOp = {
        type: 'status_update',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        contextTokens: 75000,
      };

      await executor.execute(op, ctx);

      expect(statusUpdates).toHaveLength(1);
      expect(statusUpdates[0].contextTokens).toBe(75000);
      expect(statusUpdates[0].modelId).toBeUndefined();
    });
  });

  describe('Lifecycle Events', () => {
    it('notifies lifecycle handler for started event', async () => {
      const op: LifecycleOp = {
        type: 'lifecycle',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        event: 'started',
      };

      await executor.execute(op, ctx);

      expect(lifecycleEvents).toHaveLength(1);
      expect(lifecycleEvents[0]).toBe('started');
    });

    it('notifies lifecycle handler for idle event', async () => {
      const op: LifecycleOp = {
        type: 'lifecycle',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        event: 'idle',
      };

      await executor.execute(op, ctx);

      expect(lifecycleEvents).toContain('idle');
    });

    it('notifies lifecycle handler for paused event', async () => {
      const op: LifecycleOp = {
        type: 'lifecycle',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        event: 'paused',
      };

      await executor.execute(op, ctx);

      expect(lifecycleEvents).toContain('paused');
    });
  });

  describe('Helper Methods', () => {
    it('postInfo creates info message', async () => {
      const post = await executor.postInfo('Test info message', ctx);

      expect(post).toBeDefined();
      expect(post?.message).toContain('ℹ️');
    });

    it('postWarning creates warning message', async () => {
      const post = await executor.postWarning('Test warning message', ctx);

      expect(post).toBeDefined();
      expect(post?.message).toContain('⚠️');
    });

    it('postError creates error message', async () => {
      const post = await executor.postError('Test error message', ctx);

      expect(post).toBeDefined();
      expect(post?.message).toContain('❌');
    });

    it('postSuccess creates success message', async () => {
      const post = await executor.postSuccess('Test success message', ctx);

      expect(post).toBeDefined();
      expect(post?.message).toContain('✅');
    });
  });

  describe('Ephemeral Post Cleanup', () => {
    it('cleans up ephemeral posts', async () => {
      // Create some ephemeral posts
      await executor.execute({
        type: 'system_message',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        message: 'Ephemeral 1',
        level: 'info',
        ephemeral: true,
      }, ctx);

      await executor.execute({
        type: 'system_message',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        message: 'Ephemeral 2',
        level: 'info',
        ephemeral: true,
      }, ctx);

      // Also create a non-ephemeral post
      await executor.execute({
        type: 'system_message',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        message: 'Permanent',
        level: 'info',
        ephemeral: false,
      }, ctx);

      const platform = ctx.platform as PlatformClient & { posts: Map<string, { content: string }> };
      expect(platform.posts.size).toBe(3);

      // Clean up ephemeral posts
      await executor.cleanupEphemeralPosts(ctx);

      // deletePost should have been called for ephemeral posts
      expect(ctx.platform.deletePost).toHaveBeenCalledTimes(2);
    });
  });

  describe('State Management', () => {
    it('resets ephemeral posts tracking', async () => {
      await executor.execute({
        type: 'system_message',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        message: 'Ephemeral',
        level: 'info',
        ephemeral: true,
      }, ctx);

      executor.reset();

      // After reset, cleanup should not delete anything
      await executor.cleanupEphemeralPosts(ctx);
      expect(ctx.platform.deletePost).not.toHaveBeenCalled();
    });
  });
});
