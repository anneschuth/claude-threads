/**
 * Tests for MessageManager
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { MessageManager } from './message-manager.js';
import type { PlatformClient, PlatformFormatter, PlatformPost } from '../platform/index.js';
import type { Session } from '../session/types.js';
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

// Create mock session for MessageManager
function createMockSession(platform: PlatformClient): Session {
  return {
    sessionId: 'test:session-1',
    platformId: 'test',
    threadId: 'thread-123',
    platform,
    claude: {
      isRunning: mock(() => true),
      sendMessage: mock(() => {}),
      on: mock(() => {}),
      kill: mock(() => Promise.resolve()),
      interrupt: mock(() => true),
    },
    claudeSessionId: 'claude-session-1',
    startedBy: 'testuser',
    startedAt: new Date(),
    lastActivityAt: new Date(),
    sessionNumber: 1,
    workingDir: '/test/working/dir',
    planApproved: false,
    sessionAllowedUsers: new Set(['testuser']),
    forceInteractivePermissions: false,
    sessionStartPostId: null,
    tasksPostId: null,
    lastTasksContent: null,
    tasksCompleted: false,
    tasksMinimized: false,
    timers: { updateTimer: undefined, typingTimer: undefined, idleTimer: undefined },
    lifecycle: { state: 'active', resumeFailCount: 0, hasClaudeResponded: false },
    timeoutWarningPosted: false,
    inProgressTaskStart: null,
    activeToolStarts: new Map(),
    messageCount: 0,
    isProcessing: false,
    recentEvents: [],
  } as unknown as Session;
}

describe('MessageManager', () => {
  let manager: MessageManager;
  let platform: PlatformClient;
  let session: Session;
  let postTracker: PostTracker;
  let registeredPosts: Map<string, unknown>;
  let _lastMessage: PlatformPost | null;
  let _questionCompleted: { toolUseId: string; answers: Array<{ header: string; answer: string }> } | null;
  let _approvalCompleted: { toolUseId: string; approved: boolean } | null;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createMockSession(platform);
    postTracker = new PostTracker();
    registeredPosts = new Map();
    _lastMessage = null;
    _questionCompleted = null;
    _approvalCompleted = null;

    manager = new MessageManager({
      session,
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

  describe('Worktree Path Shortening', () => {
    it('shortens file paths in tool output when worktree info is set', async () => {
      // Create a new manager with worktree info
      const worktreePath = '/home/testuser/.claude-threads/worktrees/testuser-myrepo--feature-branch-abc12345';
      const newPostTracker = new PostTracker();
      const managerWithWorktree = new MessageManager({
        session,
        platform,
        postTracker: newPostTracker,
        sessionId: 'test:session-wt',
        threadId: 'thread-wt',
        worktreePath,
        worktreeBranch: 'feature/my-branch',
        registerPost: () => {},
        updateLastMessage: () => {},
      });

      // Send a Read tool_use event with a file path in the worktree
      const event = {
        type: 'tool_use' as const,
        tool_use: {
          id: 'tool-read-1',
          name: 'Read',
          input: {
            file_path: `${worktreePath}/src/index.ts`,
          },
        },
      };

      await managerWithWorktree.handleEvent(event);

      // Flush to trigger content creation
      await managerWithWorktree.flush();

      // Check the post content contains shortened path
      const postContent = managerWithWorktree.getCurrentPostContent();
      expect(postContent).toContain('[feature/my-branch]');
      expect(postContent).not.toContain('testuser-myrepo--feature-branch');
    });

    it('shortens paths after setWorktreeInfo is called', async () => {
      // Create a manager WITHOUT worktree info initially
      const worktreePath = '/home/testuser/.claude-threads/worktrees/testuser-myrepo--feature-branch-abc12345';
      const newPostTracker = new PostTracker();
      const managerNoWorktree = new MessageManager({
        session,
        platform,
        postTracker: newPostTracker,
        sessionId: 'test:session-nwt',
        threadId: 'thread-nwt',
        // NO worktreePath or worktreeBranch
        registerPost: () => {},
        updateLastMessage: () => {},
      });

      // Set worktree info dynamically (simulates joining a worktree mid-session)
      managerNoWorktree.setWorktreeInfo(worktreePath, 'feature/my-branch');

      // Send a Read tool_use event with a file path in the worktree
      const event = {
        type: 'tool_use' as const,
        tool_use: {
          id: 'tool-read-dynamic',
          name: 'Read',
          input: {
            file_path: `${worktreePath}/src/index.ts`,
          },
        },
      };

      await managerNoWorktree.handleEvent(event);
      await managerNoWorktree.flush();

      // Check the post content contains shortened path
      const postContent = managerNoWorktree.getCurrentPostContent();
      expect(postContent).toContain('[feature/my-branch]');
      expect(postContent).not.toContain('testuser-myrepo--feature-branch');
    });

    it('uses ~ fallback when worktree info is not set', async () => {
      // Use the home dir that will be used for ~ substitution
      const home = process.env.HOME || '/home/user';
      const filePath = `${home}/.claude-threads/worktrees/some-repo--some-branch/src/index.ts`;

      // The default manager has no worktree info
      const event = {
        type: 'tool_use' as const,
        tool_use: {
          id: 'tool-read-2',
          name: 'Read',
          input: {
            file_path: filePath,
          },
        },
      };

      await manager.handleEvent(event);
      await manager.flush();

      // Should use ~ fallback instead of [branch]
      const postContent = manager.getCurrentPostContent();
      expect(postContent).toContain('~/.claude-threads');
      expect(postContent).not.toContain('[');
    });
  });

  describe('User Message Flow', () => {
    it('creates a new post after user message instead of updating existing post', async () => {
      // 1. Claude sends initial response (creates post_1)
      const event1 = {
        type: 'assistant' as const,
        message: {
          content: [{ type: 'text', text: 'First response from Claude' }],
        },
      };
      await manager.handleEvent(event1);
      await manager.flush();

      expect(platform.createPost).toHaveBeenCalledTimes(1);
      const firstPostContent = manager.getCurrentPostContent();
      expect(firstPostContent).toContain('First response');

      // 2. User sends a follow-up message
      await manager.handleUserMessage('User follow-up question', undefined, 'testuser');

      // 3. Claude responds again - should create NEW post, not update post_1
      const event2 = {
        type: 'assistant' as const,
        message: {
          content: [{ type: 'text', text: 'Second response from Claude' }],
        },
      };
      await manager.handleEvent(event2);
      await manager.flush();

      // Should have created 2 posts total (not updated the first one)
      expect(platform.createPost).toHaveBeenCalledTimes(2);
      const secondPostContent = manager.getCurrentPostContent();
      expect(secondPostContent).toContain('Second response');
      expect(secondPostContent).not.toContain('First response');
    });

    it('closeCurrentPost signals that next content goes to a new post', async () => {
      // 1. Create initial content in a post
      const event1 = {
        type: 'assistant' as const,
        message: {
          content: [{ type: 'text', text: 'Initial content' }],
        },
      };
      await manager.handleEvent(event1);
      await manager.flush();

      expect(platform.createPost).toHaveBeenCalledTimes(1);

      // 2. Close the current post (flushes + signals completion)
      await manager.closeCurrentPost();

      // 3. Next content should go to a NEW post
      const event2 = {
        type: 'assistant' as const,
        message: {
          content: [{ type: 'text', text: 'New content after close' }],
        },
      };
      await manager.handleEvent(event2);
      await manager.flush();

      // Should have created 2 posts, not updated the first
      expect(platform.createPost).toHaveBeenCalledTimes(2);
    });

    it('prepareForUserMessage flushes pending content and closes current post', async () => {
      // 1. Accumulate some content (but don't flush yet)
      const event = {
        type: 'assistant' as const,
        message: {
          content: [{ type: 'text', text: 'Pending content' }],
        },
      };
      await manager.handleEvent(event);

      // Content is pending, no post created yet
      expect(platform.createPost).toHaveBeenCalledTimes(0);

      // 2. Prepare for user message (should flush + close)
      await manager.prepareForUserMessage();

      // Should have flushed the pending content
      expect(platform.createPost).toHaveBeenCalledTimes(1);

      // 3. Next content should go to a new post
      const event2 = {
        type: 'assistant' as const,
        message: {
          content: [{ type: 'text', text: 'After user message' }],
        },
      };
      await manager.handleEvent(event2);
      await manager.flush();

      // Should have created 2 posts
      expect(platform.createPost).toHaveBeenCalledTimes(2);
    });
  });
});
