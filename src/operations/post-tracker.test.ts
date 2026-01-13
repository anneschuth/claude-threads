/**
 * Tests for PostTracker - Post registration and tracking
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { PostTracker, type PostType, type InteractionType } from './post-tracker.js';

describe('PostTracker', () => {
  let tracker: PostTracker;

  beforeEach(() => {
    tracker = new PostTracker();
  });

  // ---------------------------------------------------------------------------
  // Basic Registration
  // ---------------------------------------------------------------------------

  describe('register', () => {
    it('registers a post with minimal info', () => {
      tracker.register('post1', 'thread1', 'session1');

      const info = tracker.get('post1');
      expect(info).toBeDefined();
      expect(info!.postId).toBe('post1');
      expect(info!.threadId).toBe('thread1');
      expect(info!.sessionId).toBe('session1');
      expect(info!.type).toBe('content'); // default type
    });

    it('registers a post with type', () => {
      tracker.register('post1', 'thread1', 'session1', { type: 'task_list' });

      const info = tracker.get('post1');
      expect(info!.type).toBe('task_list');
    });

    it('registers a post with interaction type', () => {
      tracker.register('post1', 'thread1', 'session1', {
        type: 'question',
        interactionType: 'question',
        toolUseId: 'tool123',
      });

      const info = tracker.get('post1');
      expect(info!.type).toBe('question');
      expect(info!.interactionType).toBe('question');
      expect(info!.toolUseId).toBe('tool123');
    });

    it('registers a post with metadata', () => {
      tracker.register('post1', 'thread1', 'session1', {
        metadata: { questionIndex: 0, totalQuestions: 3 },
      });

      const info = tracker.get('post1');
      expect(info!.metadata).toEqual({ questionIndex: 0, totalQuestions: 3 });
    });

    it('sets createdAt timestamp', () => {
      const before = Date.now();
      tracker.register('post1', 'thread1', 'session1');
      const after = Date.now();

      const info = tracker.get('post1');
      expect(info!.createdAt).toBeGreaterThanOrEqual(before);
      expect(info!.createdAt).toBeLessThanOrEqual(after);
    });

    it('overwrites existing post with same ID', () => {
      tracker.register('post1', 'thread1', 'session1', { type: 'content' });
      tracker.register('post1', 'thread2', 'session2', { type: 'task_list' });

      const info = tracker.get('post1');
      expect(info!.threadId).toBe('thread2');
      expect(info!.sessionId).toBe('session2');
      expect(info!.type).toBe('task_list');
    });
  });

  // ---------------------------------------------------------------------------
  // Unregister
  // ---------------------------------------------------------------------------

  describe('unregister', () => {
    it('removes a registered post', () => {
      tracker.register('post1', 'thread1', 'session1');
      const removed = tracker.unregister('post1');

      expect(removed).toBe(true);
      expect(tracker.get('post1')).toBeUndefined();
    });

    it('returns false for non-existent post', () => {
      const removed = tracker.unregister('nonexistent');
      expect(removed).toBe(false);
    });

    it('updates session index when removing', () => {
      tracker.register('post1', 'thread1', 'session1');
      tracker.register('post2', 'thread1', 'session1');
      tracker.unregister('post1');

      const posts = tracker.getPostsForSession('session1');
      expect(posts.length).toBe(1);
      expect(posts[0].postId).toBe('post2');
    });

    it('removes empty session index entry', () => {
      tracker.register('post1', 'thread1', 'session1');
      tracker.unregister('post1');

      const posts = tracker.getPostsForSession('session1');
      expect(posts.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Get and Query
  // ---------------------------------------------------------------------------

  describe('get', () => {
    it('returns undefined for non-existent post', () => {
      expect(tracker.get('nonexistent')).toBeUndefined();
    });

    it('returns post info for registered post', () => {
      tracker.register('post1', 'thread1', 'session1');
      const info = tracker.get('post1');
      expect(info).toBeDefined();
      expect(info!.postId).toBe('post1');
    });
  });

  describe('getThreadId', () => {
    it('returns thread ID for registered post', () => {
      tracker.register('post1', 'thread1', 'session1');
      expect(tracker.getThreadId('post1')).toBe('thread1');
    });

    it('returns undefined for non-existent post', () => {
      expect(tracker.getThreadId('nonexistent')).toBeUndefined();
    });
  });

  describe('findSessionForPost', () => {
    it('returns session ID for registered post', () => {
      tracker.register('post1', 'thread1', 'session1');
      expect(tracker.findSessionForPost('post1')).toBe('session1');
    });

    it('returns undefined for non-existent post', () => {
      expect(tracker.findSessionForPost('nonexistent')).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Session Queries
  // ---------------------------------------------------------------------------

  describe('getPostsForSession', () => {
    it('returns empty array for non-existent session', () => {
      expect(tracker.getPostsForSession('nonexistent')).toEqual([]);
    });

    it('returns all posts for a session', () => {
      tracker.register('post1', 'thread1', 'session1');
      tracker.register('post2', 'thread1', 'session1');
      tracker.register('post3', 'thread2', 'session2'); // different session

      const posts = tracker.getPostsForSession('session1');
      expect(posts.length).toBe(2);
      expect(posts.map(p => p.postId).sort()).toEqual(['post1', 'post2']);
    });

    it('does not include posts from other sessions', () => {
      tracker.register('post1', 'thread1', 'session1');
      tracker.register('post2', 'thread2', 'session2');

      const posts = tracker.getPostsForSession('session1');
      expect(posts.length).toBe(1);
      expect(posts[0].postId).toBe('post1');
    });
  });

  describe('getPostsByType', () => {
    it('returns empty array for non-existent session', () => {
      expect(tracker.getPostsByType('nonexistent', 'content')).toEqual([]);
    });

    it('filters posts by type', () => {
      tracker.register('post1', 'thread1', 'session1', { type: 'content' });
      tracker.register('post2', 'thread1', 'session1', { type: 'task_list' });
      tracker.register('post3', 'thread1', 'session1', { type: 'content' });

      const contentPosts = tracker.getPostsByType('session1', 'content');
      expect(contentPosts.length).toBe(2);

      const taskPosts = tracker.getPostsByType('session1', 'task_list');
      expect(taskPosts.length).toBe(1);
      expect(taskPosts[0].postId).toBe('post2');
    });

    it('returns empty array when no posts match type', () => {
      tracker.register('post1', 'thread1', 'session1', { type: 'content' });
      const posts = tracker.getPostsByType('session1', 'task_list');
      expect(posts).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Clear Operations
  // ---------------------------------------------------------------------------

  describe('clearSession', () => {
    it('removes all posts for a session', () => {
      tracker.register('post1', 'thread1', 'session1');
      tracker.register('post2', 'thread1', 'session1');
      tracker.register('post3', 'thread2', 'session2');

      const count = tracker.clearSession('session1');
      expect(count).toBe(2);
      expect(tracker.get('post1')).toBeUndefined();
      expect(tracker.get('post2')).toBeUndefined();
      expect(tracker.get('post3')).toBeDefined();
    });

    it('returns 0 for non-existent session', () => {
      const count = tracker.clearSession('nonexistent');
      expect(count).toBe(0);
    });
  });

  describe('clear', () => {
    it('removes all posts', () => {
      tracker.register('post1', 'thread1', 'session1');
      tracker.register('post2', 'thread2', 'session2');

      tracker.clear();

      expect(tracker.get('post1')).toBeUndefined();
      expect(tracker.get('post2')).toBeUndefined();
      expect(tracker.size()).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Size and Has
  // ---------------------------------------------------------------------------

  describe('size', () => {
    it('returns 0 for empty tracker', () => {
      expect(tracker.size()).toBe(0);
    });

    it('returns correct count', () => {
      tracker.register('post1', 'thread1', 'session1');
      expect(tracker.size()).toBe(1);

      tracker.register('post2', 'thread1', 'session1');
      expect(tracker.size()).toBe(2);

      tracker.unregister('post1');
      expect(tracker.size()).toBe(1);
    });
  });

  describe('has', () => {
    it('returns false for non-existent post', () => {
      expect(tracker.has('nonexistent')).toBe(false);
    });

    it('returns true for registered post', () => {
      tracker.register('post1', 'thread1', 'session1');
      expect(tracker.has('post1')).toBe(true);
    });

    it('returns false after unregister', () => {
      tracker.register('post1', 'thread1', 'session1');
      tracker.unregister('post1');
      expect(tracker.has('post1')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Post Types
  // ---------------------------------------------------------------------------

  describe('post types', () => {
    const postTypes: PostType[] = [
      'content',
      'task_list',
      'session_header',
      'question',
      'plan_approval',
      'message_approval',
      'permission',
      'worktree_prompt',
      'context_prompt',
      'update_prompt',
      'subagent',
      'lifecycle',
      'compaction',
      'system',
      'bug_report',
    ];

    it('accepts all defined post types', () => {
      postTypes.forEach((type, i) => {
        tracker.register(`post${i}`, 'thread1', 'session1', { type });
        expect(tracker.get(`post${i}`)!.type).toBe(type);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Interaction Types
  // ---------------------------------------------------------------------------

  describe('interaction types', () => {
    const interactionTypes: InteractionType[] = [
      'question',
      'plan_approval',
      'action_approval',
      'message_approval',
      'worktree_existing',
      'worktree_failure',
      'worktree_suggest',
      'context_selection',
      'update_now',
      'toggle_minimize',
      'resume',
    ];

    it('accepts all defined interaction types', () => {
      interactionTypes.forEach((interactionType, i) => {
        tracker.register(`post${i}`, 'thread1', 'session1', {
          type: 'question',
          interactionType,
        });
        expect(tracker.get(`post${i}`)!.interactionType).toBe(interactionType);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Edge Cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles empty string IDs', () => {
      tracker.register('', '', '');
      expect(tracker.has('')).toBe(true);
      expect(tracker.get('')!.threadId).toBe('');
    });

    it('handles very long IDs', () => {
      const longId = 'x'.repeat(1000);
      tracker.register(longId, longId, longId);
      expect(tracker.has(longId)).toBe(true);
    });

    it('handles special characters in IDs', () => {
      const specialId = 'post:with/special\\chars@!#$%';
      tracker.register(specialId, 'thread', 'session');
      expect(tracker.has(specialId)).toBe(true);
    });

    it('handles multiple sessions with same thread ID', () => {
      // Different sessions can have the same thread ID (different platforms)
      tracker.register('post1', 'thread1', 'platform1:thread1');
      tracker.register('post2', 'thread1', 'platform2:thread1');

      expect(tracker.findSessionForPost('post1')).toBe('platform1:thread1');
      expect(tracker.findSessionForPost('post2')).toBe('platform2:thread1');
    });
  });
});
