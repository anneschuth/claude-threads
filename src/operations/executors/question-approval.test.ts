/**
 * Tests for QuestionApprovalExecutor
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { QuestionApprovalExecutor } from './question-approval.js';
import type { ExecutorContext } from './types.js';
import type { PlatformClient, PlatformFormatter, PlatformPost } from '../../platform/index.js';
import type { QuestionOp, ApprovalOp } from '../types.js';
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
  return {
    sessionId: 'test:session-1',
    threadId: 'thread-123',
    platform: platform ?? createMockPlatform(),
    postTracker: new PostTracker(),
    contentBreaker: new DefaultContentBreaker(),
  };
}

describe('QuestionApprovalExecutor', () => {
  let executor: QuestionApprovalExecutor;
  let ctx: ExecutorContext;
  let registeredPosts: Map<string, unknown>;
  let questionCompleted: { toolUseId: string; answers: Array<{ header: string; answer: string }> } | null;
  let approvalCompleted: { toolUseId: string; approved: boolean } | null;

  beforeEach(() => {
    registeredPosts = new Map();
    questionCompleted = null;
    approvalCompleted = null;

    // Create event emitter and subscribe to events
    const events = createMessageManagerEvents();
    events.on('question:complete', ({ toolUseId, answers }) => {
      questionCompleted = { toolUseId, answers };
    });
    events.on('approval:complete', ({ toolUseId, approved }) => {
      approvalCompleted = { toolUseId, approved };
    });

    executor = new QuestionApprovalExecutor({
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

  describe('Question Operations', () => {
    it('posts a question with reaction options', async () => {
      const op: QuestionOp = {
        type: 'question',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        toolUseId: 'tool-123',
        questions: [
          {
            header: 'Auth Method',
            question: 'Which authentication method should we use?',
            options: [
              { label: 'JWT', description: 'JSON Web Tokens' },
              { label: 'Session', description: 'Server-side sessions' },
            ],
            multiSelect: false,
          },
        ],
        currentIndex: 0,
      };

      await executor.execute(op, ctx);

      expect(executor.hasPendingQuestions()).toBe(true);
      expect(ctx.platform.createInteractivePost).toHaveBeenCalled();
      expect(registeredPosts.size).toBe(1);
    });

    it('handles multiple questions sequentially', async () => {
      const op: QuestionOp = {
        type: 'question',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        toolUseId: 'tool-123',
        questions: [
          {
            header: 'Question 1',
            question: 'First question?',
            options: [
              { label: 'Option A', description: 'First option' },
              { label: 'Option B', description: 'Second option' },
            ],
            multiSelect: false,
          },
          {
            header: 'Question 2',
            question: 'Second question?',
            options: [
              { label: 'Option C', description: 'Third option' },
              { label: 'Option D', description: 'Fourth option' },
            ],
            multiSelect: false,
          },
        ],
        currentIndex: 0,
      };

      await executor.execute(op, ctx);

      // Answer first question
      const state = executor.getPendingQuestionSet();
      expect(state).not.toBeNull();
      const postId1 = state!.currentPostId;
      expect(postId1).not.toBeNull();
      await executor.handleQuestionAnswer(postId1!, 0, ctx);

      // Should be on second question now
      const state2 = executor.getPendingQuestionSet();
      expect(state2).not.toBeNull();
      expect(state2!.currentIndex).toBe(1);

      // Answer second question
      const postId2 = state2!.currentPostId;
      expect(postId2).not.toBeNull();
      await executor.handleQuestionAnswer(postId2!, 1, ctx);

      // Questions should be complete
      expect(executor.hasPendingQuestions()).toBe(false);
      expect(questionCompleted).not.toBeNull();
      expect(questionCompleted?.answers).toHaveLength(2);
      expect(questionCompleted?.answers[0].header).toBe('Question 1');
      expect(questionCompleted?.answers[0].answer).toBe('Option A');
      expect(questionCompleted?.answers[1].header).toBe('Question 2');
      expect(questionCompleted?.answers[1].answer).toBe('Option D');
    });

    it('ignores invalid option index', async () => {
      const op: QuestionOp = {
        type: 'question',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        toolUseId: 'tool-123',
        questions: [
          {
            header: 'Test',
            question: 'Test question?',
            options: [
              { label: 'Option A', description: 'First' },
              { label: 'Option B', description: 'Second' },
            ],
            multiSelect: false,
          },
        ],
        currentIndex: 0,
      };

      await executor.execute(op, ctx);

      const state = executor.getPendingQuestionSet();
      expect(state).not.toBeNull();
      const postId = state!.currentPostId;
      expect(postId).not.toBeNull();

      // Invalid option index
      const handled = await executor.handleQuestionAnswer(postId!, 99, ctx);
      expect(handled).toBe(false);
      expect(executor.hasPendingQuestions()).toBe(true);
    });
  });

  describe('Approval Operations', () => {
    it('posts a plan approval prompt', async () => {
      const op: ApprovalOp = {
        type: 'approval',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        toolUseId: 'tool-123',
        approvalType: 'plan',
      };

      await executor.execute(op, ctx);

      expect(executor.hasPendingApproval()).toBe(true);
      expect(ctx.platform.createInteractivePost).toHaveBeenCalled();

      const approval = executor.getPendingApproval();
      expect(approval?.type).toBe('plan');
      expect(approval?.toolUseId).toBe('tool-123');
    });

    it('handles approval response', async () => {
      const op: ApprovalOp = {
        type: 'approval',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        toolUseId: 'tool-123',
        approvalType: 'plan',
      };

      await executor.execute(op, ctx);

      const approval = executor.getPendingApproval();
      expect(approval).not.toBeNull();
      const postId = approval!.postId;

      const handled = await executor.handleApprovalResponse(postId, true, ctx);

      expect(handled).toBe(true);
      expect(executor.hasPendingApproval()).toBe(false);
      expect(approvalCompleted).not.toBeNull();
      expect(approvalCompleted!.approved).toBe(true);
      expect(approvalCompleted!.toolUseId).toBe('tool-123');
    });

    it('handles rejection response', async () => {
      const op: ApprovalOp = {
        type: 'approval',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        toolUseId: 'tool-123',
        approvalType: 'plan',
      };

      await executor.execute(op, ctx);

      const approval = executor.getPendingApproval();
      expect(approval).not.toBeNull();
      const postId = approval!.postId;

      const handled = await executor.handleApprovalResponse(postId, false, ctx);

      expect(handled).toBe(true);
      expect(approvalCompleted).not.toBeNull();
      expect(approvalCompleted!.approved).toBe(false);
    });
  });

  describe('State Management', () => {
    it('resets state correctly', async () => {
      const questionOp: QuestionOp = {
        type: 'question',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        toolUseId: 'tool-123',
        questions: [
          {
            header: 'Test',
            question: 'Test?',
            options: [{ label: 'A', description: '' }],
            multiSelect: false,
          },
        ],
        currentIndex: 0,
      };

      await executor.execute(questionOp, ctx);
      expect(executor.hasPendingQuestions()).toBe(true);

      executor.reset();

      expect(executor.hasPendingQuestions()).toBe(false);
      expect(executor.hasPendingApproval()).toBe(false);
    });

    it('hydrates state from persisted data', () => {
      const persisted = {
        pendingQuestionSet: {
          toolUseId: 'tool-hydrate-123',
          currentIndex: 1,
          currentPostId: 'post-456',
          questions: [
            {
              header: 'Question 1',
              question: 'First question?',
              options: [
                { label: 'Option A', description: 'First option' },
                { label: 'Option B', description: 'Second option' },
              ],
              answer: 'Option A',
            },
          ],
        },
        pendingApproval: null,
      };

      executor.hydrateState(persisted);

      expect(executor.hasPendingQuestions()).toBe(true);
      expect(executor.hasPendingApproval()).toBe(false);

      const state = executor.getPendingQuestionSet();
      expect(state).not.toBeNull();
      expect(state!.toolUseId).toBe('tool-hydrate-123');
    });
  });
});
