/**
 * Tests for SubagentExecutor
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { SubagentExecutor } from './subagent.js';
import type { ExecutorContext } from './types.js';
import type { PlatformClient, PlatformFormatter, PlatformPost } from '../../platform/index.js';
import type { SubagentOp } from '../types.js';
import { DefaultContentBreaker } from '../content-breaker.js';
import { PostTracker } from '../post-tracker.js';

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
  const posts = new Map<string, { content: string; reactions: string[] }>();
  let postIdCounter = 0;

  return {
    getFormatter: () => mockFormatter,
    createPost: mock(async (content: string, _threadId: string): Promise<PlatformPost> => {
      const id = `post_${++postIdCounter}`;
      posts.set(id, { content, reactions: [] });
      return { id, platformId: 'test', channelId: 'channel-1', message: content, createAt: Date.now(), userId: 'bot' };
    }),
    createInteractivePost: mock(async (content: string, reactions: string[], _threadId: string): Promise<PlatformPost> => {
      const id = `post_${++postIdCounter}`;
      posts.set(id, { content, reactions });
      return { id, platformId: 'test', channelId: 'channel-1', message: content, createAt: Date.now(), userId: 'bot' };
    }),
    updatePost: mock(async (postId: string, content: string): Promise<void> => {
      const post = posts.get(postId);
      if (post) {
        post.content = content;
      }
    }),
    deletePost: mock(async (_postId: string): Promise<void> => {}),
    getMessageLimits: () => ({ maxLength: 16000, hardThreshold: 12000 }),
    pinPost: mock(async () => {}),
    unpinPost: mock(async () => {}),
    addReaction: mock(async () => {}),
    removeReaction: mock(async () => {}),
  } as unknown as PlatformClient;
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

describe('SubagentExecutor', () => {
  let executor: SubagentExecutor;
  let ctx: ExecutorContext;
  let registeredPosts: Map<string, unknown>;
  let taskListBumped: boolean;

  beforeEach(() => {
    registeredPosts = new Map();
    taskListBumped = false;

    executor = new SubagentExecutor({
      registerPost: (postId, options) => {
        registeredPosts.set(postId, options);
      },
      updateLastMessage: (_post) => {
        // Track last message if needed
      },
      onBumpTaskList: async () => {
        taskListBumped = true;
      },
    });

    ctx = createTestContext();
  });

  afterEach(() => {
    executor.reset();
  });

  describe('start action', () => {
    it('creates a subagent status post', async () => {
      const op: SubagentOp = {
        type: 'subagent',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        toolUseId: 'tool-123',
        action: 'start',
        description: 'Searching for files',
        subagentType: 'Explore',
      };

      await executor.execute(op, ctx);

      expect(ctx.platform.createInteractivePost).toHaveBeenCalled();
      expect(registeredPosts.size).toBe(1);
      expect(taskListBumped).toBe(true);

      const state = executor.getState();
      expect(state.activeSubagents.size).toBe(1);
      expect(state.activeSubagents.get('tool-123')).toBeDefined();
    });

    it('tracks multiple subagents', async () => {
      const op1: SubagentOp = {
        type: 'subagent',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        toolUseId: 'tool-1',
        action: 'start',
        description: 'First task',
        subagentType: 'Explore',
      };

      const op2: SubagentOp = {
        type: 'subagent',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        toolUseId: 'tool-2',
        action: 'start',
        description: 'Second task',
        subagentType: 'Plan',
      };

      await executor.execute(op1, ctx);
      await executor.execute(op2, ctx);

      const state = executor.getState();
      expect(state.activeSubagents.size).toBe(2);
    });

    it('starts with expanded state by default', async () => {
      const op: SubagentOp = {
        type: 'subagent',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        toolUseId: 'tool-123',
        action: 'start',
        description: 'Task',
        subagentType: 'Explore',
      };

      await executor.execute(op, ctx);

      const subagent = executor.getActiveSubagents().get('tool-123');
      expect(subagent?.isMinimized).toBe(false);
    });
  });

  describe('complete action', () => {
    it('marks subagent as complete', async () => {
      // Start a subagent
      const startOp: SubagentOp = {
        type: 'subagent',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        toolUseId: 'tool-123',
        action: 'start',
        description: 'Task',
        subagentType: 'Explore',
      };
      await executor.execute(startOp, ctx);

      // Complete it
      const completeOp: SubagentOp = {
        type: 'subagent',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        toolUseId: 'tool-123',
        action: 'complete',
        description: 'Task',
        subagentType: 'Explore',
      };
      await executor.execute(completeOp, ctx);

      const subagent = executor.getActiveSubagents().get('tool-123');
      expect(subagent?.isComplete).toBe(true);
    });

    it('updates the post with completion status', async () => {
      const startOp: SubagentOp = {
        type: 'subagent',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        toolUseId: 'tool-123',
        action: 'start',
        description: 'Task',
        subagentType: 'Explore',
      };
      await executor.execute(startOp, ctx);

      const completeOp: SubagentOp = {
        type: 'subagent',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        toolUseId: 'tool-123',
        action: 'complete',
        description: 'Task',
        subagentType: 'Explore',
      };
      await executor.execute(completeOp, ctx);

      // Should have updated the post (once for creation, once for completion)
      expect(ctx.platform.updatePost).toHaveBeenCalled();
    });
  });

  describe('toggle_minimize action', () => {
    it('toggles minimize state', async () => {
      // Start a subagent
      const startOp: SubagentOp = {
        type: 'subagent',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        toolUseId: 'tool-123',
        action: 'start',
        description: 'Task',
        subagentType: 'Explore',
      };
      await executor.execute(startOp, ctx);

      // Toggle minimize
      const toggleOp: SubagentOp = {
        type: 'subagent',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        toolUseId: 'tool-123',
        action: 'toggle_minimize',
        description: 'Task',
        subagentType: 'Explore',
      };
      await executor.execute(toggleOp, ctx);

      const subagent = executor.getActiveSubagents().get('tool-123');
      expect(subagent?.isMinimized).toBe(true);

      // Toggle again
      await executor.execute(toggleOp, ctx);
      expect(executor.getActiveSubagents().get('tool-123')?.isMinimized).toBe(false);
    });
  });

  describe('handleToggleReaction', () => {
    it('handles minimize reaction', async () => {
      const startOp: SubagentOp = {
        type: 'subagent',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        toolUseId: 'tool-123',
        action: 'start',
        description: 'Task',
        subagentType: 'Explore',
      };
      await executor.execute(startOp, ctx);

      const subagent = executor.getActiveSubagents().get('tool-123');
      expect(subagent).toBeDefined();
      const postId = subagent!.postId;

      // Add reaction = minimize
      const handled = await executor.handleToggleReaction(postId, 'added', ctx);

      expect(handled).toBe(true);
      expect(executor.getActiveSubagents().get('tool-123')!.isMinimized).toBe(true);
    });

    it('handles expand reaction', async () => {
      const startOp: SubagentOp = {
        type: 'subagent',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        toolUseId: 'tool-123',
        action: 'start',
        description: 'Task',
        subagentType: 'Explore',
        isMinimized: true,
      };
      await executor.execute(startOp, ctx);

      // Toggle to minimized first
      const toggleOp: SubagentOp = {
        ...startOp,
        action: 'toggle_minimize',
      };
      await executor.execute(toggleOp, ctx);

      const subagent = executor.getActiveSubagents().get('tool-123');
      expect(subagent).toBeDefined();
      const postId = subagent!.postId;

      // Remove reaction = expand
      const handled = await executor.handleToggleReaction(postId, 'removed', ctx);

      expect(handled).toBe(true);
      expect(executor.getActiveSubagents().get('tool-123')!.isMinimized).toBe(false);
    });

    it('returns false for unknown post', async () => {
      const handled = await executor.handleToggleReaction('unknown-post', 'added', ctx);
      expect(handled).toBe(false);
    });

    it('skips if already in desired state', async () => {
      const startOp: SubagentOp = {
        type: 'subagent',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        toolUseId: 'tool-123',
        action: 'start',
        description: 'Task',
        subagentType: 'Explore',
      };
      await executor.execute(startOp, ctx);

      const subagent = executor.getActiveSubagents().get('tool-123');
      expect(subagent).toBeDefined();
      const postId = subagent!.postId;

      // Already expanded, remove reaction should do nothing
      const handled = await executor.handleToggleReaction(postId, 'removed', ctx);

      expect(handled).toBe(true);
      expect(executor.getActiveSubagents().get('tool-123')!.isMinimized).toBe(false);
    });
  });

  describe('State Management', () => {
    it('resets state correctly', async () => {
      const op: SubagentOp = {
        type: 'subagent',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        toolUseId: 'tool-123',
        action: 'start',
        description: 'Task',
        subagentType: 'Explore',
      };
      await executor.execute(op, ctx);

      expect(executor.getState().activeSubagents.size).toBe(1);

      executor.reset();

      expect(executor.getState().activeSubagents.size).toBe(0);
      expect(executor.hasUpdateTimer()).toBe(false);
    });

    it('getActiveSubagents returns the map', async () => {
      const op: SubagentOp = {
        type: 'subagent',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        toolUseId: 'tool-123',
        action: 'start',
        description: 'Task',
        subagentType: 'Explore',
      };
      await executor.execute(op, ctx);

      const subagents = executor.getActiveSubagents();
      expect(subagents).toBeInstanceOf(Map);
      expect(subagents.size).toBe(1);
    });
  });
});
