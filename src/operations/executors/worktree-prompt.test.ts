/**
 * Tests for WorktreePromptExecutor
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { WorktreePromptExecutor } from './worktree-prompt.js';
import { TypedEventEmitter } from '../message-manager-events.js';

describe('WorktreePromptExecutor', () => {
  let executor: WorktreePromptExecutor;
  let events: TypedEventEmitter;
  const registerPost = mock(() => {});
  const updateLastMessage = mock(() => {});

  beforeEach(() => {
    events = new TypedEventEmitter();
    executor = new WorktreePromptExecutor({
      registerPost,
      updateLastMessage,
      events,
    });
  });

  describe('initialization', () => {
    test('starts with no pending prompts', () => {
      expect(executor.hasPendingPrompt()).toBe(false);
      expect(executor.hasPendingInitialPrompt()).toBe(false);
      expect(executor.hasPendingFailurePrompt()).toBe(false);
    });

    test('starts with no queued data', () => {
      expect(executor.getQueuedData()).toBeNull();
    });

    test('starts with prompts enabled', () => {
      expect(executor.isPromptDisabled()).toBe(false);
    });
  });

  describe('state management', () => {
    test('sets and gets initial prompt', () => {
      const prompt = {
        postId: 'post-123',
        suggestions: ['feature/foo', 'bugfix/bar'],
      };

      executor.setPendingInitialPrompt(prompt);

      expect(executor.hasPendingPrompt()).toBe(true);
      expect(executor.hasPendingInitialPrompt()).toBe(true);
      expect(executor.getPendingInitialPrompt()).toEqual(prompt);
      expect(executor.getPromptPostId()).toBe('post-123');
    });

    test('sets and gets failure prompt', () => {
      const prompt = {
        postId: 'post-456',
        failedBranch: 'feature/failed',
        errorMessage: 'Branch already exists',
        username: 'testuser',
      };

      executor.setPendingFailurePrompt(prompt);

      expect(executor.hasPendingPrompt()).toBe(true);
      expect(executor.hasPendingFailurePrompt()).toBe(true);
      expect(executor.getPendingFailurePrompt()).toEqual(prompt);
      expect(executor.getPromptPostId()).toBe('post-456');
    });

    test('sets and gets queued data', () => {
      const data = {
        prompt: 'help me with this code',
        files: [{ id: 'file-1', name: 'screenshot.png' }],
      };

      executor.setQueuedData(data);

      expect(executor.getQueuedData()).toEqual(data);
    });

    test('sets response post ID in queued data', () => {
      executor.setQueuedData({ prompt: 'test' });
      executor.setResponsePostId('response-123');

      expect(executor.getQueuedData()?.responsePostId).toBe('response-123');
    });

    test('sets first prompt in queued data', () => {
      executor.setQueuedData({ prompt: 'test' });
      executor.setFirstPrompt('original message');

      expect(executor.getQueuedData()?.firstPrompt).toBe('original message');
    });

    test('clears pending prompts', () => {
      executor.setPendingInitialPrompt({ postId: 'p1', suggestions: [] });
      executor.setPendingFailurePrompt({
        postId: 'p2',
        failedBranch: 'b',
        errorMessage: 'e',
        username: 'u',
      });

      executor.clearPendingPrompts();

      expect(executor.hasPendingPrompt()).toBe(false);
      expect(executor.hasPendingInitialPrompt()).toBe(false);
      expect(executor.hasPendingFailurePrompt()).toBe(false);
    });

    test('clears queued data', () => {
      executor.setQueuedData({ prompt: 'test' });
      executor.clearQueuedData();

      expect(executor.getQueuedData()).toBeNull();
    });

    test('disables prompts', () => {
      executor.setPendingInitialPrompt({ postId: 'p1', suggestions: [] });
      executor.disablePrompts();

      expect(executor.isPromptDisabled()).toBe(true);
      expect(executor.hasPendingPrompt()).toBe(false);
    });
  });

  describe('reaction handling', () => {
    test('handles skip reaction on initial prompt', async () => {
      executor.setPendingInitialPrompt({
        postId: 'prompt-post',
        suggestions: ['branch-1', 'branch-2'],
      });
      executor.setQueuedData({ prompt: 'original request' });

      const eventReceived = new Promise<void>((resolve) => {
        events.on('worktree-initial-prompt:complete', (data) => {
          expect(data.decision).toEqual({ type: 'skip' });
          expect(data.queuedPrompt).toBe('original request');
          resolve();
        });
      });

      // Use emoji name '-1' (thumbsdown) for denial
      const handled = executor.handleReaction('prompt-post', '-1', 'added');
      expect(handled).toBe(true);
      expect(executor.hasPendingPrompt()).toBe(false);

      await eventReceived;
    });

    test('handles number emoji reaction for branch selection', async () => {
      executor.setPendingInitialPrompt({
        postId: 'prompt-post',
        suggestions: ['feature/one', 'feature/two', 'feature/three'],
      });

      const eventReceived = new Promise<void>((resolve) => {
        events.on('worktree-initial-prompt:complete', (data) => {
          expect(data.decision).toEqual({ type: 'branch_selected', branch: 'feature/two' });
          resolve();
        });
      });

      // Use emoji name 'two' for second option (index 1)
      const handled = executor.handleReaction('prompt-post', 'two', 'added');
      expect(handled).toBe(true);

      await eventReceived;
    });

    test('ignores reaction on wrong post', () => {
      executor.setPendingInitialPrompt({
        postId: 'prompt-post',
        suggestions: ['branch-1'],
      });

      const handled = executor.handleReaction('other-post', '-1', 'added');
      expect(handled).toBe(false);
      expect(executor.hasPendingPrompt()).toBe(true);
    });

    test('ignores removed reactions', () => {
      executor.setPendingInitialPrompt({
        postId: 'prompt-post',
        suggestions: ['branch-1'],
      });

      const handled = executor.handleReaction('prompt-post', '-1', 'removed');
      expect(handled).toBe(false);
      expect(executor.hasPendingPrompt()).toBe(true);
    });

    test('handles skip reaction on failure prompt', async () => {
      executor.setPendingFailurePrompt({
        postId: 'failure-post',
        failedBranch: 'feature/failed',
        errorMessage: 'error',
        username: 'user',
      });

      const eventReceived = new Promise<void>((resolve) => {
        events.on('worktree-initial-prompt:complete', (data) => {
          expect(data.decision).toEqual({ type: 'skip' });
          expect(data.failedBranch).toBe('feature/failed');
          resolve();
        });
      });

      // Use emoji name '-1' (thumbsdown) for denial
      const handled = executor.handleReaction('failure-post', '-1', 'added');
      expect(handled).toBe(true);

      await eventReceived;
    });

    test('ignores invalid number emoji for initial prompt', () => {
      executor.setPendingInitialPrompt({
        postId: 'prompt-post',
        suggestions: ['branch-1'],
      });

      // 'four' is out of bounds (only 1 suggestion at index 0)
      const handled = executor.handleReaction('prompt-post', 'four', 'added');
      expect(handled).toBe(false);
      expect(executor.hasPendingPrompt()).toBe(true);
    });
  });

  describe('hydration', () => {
    test('hydrates state from persistence', () => {
      const state = {
        pendingInitialPrompt: { postId: 'p1', suggestions: ['b1', 'b2'] },
        pendingFailurePrompt: null,
        queuedData: { prompt: 'test', files: [] },
        promptDisabled: false,
      };

      executor.hydrate(state);

      expect(executor.hasPendingInitialPrompt()).toBe(true);
      expect(executor.getPendingInitialPrompt()).toEqual(state.pendingInitialPrompt);
      expect(executor.getQueuedData()).toEqual(state.queuedData);
    });

    test('hydrates partial state', () => {
      executor.setPendingInitialPrompt({ postId: 'existing', suggestions: [] });

      executor.hydrate({ promptDisabled: true });

      expect(executor.isPromptDisabled()).toBe(true);
      expect(executor.hasPendingInitialPrompt()).toBe(true);
    });
  });

  describe('reset', () => {
    test('resets all state', () => {
      executor.setPendingInitialPrompt({ postId: 'p1', suggestions: [] });
      executor.setQueuedData({ prompt: 'test' });
      executor.disablePrompts();

      executor.reset();

      expect(executor.hasPendingPrompt()).toBe(false);
      expect(executor.getQueuedData()).toBeNull();
      expect(executor.isPromptDisabled()).toBe(false);
    });
  });

  describe('getState', () => {
    test('returns full state for persistence', () => {
      executor.setPendingInitialPrompt({ postId: 'p1', suggestions: ['b1'] });
      executor.setQueuedData({ prompt: 'test', files: [{ id: 'f1', name: 'file.png' }] });

      const state = executor.getState();

      expect(state.pendingInitialPrompt).toEqual({ postId: 'p1', suggestions: ['b1'] });
      expect(state.queuedData).toEqual({ prompt: 'test', files: [{ id: 'f1', name: 'file.png' }] });
      expect(state.pendingFailurePrompt).toBeNull();
      expect(state.promptDisabled).toBe(false);
    });
  });
});
