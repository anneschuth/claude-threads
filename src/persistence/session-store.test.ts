import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore, PersistedSession } from './session-store.js';

describe('SessionStore', () => {
  let store: SessionStore;

  // Helper to create a test session
  function createTestSession(overrides: Partial<PersistedSession> = {}): PersistedSession {
    return {
      platformId: 'test-platform',
      threadId: 'thread-123',
      claudeSessionId: 'uuid-456',
      startedBy: 'testuser',
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      sessionNumber: 1,
      workingDir: '/tmp/test',
      planApproved: false,
      sessionAllowedUsers: ['testuser'],
      forceInteractivePermissions: false,
      sessionStartPostId: 'post-789',
      tasksPostId: null,
      lastTasksContent: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    store = new SessionStore();
    store.clear(); // Start with clean state
  });

  afterEach(() => {
    store.clear();
  });

  describe('save and load', () => {
    it('saves and loads a session', () => {
      const session = createTestSession();
      const sessionId = `${session.platformId}:${session.threadId}`;

      store.save(sessionId, session);
      const loaded = store.load();

      expect(loaded.size).toBe(1);
      expect(loaded.get(sessionId)).toEqual(session);
    });

    it('saves multiple sessions', () => {
      const session1 = createTestSession({ threadId: 'thread-1' });
      const session2 = createTestSession({ threadId: 'thread-2' });

      store.save('test-platform:thread-1', session1);
      store.save('test-platform:thread-2', session2);

      const loaded = store.load();
      expect(loaded.size).toBe(2);
    });
  });

  describe('remove', () => {
    it('removes a session', () => {
      const session = createTestSession();
      const sessionId = `${session.platformId}:${session.threadId}`;

      store.save(sessionId, session);
      expect(store.load().size).toBe(1);

      store.remove(sessionId);
      expect(store.load().size).toBe(0);
    });
  });

  describe('findByThread', () => {
    it('finds a session by platform and thread ID', () => {
      const session = createTestSession({
        platformId: 'mattermost-main',
        threadId: 'thread-abc',
      });
      store.save('mattermost-main:thread-abc', session);

      const found = store.findByThread('mattermost-main', 'thread-abc');
      expect(found).toEqual(session);
    });

    it('returns undefined for non-existent session', () => {
      const found = store.findByThread('nonexistent', 'thread-xyz');
      expect(found).toBeUndefined();
    });

    it('does not find session from different platform', () => {
      const session = createTestSession({
        platformId: 'mattermost-main',
        threadId: 'thread-abc',
      });
      store.save('mattermost-main:thread-abc', session);

      const found = store.findByThread('slack-main', 'thread-abc');
      expect(found).toBeUndefined();
    });
  });

  describe('findByPostId', () => {
    it('finds a session by timeoutPostId', () => {
      const session = createTestSession({
        platformId: 'mattermost-main',
        threadId: 'thread-abc',
        timeoutPostId: 'timeout-post-123',
      });
      store.save('mattermost-main:thread-abc', session);

      const found = store.findByPostId('mattermost-main', 'timeout-post-123');
      expect(found).toEqual(session);
    });

    it('finds a session by sessionStartPostId', () => {
      const session = createTestSession({
        platformId: 'mattermost-main',
        threadId: 'thread-abc',
        sessionStartPostId: 'start-post-456',
      });
      store.save('mattermost-main:thread-abc', session);

      const found = store.findByPostId('mattermost-main', 'start-post-456');
      expect(found).toEqual(session);
    });

    it('returns undefined for non-existent post ID', () => {
      const session = createTestSession({
        platformId: 'mattermost-main',
        threadId: 'thread-abc',
        timeoutPostId: 'timeout-post-123',
      });
      store.save('mattermost-main:thread-abc', session);

      const found = store.findByPostId('mattermost-main', 'other-post-789');
      expect(found).toBeUndefined();
    });

    it('does not find session from different platform', () => {
      const session = createTestSession({
        platformId: 'mattermost-main',
        threadId: 'thread-abc',
        timeoutPostId: 'timeout-post-123',
      });
      store.save('mattermost-main:thread-abc', session);

      const found = store.findByPostId('slack-main', 'timeout-post-123');
      expect(found).toBeUndefined();
    });

    it('finds session when both timeoutPostId and sessionStartPostId are set', () => {
      const session = createTestSession({
        platformId: 'mattermost-main',
        threadId: 'thread-abc',
        sessionStartPostId: 'start-post-456',
        timeoutPostId: 'timeout-post-123',
      });
      store.save('mattermost-main:thread-abc', session);

      // Should find by either
      expect(store.findByPostId('mattermost-main', 'timeout-post-123')).toEqual(session);
      expect(store.findByPostId('mattermost-main', 'start-post-456')).toEqual(session);
    });
  });

  describe('cleanStale', () => {
    it('removes sessions older than maxAgeMs', () => {
      const oldSession = createTestSession({
        threadId: 'old-thread',
        lastActivityAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
      });
      const newSession = createTestSession({
        threadId: 'new-thread',
        lastActivityAt: new Date().toISOString(),
      });

      store.save('test-platform:old-thread', oldSession);
      store.save('test-platform:new-thread', newSession);

      const staleIds = store.cleanStale(60 * 60 * 1000); // 1 hour

      expect(staleIds).toContain('test-platform:old-thread');
      expect(staleIds).not.toContain('test-platform:new-thread');
      expect(store.load().size).toBe(1);
    });
  });

  describe('clear', () => {
    it('removes all sessions', () => {
      store.save('test-platform:thread-1', createTestSession({ threadId: 'thread-1' }));
      store.save('test-platform:thread-2', createTestSession({ threadId: 'thread-2' }));

      expect(store.load().size).toBe(2);

      store.clear();

      expect(store.load().size).toBe(0);
    });
  });
});
