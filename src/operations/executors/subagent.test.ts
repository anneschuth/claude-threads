/**
 * Tests for SubagentExecutor
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SubagentExecutor } from './subagent.js';
import { createTestContext } from '../../test-utils/executor-harness.js';
import type { ExecutorContext } from './types.js';
import type { PlatformPost } from '../../platform/index.js';
import type { SubagentOp } from '../types.js';

describe('SubagentExecutor', () => {
  let executor: SubagentExecutor;
  let ctx: ExecutorContext;
  let registeredPosts: Map<string, unknown>;

  beforeEach(() => {
    registeredPosts = new Map();

    const registerPost = (postId: string, options: unknown) => {
      registeredPosts.set(postId, options);
    };
    const updateLastMessage = (_post: PlatformPost) => {
      // Track last message if needed
    };

    // NOTE: SubagentExecutor no longer has onBumpTaskList callback.
    // This was removed to fix a race condition where both SubagentExecutor
    // and ContentExecutor were bumping the task list, causing duplicates.
    // Now only ContentExecutor handles task list bumping.
    executor = new SubagentExecutor({
      registerPost,
      updateLastMessage,
    });

    ctx = createTestContext(undefined, { registerPost, updateLastMessage });
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
      // NOTE: SubagentExecutor no longer bumps task list (removed to fix race condition)

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
