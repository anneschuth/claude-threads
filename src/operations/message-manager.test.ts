/**
 * Tests for MessageManager
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { MessageManager } from './message-manager.js';
import type { PlatformClient, PlatformFormatter, PlatformPost } from '../platform/index.js';
import { PostTracker } from './post-tracker.js';

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

describe('MessageManager', () => {
  let manager: MessageManager;
  let platform: PlatformClient;
  let postTracker: PostTracker;
  let registeredPosts: Map<string, unknown>;
  let _lastMessage: PlatformPost | null;
  let _questionCompleted: { toolUseId: string; answers: Array<{ header: string; answer: string }> } | null;
  let _approvalCompleted: { toolUseId: string; approved: boolean } | null;

  beforeEach(() => {
    platform = createMockPlatform();
    postTracker = new PostTracker();
    registeredPosts = new Map();
    _lastMessage = null;
    _questionCompleted = null;
    _approvalCompleted = null;

    manager = new MessageManager({
      platform,
      postTracker,
      sessionId: 'test:session-1',
      threadId: 'thread-123',
      registerPost: (postId, options) => {
        registeredPosts.set(postId, options);
      },
      updateLastMessage: (post) => {
        _lastMessage = post;
      },
    });

    // Subscribe to events for testing (replaces old callback approach)
    manager.events.on('question:complete', ({ toolUseId, answers }) => {
      _questionCompleted = { toolUseId, answers };
    });
    manager.events.on('approval:complete', ({ toolUseId, approved }) => {
      _approvalCompleted = { toolUseId, approved };
    });
  });

  describe('Initialization', () => {
    it('creates manager with correct options', () => {
      expect(manager).toBeDefined();
    });

    it('starts with no pending questions', () => {
      expect(manager.hasPendingQuestions()).toBe(false);
    });

    it('starts with no pending approval', () => {
      expect(manager.hasPendingApproval()).toBe(false);
    });

    it('starts with empty task list state', () => {
      const state = manager.getTaskListState();
      expect(state.postId).toBeNull();
      expect(state.content).toBeNull();
      expect(state.isMinimized).toBe(false);
      expect(state.isCompleted).toBe(false);
    });
  });

  describe('System Messages', () => {
    it('posts info message', async () => {
      const post = await manager.postInfo('Test info message');

      expect(post).toBeDefined();
      expect(post?.message).toContain('ℹ️');
      expect(post?.message).toContain('Test info message');
    });

    it('posts warning message', async () => {
      const post = await manager.postWarning('Test warning message');

      expect(post).toBeDefined();
      expect(post?.message).toContain('⚠️');
    });

    it('posts error message', async () => {
      const post = await manager.postError('Test error message');

      expect(post).toBeDefined();
      expect(post?.message).toContain('❌');
    });

    it('posts success message', async () => {
      const post = await manager.postSuccess('Test success message');

      expect(post).toBeDefined();
      expect(post?.message).toContain('✅');
    });
  });

  describe('Worktree Info', () => {
    it('sets worktree info', () => {
      manager.setWorktreeInfo('/path/to/worktree', 'feature-branch');
      // No assertion needed - just verify no error
    });

    it('clears worktree info', () => {
      manager.setWorktreeInfo('/path/to/worktree', 'feature-branch');
      manager.clearWorktreeInfo();
      // No assertion needed - just verify no error
    });
  });

  describe('Lifecycle', () => {
    it('resets state', () => {
      manager.reset();

      expect(manager.hasPendingQuestions()).toBe(false);
      expect(manager.hasPendingApproval()).toBe(false);
      expect(manager.getTaskListState().postId).toBeNull();
    });

    it('disposes resources', () => {
      manager.dispose();

      // Should not throw
      expect(manager.hasPendingQuestions()).toBe(false);
    });
  });

  describe('Event Handling', () => {
    it('handles assistant text event', async () => {
      const event = {
        type: 'assistant' as const,
        message: {
          content: [
            { type: 'text', text: 'Hello, world!' },
          ],
        },
      };

      await manager.handleEvent(event);

      // Content is accumulated but not immediately flushed
      // Manual flush to verify content was processed
      await manager.flush();

      expect(platform.createPost).toHaveBeenCalled();
    });

    it('handles result event', async () => {
      // First send some content
      const textEvent = {
        type: 'assistant' as const,
        message: {
          content: [
            { type: 'text', text: 'Processing complete.' },
          ],
        },
      };
      await manager.handleEvent(textEvent);

      // Then send result event
      const resultEvent = {
        type: 'result' as const,
        result: {},
      };
      await manager.handleEvent(resultEvent);

      // Result event triggers flush
      expect(platform.createPost).toHaveBeenCalled();
    });
  });

  describe('Flush Behavior', () => {
    it('flushes pending content manually', async () => {
      const event = {
        type: 'assistant' as const,
        message: {
          content: [
            { type: 'text', text: 'Test content' },
          ],
        },
      };

      await manager.handleEvent(event);
      await manager.flush();

      expect(platform.createPost).toHaveBeenCalled();
    });
  });

  describe('State Hydration', () => {
    it('hydrates task list state', () => {
      manager.hydrateTaskListState({
        tasksPostId: 'task-post-123',
        lastTasksContent: '📋 Tasks (1/2)',
        tasksCompleted: false,
        tasksMinimized: true,
      });

      const state = manager.getTaskListState();
      expect(state.postId).toBe('task-post-123');
      expect(state.content).toBe('📋 Tasks (1/2)');
      expect(state.isCompleted).toBe(false);
      expect(state.isMinimized).toBe(true);
    });

    it('hydrates interactive state with pending questions', () => {
      manager.hydrateInteractiveState({
        pendingQuestionSet: {
          toolUseId: 'tool-123',
          currentIndex: 1,
          currentPostId: 'question-post-456',
          questions: [
            {
              header: 'Q1',
              question: 'First?',
              options: [{ label: 'A', description: 'desc' }],
              answer: 'A',
            },
            {
              header: 'Q2',
              question: 'Second?',
              options: [{ label: 'B', description: 'desc' }],
              answer: null,
            },
          ],
        },
        pendingApproval: null,
      });

      expect(manager.hasPendingQuestions()).toBe(true);
      expect(manager.hasPendingApproval()).toBe(false);

      const questionSet = manager.getPendingQuestionSet();
      expect(questionSet).not.toBeNull();
      expect(questionSet!.toolUseId).toBe('tool-123');
      expect(questionSet!.currentIndex).toBe(1);
    });

    it('hydrates interactive state with pending approval', () => {
      manager.hydrateInteractiveState({
        pendingQuestionSet: null,
        pendingApproval: {
          postId: 'approval-post-789',
          type: 'plan',
          toolUseId: 'tool-456',
        },
      });

      expect(manager.hasPendingQuestions()).toBe(false);
      expect(manager.hasPendingApproval()).toBe(true);

      const approval = manager.getPendingApproval();
      expect(approval).not.toBeNull();
      expect(approval!.postId).toBe('approval-post-789');
      expect(approval!.type).toBe('plan');
    });

    it('hydrates empty interactive state', () => {
      // First set some state
      manager.hydrateInteractiveState({
        pendingQuestionSet: {
          toolUseId: 'tool-123',
          currentIndex: 0,
          currentPostId: 'post-1',
          questions: [],
        },
        pendingApproval: null,
      });

      expect(manager.hasPendingQuestions()).toBe(true);

      // Now hydrate with empty state
      manager.hydrateInteractiveState({});

      expect(manager.hasPendingQuestions()).toBe(false);
      expect(manager.hasPendingApproval()).toBe(false);
    });
  });
});
