/**
 * Tests for PromptExecutor
 *
 * Tests the system prompt operations including:
 * - Context prompt (thread context selection)
 * - Existing worktree prompt (join/skip worktree)
 * - Update prompt (update now/defer)
 * - Processing user responses via reactions
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { PromptExecutor, type ContextPromptSelection, type ExistingWorktreeDecision, type UpdatePromptDecision } from './prompt.js';
import type { ExecutorContext, PendingContextPrompt, PendingExistingWorktreePrompt, PendingUpdatePrompt } from './types.js';
import type { PlatformClient, PlatformFormatter, PlatformPost } from '../../platform/index.js';
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
  const p = platform ?? createMockPlatform();
  const threadId = 'thread-123';

  return {
    sessionId: 'test:session-1',
    threadId,
    platform: p,
    postTracker: new PostTracker(),
    contentBreaker: new DefaultContentBreaker(),
    formatter: mockFormatter,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, debugJson: () => {}, forSession: () => ({} as any) } as any,
    createPost: async (content, _options) => {
      const post = await p.createPost(content, threadId);
      return post;
    },
    createInteractivePost: async (content, reactions, _options) => {
      const post = await p.createInteractivePost(content, reactions, threadId);
      return post;
    },
  };
}

describe('PromptExecutor', () => {
  let executor: PromptExecutor;
  let ctx: ExecutorContext;
  let contextPromptCompleted: { selection: ContextPromptSelection; queuedPrompt: string } | null;
  let worktreePromptCompleted: { decision: ExistingWorktreeDecision; branch: string; username: string } | null;
  let updatePromptCompleted: { decision: UpdatePromptDecision } | null;

  beforeEach(() => {
    contextPromptCompleted = null;
    worktreePromptCompleted = null;
    updatePromptCompleted = null;

    // Create event emitter and subscribe to events
    const events = createMessageManagerEvents();
    events.on('context-prompt:complete', ({ selection, queuedPrompt }) => {
      contextPromptCompleted = { selection, queuedPrompt };
    });
    events.on('worktree-prompt:complete', ({ decision, branch, username }) => {
      worktreePromptCompleted = { decision, branch, username };
    });
    events.on('update-prompt:complete', ({ decision }) => {
      updatePromptCompleted = { decision };
    });

    executor = new PromptExecutor({
      registerPost: (_postId, _options) => {},
      updateLastMessage: (_post) => {},
      events,
    });

    ctx = createTestContext();
  });

  // ===========================================================================
  // Constructor & Initialization (3 tests)
  // ===========================================================================
  describe('Constructor & Initialization', () => {
    it('creates with default state', () => {
      const state = executor.getState();
      expect(state).toBeDefined();
      expect(typeof state).toBe('object');
    });

    it('creates with dependencies injected', () => {
      const events = createMessageManagerEvents();
      const registerPost = mock(() => {});
      const updateLastMessage = mock(() => {});

      const exec = new PromptExecutor({
        registerPost,
        updateLastMessage,
        events,
      });

      expect(exec.getState()).toBeDefined();
    });

    it('all pending states start as null', () => {
      const state = executor.getState();
      expect(state.pendingContextPrompt).toBeNull();
      expect(state.pendingExistingWorktreePrompt).toBeNull();
      expect(state.pendingUpdatePrompt).toBeNull();
    });
  });

  // ===========================================================================
  // Context Prompt State Management (5 tests)
  // ===========================================================================
  describe('Context Prompt State Management', () => {
    it('setPendingContextPrompt stores prompt', () => {
      const prompt: PendingContextPrompt = {
        postId: 'post-123',
        queuedPrompt: 'What is 2 + 2?',
        threadMessageCount: 5,
        createdAt: Date.now(),
        availableOptions: [1, 3, 5],
      };

      executor.setPendingContextPrompt(prompt);

      expect(executor.getPendingContextPrompt()).toEqual(prompt);
    });

    it('getPendingContextPrompt returns prompt', () => {
      const prompt: PendingContextPrompt = {
        postId: 'post-456',
        queuedPrompt: 'Test prompt',
        threadMessageCount: 10,
        createdAt: Date.now(),
        availableOptions: [1, 5, 10],
      };

      executor.setPendingContextPrompt(prompt);

      const result = executor.getPendingContextPrompt();
      expect(result?.postId).toBe('post-456');
      expect(result?.queuedPrompt).toBe('Test prompt');
    });

    it('hasPendingContextPrompt returns true when prompt exists', () => {
      expect(executor.hasPendingContextPrompt()).toBe(false);

      executor.setPendingContextPrompt({
        postId: 'post-123',
        queuedPrompt: 'Test',
        threadMessageCount: 3,
        createdAt: Date.now(),
        availableOptions: [1, 3],
      });

      expect(executor.hasPendingContextPrompt()).toBe(true);
    });

    it('hasPendingContextPrompt returns false when no prompt', () => {
      expect(executor.hasPendingContextPrompt()).toBe(false);
    });

    it('clearPendingContextPrompt clears state', () => {
      executor.setPendingContextPrompt({
        postId: 'post-123',
        queuedPrompt: 'Test',
        threadMessageCount: 3,
        createdAt: Date.now(),
        availableOptions: [1, 3],
      });

      expect(executor.hasPendingContextPrompt()).toBe(true);

      executor.clearPendingContextPrompt();

      expect(executor.hasPendingContextPrompt()).toBe(false);
      expect(executor.getPendingContextPrompt()).toBeNull();
    });
  });

  // ===========================================================================
  // Existing Worktree Prompt State (5 tests)
  // ===========================================================================
  describe('Existing Worktree Prompt State', () => {
    it('setPendingExistingWorktreePrompt stores prompt', () => {
      const prompt: PendingExistingWorktreePrompt = {
        postId: 'post-wt-123',
        branch: 'feature/new-feature',
        worktreePath: '/path/to/worktree',
        username: 'testuser',
      };

      executor.setPendingExistingWorktreePrompt(prompt);

      expect(executor.getPendingExistingWorktreePrompt()).toEqual(prompt);
    });

    it('getPendingExistingWorktreePrompt returns prompt', () => {
      const prompt: PendingExistingWorktreePrompt = {
        postId: 'post-wt-456',
        branch: 'main',
        worktreePath: '/worktrees/main',
        username: 'developer',
      };

      executor.setPendingExistingWorktreePrompt(prompt);

      const result = executor.getPendingExistingWorktreePrompt();
      expect(result?.branch).toBe('main');
      expect(result?.username).toBe('developer');
    });

    it('hasPendingExistingWorktreePrompt returns true when prompt exists', () => {
      expect(executor.hasPendingExistingWorktreePrompt()).toBe(false);

      executor.setPendingExistingWorktreePrompt({
        postId: 'post-wt',
        branch: 'develop',
        worktreePath: '/path',
        username: 'user',
      });

      expect(executor.hasPendingExistingWorktreePrompt()).toBe(true);
    });

    it('hasPendingExistingWorktreePrompt returns false when no prompt', () => {
      expect(executor.hasPendingExistingWorktreePrompt()).toBe(false);
    });

    it('clearPendingExistingWorktreePrompt clears state', () => {
      executor.setPendingExistingWorktreePrompt({
        postId: 'post-wt',
        branch: 'develop',
        worktreePath: '/path',
        username: 'user',
      });

      expect(executor.hasPendingExistingWorktreePrompt()).toBe(true);

      executor.clearPendingExistingWorktreePrompt();

      expect(executor.hasPendingExistingWorktreePrompt()).toBe(false);
    });
  });

  // ===========================================================================
  // Update Prompt State (5 tests)
  // ===========================================================================
  describe('Update Prompt State', () => {
    it('setPendingUpdatePrompt stores prompt', () => {
      const prompt: PendingUpdatePrompt = {
        postId: 'post-update-123',
      };

      executor.setPendingUpdatePrompt(prompt);

      expect(executor.getPendingUpdatePrompt()).toEqual(prompt);
    });

    it('getPendingUpdatePrompt returns prompt', () => {
      const prompt: PendingUpdatePrompt = {
        postId: 'post-update-456',
      };

      executor.setPendingUpdatePrompt(prompt);

      const result = executor.getPendingUpdatePrompt();
      expect(result?.postId).toBe('post-update-456');
    });

    it('hasPendingUpdatePrompt returns true when prompt exists', () => {
      expect(executor.hasPendingUpdatePrompt()).toBe(false);

      executor.setPendingUpdatePrompt({ postId: 'post-update' });

      expect(executor.hasPendingUpdatePrompt()).toBe(true);
    });

    it('hasPendingUpdatePrompt returns false when no prompt', () => {
      expect(executor.hasPendingUpdatePrompt()).toBe(false);
    });

    it('clearPendingUpdatePrompt clears state', () => {
      executor.setPendingUpdatePrompt({ postId: 'post-update' });

      expect(executor.hasPendingUpdatePrompt()).toBe(true);

      executor.clearPendingUpdatePrompt();

      expect(executor.hasPendingUpdatePrompt()).toBe(false);
    });
  });

  // ===========================================================================
  // Persistence (4 tests)
  // ===========================================================================
  describe('Persistence', () => {
    it('getState returns all pending states', () => {
      const contextPrompt: PendingContextPrompt = {
        postId: 'ctx-post',
        queuedPrompt: 'prompt',
        threadMessageCount: 5,
        createdAt: Date.now(),
        availableOptions: [1, 5],
      };
      const worktreePrompt: PendingExistingWorktreePrompt = {
        postId: 'wt-post',
        branch: 'main',
        worktreePath: '/path',
        username: 'user',
      };
      const updatePrompt: PendingUpdatePrompt = {
        postId: 'update-post',
      };

      executor.setPendingContextPrompt(contextPrompt);
      executor.setPendingExistingWorktreePrompt(worktreePrompt);
      executor.setPendingUpdatePrompt(updatePrompt);

      const state = executor.getState();

      expect(state.pendingContextPrompt).toEqual(contextPrompt);
      expect(state.pendingExistingWorktreePrompt).toEqual(worktreePrompt);
      expect(state.pendingUpdatePrompt).toEqual(updatePrompt);
    });

    it('getState returns readonly copy of state', () => {
      executor.setPendingUpdatePrompt({ postId: 'post-1' });

      const state1 = executor.getState();
      const state2 = executor.getState();

      // Should be different object references (copies)
      expect(state1).not.toBe(state2);
      expect(state1).toEqual(state2);
    });

    it('reset clears all state', () => {
      executor.setPendingContextPrompt({
        postId: 'ctx-post',
        queuedPrompt: 'prompt',
        threadMessageCount: 5,
        createdAt: Date.now(),
        availableOptions: [1, 5],
      });
      executor.setPendingExistingWorktreePrompt({
        postId: 'wt-post',
        branch: 'main',
        worktreePath: '/path',
        username: 'user',
      });
      executor.setPendingUpdatePrompt({ postId: 'update-post' });

      executor.reset();

      const state = executor.getState();
      expect(state.pendingContextPrompt).toBeNull();
      expect(state.pendingExistingWorktreePrompt).toBeNull();
      expect(state.pendingUpdatePrompt).toBeNull();
    });

    it('hydrateState restores all prompts', () => {
      const persisted = {
        pendingContextPrompt: {
          postId: 'ctx-post',
          queuedPrompt: 'hydrated prompt',
          threadMessageCount: 10,
          createdAt: 1234567890,
          availableOptions: [1, 5, 10],
        },
        pendingExistingWorktreePrompt: {
          postId: 'wt-post',
          branch: 'feature',
          worktreePath: '/hydrated/path',
          username: 'hydrateduser',
        },
        pendingUpdatePrompt: {
          postId: 'update-post',
        },
      };

      executor.hydrateState(persisted);

      const state = executor.getState();
      expect(state.pendingContextPrompt?.queuedPrompt).toBe('hydrated prompt');
      expect(state.pendingExistingWorktreePrompt?.branch).toBe('feature');
      expect(state.pendingUpdatePrompt?.postId).toBe('update-post');
    });
  });

  // ===========================================================================
  // handleContextPromptResponse (4 tests)
  // ===========================================================================
  describe('handleContextPromptResponse', () => {
    it('returns false if no context prompt pending', async () => {
      const handled = await executor.handleContextPromptResponse(
        'post-123',
        5,
        'user1',
        ctx
      );

      expect(handled).toBe(false);
    });

    it('returns false if postId does not match', async () => {
      executor.setPendingContextPrompt({
        postId: 'post-correct',
        queuedPrompt: 'Test',
        threadMessageCount: 5,
        createdAt: Date.now(),
        availableOptions: [1, 5],
      });

      const handled = await executor.handleContextPromptResponse(
        'post-wrong',
        5,
        'user1',
        ctx
      );

      expect(handled).toBe(false);
      expect(executor.hasPendingContextPrompt()).toBe(true);
    });

    it('handles selection with number of messages', async () => {
      executor.setPendingContextPrompt({
        postId: 'post-123',
        queuedPrompt: 'Test prompt',
        threadMessageCount: 10,
        createdAt: Date.now(),
        availableOptions: [1, 5, 10],
      });

      const handled = await executor.handleContextPromptResponse(
        'post-123',
        5,
        'responder',
        ctx
      );

      expect(handled).toBe(true);
      expect(executor.hasPendingContextPrompt()).toBe(false);
      expect(contextPromptCompleted).not.toBeNull();
      expect(contextPromptCompleted!.selection).toBe(5);
      expect(contextPromptCompleted!.queuedPrompt).toBe('Test prompt');
    });

    it('handles timeout selection', async () => {
      executor.setPendingContextPrompt({
        postId: 'post-timeout',
        queuedPrompt: 'Timeout test',
        threadMessageCount: 3,
        createdAt: Date.now(),
        availableOptions: [1, 3],
      });

      const handled = await executor.handleContextPromptResponse(
        'post-timeout',
        'timeout',
        'system',
        ctx
      );

      expect(handled).toBe(true);
      expect(executor.hasPendingContextPrompt()).toBe(false);
      expect(contextPromptCompleted!.selection).toBe('timeout');
    });
  });

  // ===========================================================================
  // handleExistingWorktreeResponse (3 tests)
  // ===========================================================================
  describe('handleExistingWorktreeResponse', () => {
    it('returns false if no worktree prompt pending', async () => {
      const handled = await executor.handleExistingWorktreeResponse(
        'post-123',
        'join',
        'user1',
        ctx
      );

      expect(handled).toBe(false);
    });

    it('handles join decision', async () => {
      executor.setPendingExistingWorktreePrompt({
        postId: 'wt-post',
        branch: 'feature/test',
        worktreePath: '/path/to/worktree',
        username: 'developer',
      });

      const handled = await executor.handleExistingWorktreeResponse(
        'wt-post',
        'join',
        'responder',
        ctx
      );

      expect(handled).toBe(true);
      expect(executor.hasPendingExistingWorktreePrompt()).toBe(false);
      expect(worktreePromptCompleted).not.toBeNull();
      expect(worktreePromptCompleted!.decision).toBe('join');
      expect(worktreePromptCompleted!.branch).toBe('feature/test');
    });

    it('handles skip decision', async () => {
      executor.setPendingExistingWorktreePrompt({
        postId: 'wt-post',
        branch: 'main',
        worktreePath: '/worktree/main',
        username: 'user',
      });

      const handled = await executor.handleExistingWorktreeResponse(
        'wt-post',
        'skip',
        'skipper',
        ctx
      );

      expect(handled).toBe(true);
      expect(worktreePromptCompleted!.decision).toBe('skip');
    });
  });

  // ===========================================================================
  // handleUpdatePromptResponse (2 tests)
  // ===========================================================================
  describe('handleUpdatePromptResponse', () => {
    it('handles update_now decision', async () => {
      executor.setPendingUpdatePrompt({ postId: 'update-post' });

      const handled = await executor.handleUpdatePromptResponse(
        'update-post',
        'update_now',
        'admin',
        ctx
      );

      expect(handled).toBe(true);
      expect(executor.hasPendingUpdatePrompt()).toBe(false);
      expect(updatePromptCompleted).not.toBeNull();
      expect(updatePromptCompleted!.decision).toBe('update_now');
    });

    it('handles defer decision', async () => {
      executor.setPendingUpdatePrompt({ postId: 'update-post' });

      const handled = await executor.handleUpdatePromptResponse(
        'update-post',
        'defer',
        'user',
        ctx
      );

      expect(handled).toBe(true);
      expect(updatePromptCompleted!.decision).toBe('defer');
    });
  });

  // ===========================================================================
  // handleReaction - General (3 tests)
  // ===========================================================================
  describe('handleReaction - General', () => {
    it('ignores removed reactions', async () => {
      executor.setPendingUpdatePrompt({ postId: 'post-123' });

      const handled = await executor.handleReaction(
        'post-123',
        '+1',
        'user',
        'removed',
        ctx
      );

      expect(handled).toBe(false);
      expect(executor.hasPendingUpdatePrompt()).toBe(true);
    });

    it('returns false when no pending state matches postId', async () => {
      const handled = await executor.handleReaction(
        'unknown-post',
        '+1',
        'user',
        'added',
        ctx
      );

      expect(handled).toBe(false);
    });

    it('returns false for unrecognized emoji on pending prompt', async () => {
      executor.setPendingUpdatePrompt({ postId: 'post-123' });

      const handled = await executor.handleReaction(
        'post-123',
        'random_emoji',
        'user',
        'added',
        ctx
      );

      expect(handled).toBe(false);
    });
  });

  // ===========================================================================
  // handleReaction for Context Prompt (4 tests)
  // ===========================================================================
  describe('handleReaction for Context Prompt', () => {
    it('returns false if no context prompt pending', async () => {
      const handled = await executor.handleReaction(
        'post-123',
        'one',
        'user',
        'added',
        ctx
      );

      expect(handled).toBe(false);
    });

    it('handles number emoji to select context', async () => {
      executor.setPendingContextPrompt({
        postId: 'ctx-post',
        queuedPrompt: 'Number selection test',
        threadMessageCount: 10,
        createdAt: Date.now(),
        availableOptions: [1, 5, 10], // index 0=1, 1=5, 2=10
      });

      // 'two' emoji = index 1 = 5 messages
      const handled = await executor.handleReaction(
        'ctx-post',
        'two',
        'selector',
        'added',
        ctx
      );

      expect(handled).toBe(true);
      expect(contextPromptCompleted!.selection).toBe(5);
    });

    it('handles denial emoji to skip context', async () => {
      executor.setPendingContextPrompt({
        postId: 'ctx-post',
        queuedPrompt: 'Skip test',
        threadMessageCount: 5,
        createdAt: Date.now(),
        availableOptions: [1, 5],
      });

      const handled = await executor.handleReaction(
        'ctx-post',
        '-1', // thumbsdown = denial
        'skipper',
        'added',
        ctx
      );

      expect(handled).toBe(true);
      expect(contextPromptCompleted!.selection).toBe(0);
    });

    it('ignores invalid number emoji index', async () => {
      executor.setPendingContextPrompt({
        postId: 'ctx-post',
        queuedPrompt: 'Invalid index test',
        threadMessageCount: 3,
        createdAt: Date.now(),
        availableOptions: [1, 3], // only 2 options (index 0, 1)
      });

      // 'four' emoji = index 3, which is out of bounds
      const handled = await executor.handleReaction(
        'ctx-post',
        'four',
        'user',
        'added',
        ctx
      );

      expect(handled).toBe(false);
      expect(executor.hasPendingContextPrompt()).toBe(true);
    });
  });

  // ===========================================================================
  // handleReaction for Worktree Prompts (3 tests)
  // ===========================================================================
  describe('handleReaction for Worktree Prompts', () => {
    it('handles approval emoji for join', async () => {
      executor.setPendingExistingWorktreePrompt({
        postId: 'wt-post',
        branch: 'feature',
        worktreePath: '/path',
        username: 'user',
      });

      const handled = await executor.handleReaction(
        'wt-post',
        '+1', // approval = join
        'joiner',
        'added',
        ctx
      );

      expect(handled).toBe(true);
      expect(worktreePromptCompleted!.decision).toBe('join');
    });

    it('handles denial emoji for skip', async () => {
      executor.setPendingExistingWorktreePrompt({
        postId: 'wt-post',
        branch: 'feature',
        worktreePath: '/path',
        username: 'user',
      });

      const handled = await executor.handleReaction(
        'wt-post',
        '-1', // denial = skip
        'skipper',
        'added',
        ctx
      );

      expect(handled).toBe(true);
      expect(worktreePromptCompleted!.decision).toBe('skip');
    });

    it('clears state after handling', async () => {
      executor.setPendingExistingWorktreePrompt({
        postId: 'wt-post',
        branch: 'feature',
        worktreePath: '/path',
        username: 'user',
      });

      await executor.handleReaction(
        'wt-post',
        '+1',
        'user',
        'added',
        ctx
      );

      expect(executor.hasPendingExistingWorktreePrompt()).toBe(false);
    });
  });

  // ===========================================================================
  // handleReaction for Update Prompt (2 tests)
  // ===========================================================================
  describe('handleReaction for Update Prompt', () => {
    it('handles approval emoji for update_now', async () => {
      executor.setPendingUpdatePrompt({ postId: 'update-post' });

      const handled = await executor.handleReaction(
        'update-post',
        '+1',
        'admin',
        'added',
        ctx
      );

      expect(handled).toBe(true);
      expect(updatePromptCompleted!.decision).toBe('update_now');
    });

    it('handles denial emoji for defer', async () => {
      executor.setPendingUpdatePrompt({ postId: 'update-post' });

      const handled = await executor.handleReaction(
        'update-post',
        '-1',
        'user',
        'added',
        ctx
      );

      expect(handled).toBe(true);
      expect(updatePromptCompleted!.decision).toBe('defer');
    });
  });

  // ===========================================================================
  // State Isolation (3 tests)
  // ===========================================================================
  describe('State Isolation', () => {
    it('context prompt does not affect worktree prompt', () => {
      executor.setPendingContextPrompt({
        postId: 'ctx-post',
        queuedPrompt: 'context',
        threadMessageCount: 5,
        createdAt: Date.now(),
        availableOptions: [1, 5],
      });

      expect(executor.hasPendingContextPrompt()).toBe(true);
      expect(executor.hasPendingExistingWorktreePrompt()).toBe(false);

      executor.clearPendingContextPrompt();

      expect(executor.hasPendingContextPrompt()).toBe(false);
      expect(executor.hasPendingExistingWorktreePrompt()).toBe(false);
    });

    it('worktree prompt does not affect update prompt', () => {
      executor.setPendingExistingWorktreePrompt({
        postId: 'wt-post',
        branch: 'main',
        worktreePath: '/path',
        username: 'user',
      });

      expect(executor.hasPendingExistingWorktreePrompt()).toBe(true);
      expect(executor.hasPendingUpdatePrompt()).toBe(false);

      executor.clearPendingExistingWorktreePrompt();

      expect(executor.hasPendingUpdatePrompt()).toBe(false);
    });

    it('can have all three prompts pending simultaneously', () => {
      executor.setPendingContextPrompt({
        postId: 'ctx-post',
        queuedPrompt: 'context',
        threadMessageCount: 5,
        createdAt: Date.now(),
        availableOptions: [1, 5],
      });
      executor.setPendingExistingWorktreePrompt({
        postId: 'wt-post',
        branch: 'main',
        worktreePath: '/path',
        username: 'user',
      });
      executor.setPendingUpdatePrompt({ postId: 'update-post' });

      expect(executor.hasPendingContextPrompt()).toBe(true);
      expect(executor.hasPendingExistingWorktreePrompt()).toBe(true);
      expect(executor.hasPendingUpdatePrompt()).toBe(true);
    });
  });

  // ===========================================================================
  // Event Emission (3 tests)
  // ===========================================================================
  describe('Event Emission', () => {
    it('emits context-prompt:complete with correct data', async () => {
      executor.setPendingContextPrompt({
        postId: 'ctx-post',
        queuedPrompt: 'Test prompt',
        queuedFiles: [{ id: 'file-1', name: 'test.txt' }],
        threadMessageCount: 10,
        createdAt: Date.now(),
        availableOptions: [1, 5, 10],
      });

      await executor.handleContextPromptResponse('ctx-post', 5, 'user', ctx);

      expect(contextPromptCompleted).not.toBeNull();
      expect(contextPromptCompleted!.selection).toBe(5);
      expect(contextPromptCompleted!.queuedPrompt).toBe('Test prompt');
    });

    it('emits worktree-prompt:complete with correct data', async () => {
      executor.setPendingExistingWorktreePrompt({
        postId: 'wt-post',
        branch: 'feature/branch',
        worktreePath: '/worktree/path',
        username: 'developer',
      });

      await executor.handleExistingWorktreeResponse('wt-post', 'join', 'responder', ctx);

      expect(worktreePromptCompleted).not.toBeNull();
      expect(worktreePromptCompleted!.decision).toBe('join');
      expect(worktreePromptCompleted!.branch).toBe('feature/branch');
      expect(worktreePromptCompleted!.username).toBe('responder');
    });

    it('emits update-prompt:complete with correct data', async () => {
      executor.setPendingUpdatePrompt({ postId: 'update-post' });

      await executor.handleUpdatePromptResponse('update-post', 'defer', 'user', ctx);

      expect(updatePromptCompleted).not.toBeNull();
      expect(updatePromptCompleted!.decision).toBe('defer');
    });
  });

  // ===========================================================================
  // Post Update (3 tests)
  // ===========================================================================
  describe('Post Update', () => {
    it('updates post after context prompt response', async () => {
      executor.setPendingContextPrompt({
        postId: 'ctx-post',
        queuedPrompt: 'Test',
        threadMessageCount: 5,
        createdAt: Date.now(),
        availableOptions: [1, 5],
      });

      await executor.handleContextPromptResponse('ctx-post', 5, 'user', ctx);

      expect(ctx.platform.updatePost).toHaveBeenCalledWith(
        'ctx-post',
        expect.stringContaining('Including last 5 messages')
      );
    });

    it('updates post after worktree prompt response', async () => {
      executor.setPendingExistingWorktreePrompt({
        postId: 'wt-post',
        branch: 'feature',
        worktreePath: '/path',
        username: 'user',
      });

      await executor.handleExistingWorktreeResponse('wt-post', 'join', 'responder', ctx);

      expect(ctx.platform.updatePost).toHaveBeenCalledWith(
        'wt-post',
        expect.stringContaining('Joining existing worktree')
      );
    });

    it('updates post after update prompt response', async () => {
      executor.setPendingUpdatePrompt({ postId: 'update-post' });

      await executor.handleUpdatePromptResponse('update-post', 'update_now', 'admin', ctx);

      expect(ctx.platform.updatePost).toHaveBeenCalledWith(
        'update-post',
        expect.stringContaining('Forcing update')
      );
    });
  });

  // ===========================================================================
  // Edge Cases (3 tests)
  // ===========================================================================
  describe('Edge Cases', () => {
    it('handles zero context selection (skip)', async () => {
      executor.setPendingContextPrompt({
        postId: 'ctx-post',
        queuedPrompt: 'Test',
        threadMessageCount: 5,
        createdAt: Date.now(),
        availableOptions: [1, 5],
      });

      await executor.handleContextPromptResponse('ctx-post', 0, 'skipper', ctx);

      expect(contextPromptCompleted!.selection).toBe(0);
      expect(ctx.platform.updatePost).toHaveBeenCalledWith(
        'ctx-post',
        expect.stringContaining('without context')
      );
    });

    it('handles context prompt with queuedFiles', async () => {
      executor.setPendingContextPrompt({
        postId: 'ctx-post',
        queuedPrompt: 'Test with files',
        queuedFiles: [
          { id: 'file-1', name: 'doc.pdf' },
          { id: 'file-2', name: 'image.png' },
        ],
        threadMessageCount: 3,
        createdAt: Date.now(),
        availableOptions: [1, 3],
      });

      await executor.handleContextPromptResponse('ctx-post', 3, 'user', ctx);

      expect(executor.hasPendingContextPrompt()).toBe(false);
    });

    it('gracefully handles updatePost failure', async () => {
      (ctx.platform.updatePost as ReturnType<typeof mock>) = mock(async () => {
        throw new Error('Update failed');
      });

      executor.setPendingContextPrompt({
        postId: 'ctx-post',
        queuedPrompt: 'Test',
        threadMessageCount: 5,
        createdAt: Date.now(),
        availableOptions: [1, 5],
      });

      // Should not throw, but still clear state and emit event
      const handled = await executor.handleContextPromptResponse('ctx-post', 5, 'user', ctx);

      expect(handled).toBe(true);
      expect(executor.hasPendingContextPrompt()).toBe(false);
      expect(contextPromptCompleted).not.toBeNull();
    });
  });

  // ===========================================================================
  // Hydration Edge Cases (2 tests)
  // ===========================================================================
  describe('Hydration Edge Cases', () => {
    it('handles partial hydration data', () => {
      executor.hydrateState({
        pendingContextPrompt: {
          postId: 'ctx-only',
          queuedPrompt: 'partial',
          threadMessageCount: 2,
          createdAt: Date.now(),
          availableOptions: [2],
        },
        // Missing pendingExistingWorktreePrompt and pendingUpdatePrompt
      });

      const state = executor.getState();
      expect(state.pendingContextPrompt).not.toBeNull();
      expect(state.pendingExistingWorktreePrompt).toBeNull();
      expect(state.pendingUpdatePrompt).toBeNull();
    });

    it('handles empty hydration data', () => {
      executor.hydrateState({});

      const state = executor.getState();
      expect(state.pendingContextPrompt).toBeNull();
      expect(state.pendingExistingWorktreePrompt).toBeNull();
      expect(state.pendingUpdatePrompt).toBeNull();
    });
  });
});
