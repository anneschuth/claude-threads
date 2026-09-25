/**
 * Tests for QuestionApprovalExecutor
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { QuestionApprovalExecutor } from './question-approval.js';
import { createTestContext } from '../../test-utils/executor-harness.js';
import type { ExecutorContext } from './types.js';
import type { PlatformPost } from '../../platform/index.js';
import type { QuestionOp, ApprovalOp } from '../types.js';
import { createMessageManagerEvents } from '../message-manager-events.js';

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

    const registerPost = (postId: string, options: unknown) => {
      registeredPosts.set(postId, options);
    };
    const updateLastMessage = (_post: PlatformPost) => {
      // Track last message if needed
    };

    executor = new QuestionApprovalExecutor({
      registerPost,
      updateLastMessage,
      events,
    });

    ctx = createTestContext(undefined, { registerPost, updateLastMessage });
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

  // ---------------------------------------------------------------------------
  // Regression: a reaction that arrives while the option emojis are still
  // being added.
  //
  // The question/plan post is created first and its 1️⃣/2️⃣ (or 👍/👎) options
  // are added one API round trip at a time. Throughout that window the post is
  // already visible and reactable. The executor used to record the post id
  // only AFTER those adds finished, so a user who answered inside the window
  // hit `currentPostId === null` / `pendingApproval === null`, the reaction was
  // discarded, and a bridged AskUserQuestion / ExitPlanMode stayed blocked
  // until MCP_TOOL_TIMEOUT — the user's answer silently lost.
  // ---------------------------------------------------------------------------
  describe('reaction during the option window', () => {
    it('accepts a question answer that lands before the option reactions finish', async () => {
      const op: QuestionOp = {
        type: 'question',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        toolUseId: 'tool-race-1',
        questions: [
          {
            header: 'Approach',
            question: 'Which approach would you prefer?',
            options: [
              { label: 'Option A', description: 'First approach' },
              { label: 'Option B', description: 'Second approach' },
            ],
            multiSelect: false,
          },
        ],
        currentIndex: 0,
      };

      // React as soon as the post exists — i.e. before execute() resolves,
      // while the option emojis are still being added.
      const reactionResults: boolean[] = [];
      const racingCtx: ExecutorContext = {
        ...ctx,
        // Forward the executor's own onPostCreated (that is where it claims
        // currentPostId), then react in the same window.
        createInteractivePost: async (content, reactions, options, onPostCreated) =>
          ctx.createInteractivePost(content, reactions, options, (created) => {
            onPostCreated?.(created);
            void executor
              .handleReaction(created.id, 'one', 'alice', 'added', racingCtx)
              .then((handled) => { reactionResults.push(handled); });
          }),
      };

      await executor.execute(op, racingCtx);
      // Let the racing reaction settle.
      await new Promise((r) => setTimeout(r, 10));

      expect(reactionResults).toEqual([true]);
      expect(questionCompleted).not.toBeNull();
      expect(questionCompleted!.answers).toEqual([{ header: 'Approach', answer: 'Option A' }]);
      // The answered set must stay cleared — a post-hoc assignment must not
      // re-open the question the user already answered.
      expect(executor.hasPendingQuestions()).toBe(false);
    });

    it('accepts a plan approval that lands before the option reactions finish', async () => {
      const op: ApprovalOp = {
        type: 'approval',
        sessionId: 'test:session-1',
        timestamp: Date.now(),
        toolUseId: 'tool-race-2',
        approvalType: 'plan',
      };

      const reactionResults: boolean[] = [];
      const racingCtx: ExecutorContext = {
        ...ctx,
        createInteractivePost: async (content, reactions, options, onPostCreated) =>
          ctx.createInteractivePost(content, reactions, options, (created) => {
            onPostCreated?.(created);
            void executor
              .handleReaction(created.id, '+1', 'alice', 'added', racingCtx)
              .then((handled) => { reactionResults.push(handled); });
          }),
      };

      await executor.execute(op, racingCtx);
      await new Promise((r) => setTimeout(r, 10));

      expect(reactionResults).toEqual([true]);
      expect(approvalCompleted).not.toBeNull();
      expect(approvalCompleted!.approved).toBe(true);
      // Must not be re-armed after the decision was consumed.
      expect(executor.hasPendingApproval()).toBe(false);
    });
  });
});
