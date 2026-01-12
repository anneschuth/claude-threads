/**
 * Tests for SessionRegistry
 *
 * Tests the session tracking, lookup, and persistence integration.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { SessionRegistry } from './registry.js';
import type { Session } from './types.js';
import type { SessionStore, PersistedSession } from '../persistence/session-store.js';

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Create a mock SessionStore for testing
 */
function createMockSessionStore(overrides?: Partial<SessionStore>): SessionStore {
  return {
    load: mock(() => new Map<string, PersistedSession>()),
    save: mock(() => {}),
    remove: mock(() => {}),
    softDelete: mock(() => {}),
    cleanStale: mock(() => []),
    cleanHistory: mock(() => 0),
    getHistory: mock(() => []),
    clear: mock(() => {}),
    saveStickyPostId: mock(() => {}),
    getStickyPostIds: mock(() => new Map()),
    removeStickyPostId: mock(() => {}),
    getPlatformEnabledState: mock(() => new Map()),
    isPlatformEnabled: mock(() => true),
    setPlatformEnabled: mock(() => {}),
    findByThread: mock(() => undefined),
    findByPostId: mock(() => undefined),
    ...overrides,
  } as unknown as SessionStore;
}

/**
 * Create a minimal mock Session for testing
 */
function createMockSession(overrides?: Partial<Session>): Session {
  const defaultPlatformId = 'test-platform';
  const defaultThreadId = 'thread-123';
  const sessionId = `${overrides?.platformId ?? defaultPlatformId}:${overrides?.threadId ?? defaultThreadId}`;

  return {
    platformId: defaultPlatformId,
    threadId: defaultThreadId,
    sessionId,
    claudeSessionId: 'claude-session-1',
    startedBy: 'testuser',
    startedAt: new Date(),
    lastActivityAt: new Date(),
    sessionNumber: 1,
    platform: {} as any,
    workingDir: '/test',
    claude: {} as any,
    planApproved: false,
    sessionAllowedUsers: new Set(['testuser']),
    forceInteractivePermissions: false,
    sessionStartPostId: null,
    tasksPostId: null,
    lastTasksContent: null,
    tasksCompleted: false,
    tasksMinimized: false,
    timers: { updateTimer: null, typingTimer: null, statusBarTimer: null },
    lifecycle: { state: 'active', resumeFailCount: 0, hasClaudeResponded: false },
    timeoutWarningPosted: false,
    inProgressTaskStart: null,
    activeToolStarts: new Map(),
    messageCount: 0,
    isProcessing: false,
    recentEvents: [],
    ...overrides,
  } as Session;
}

// =============================================================================
// Tests
// =============================================================================

describe('SessionRegistry', () => {
  let registry: SessionRegistry;
  let mockStore: SessionStore;

  beforeEach(() => {
    mockStore = createMockSessionStore();
    registry = new SessionRegistry(mockStore);
  });

  // ---------------------------------------------------------------------------
  // Session ID Generation
  // ---------------------------------------------------------------------------

  describe('getSessionId', () => {
    it('generates composite ID from platform and thread', () => {
      const sessionId = registry.getSessionId('platform-1', 'thread-abc');
      expect(sessionId).toBe('platform-1:thread-abc');
    });

    it('handles special characters in IDs', () => {
      const sessionId = registry.getSessionId('plat:form', 'thread:id');
      expect(sessionId).toBe('plat:form:thread:id');
    });
  });

  describe('parseSessionId', () => {
    it('parses valid composite ID', () => {
      const result = registry.parseSessionId('platform-1:thread-abc');

      expect(result).not.toBeNull();
      expect(result!.platformId).toBe('platform-1');
      expect(result!.threadId).toBe('thread-abc');
    });

    it('returns null for invalid ID (no colon)', () => {
      const result = registry.parseSessionId('invalid-no-colon');
      expect(result).toBeNull();
    });

    it('handles ID with multiple colons', () => {
      const result = registry.parseSessionId('platform:thread:with:colons');

      expect(result).not.toBeNull();
      expect(result!.platformId).toBe('platform');
      expect(result!.threadId).toBe('thread:with:colons');
    });

    it('handles ID with colon at beginning', () => {
      const result = registry.parseSessionId(':thread-only');

      expect(result).not.toBeNull();
      expect(result!.platformId).toBe('');
      expect(result!.threadId).toBe('thread-only');
    });
  });

  // ---------------------------------------------------------------------------
  // Session Registration
  // ---------------------------------------------------------------------------

  describe('register', () => {
    it('registers a session', () => {
      const session = createMockSession();
      registry.register(session);

      expect(registry.size).toBe(1);
      expect(registry.get(session.sessionId)).toBe(session);
    });

    it('can register multiple sessions', () => {
      const session1 = createMockSession({ platformId: 'p1', threadId: 't1' });
      const session2 = createMockSession({ platformId: 'p2', threadId: 't2' });

      registry.register(session1);
      registry.register(session2);

      expect(registry.size).toBe(2);
    });

    it('overwrites existing session with same ID', () => {
      const session1 = createMockSession({ startedBy: 'user1' });
      const session2 = createMockSession({ startedBy: 'user2' });

      registry.register(session1);
      registry.register(session2);

      expect(registry.size).toBe(1);
      const retrieved = registry.get(session1.sessionId);
      expect(retrieved?.startedBy).toBe('user2');
    });
  });

  describe('unregister', () => {
    it('removes a session by ID', () => {
      const session = createMockSession();
      registry.register(session);

      registry.unregister(session.sessionId);

      expect(registry.size).toBe(0);
      expect(registry.get(session.sessionId)).toBeUndefined();
    });

    it('does nothing for non-existent session', () => {
      registry.unregister('nonexistent:session');
      expect(registry.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Session Lookup
  // ---------------------------------------------------------------------------

  describe('find', () => {
    it('finds session by platform and thread ID', () => {
      const session = createMockSession();
      registry.register(session);

      const found = registry.find('test-platform', 'thread-123');
      expect(found).toBe(session);
    });

    it('returns undefined for non-existent session', () => {
      const found = registry.find('nonexistent', 'thread');
      expect(found).toBeUndefined();
    });
  });

  describe('findByThreadId', () => {
    it('finds session by thread ID alone', () => {
      const session = createMockSession({ threadId: 'unique-thread' });
      registry.register(session);

      const found = registry.findByThreadId('unique-thread');
      expect(found).toBe(session);
    });

    it('returns undefined for non-existent thread', () => {
      const found = registry.findByThreadId('nonexistent');
      expect(found).toBeUndefined();
    });

    it('searches across multiple platforms', () => {
      const session1 = createMockSession({ platformId: 'p1', threadId: 't1' });
      const session2 = createMockSession({ platformId: 'p2', threadId: 't2' });

      registry.register(session1);
      registry.register(session2);

      expect(registry.findByThreadId('t1')).toBe(session1);
      expect(registry.findByThreadId('t2')).toBe(session2);
    });
  });

  describe('get', () => {
    it('retrieves session by composite ID', () => {
      const session = createMockSession();
      registry.register(session);

      const found = registry.get('test-platform:thread-123');
      expect(found).toBe(session);
    });

    it('returns undefined for non-existent ID', () => {
      const found = registry.get('nonexistent:id');
      expect(found).toBeUndefined();
    });
  });

  describe('has', () => {
    it('returns true for existing session', () => {
      const session = createMockSession();
      registry.register(session);

      expect(registry.has('test-platform', 'thread-123')).toBe(true);
    });

    it('returns false for non-existent session', () => {
      expect(registry.has('test-platform', 'thread-123')).toBe(false);
    });
  });

  describe('hasById', () => {
    it('returns true for existing session by composite ID', () => {
      const session = createMockSession();
      registry.register(session);

      expect(registry.hasById('test-platform:thread-123')).toBe(true);
    });

    it('returns false for non-existent ID', () => {
      expect(registry.hasById('nonexistent:id')).toBe(false);
    });
  });

  describe('isActiveThread', () => {
    it('returns true for thread with active session', () => {
      const session = createMockSession({ threadId: 'active-thread' });
      registry.register(session);

      expect(registry.isActiveThread('active-thread')).toBe(true);
    });

    it('returns false for thread without session', () => {
      expect(registry.isActiveThread('inactive-thread')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Post Index
  // ---------------------------------------------------------------------------

  describe('registerPost', () => {
    it('registers post to thread mapping', () => {
      registry.registerPost('post-1', 'thread-1');

      expect(registry.getThreadIdForPost('post-1')).toBe('thread-1');
    });

    it('can register multiple posts for same thread', () => {
      registry.registerPost('post-1', 'thread-1');
      registry.registerPost('post-2', 'thread-1');

      expect(registry.getThreadIdForPost('post-1')).toBe('thread-1');
      expect(registry.getThreadIdForPost('post-2')).toBe('thread-1');
    });
  });

  describe('unregisterPost', () => {
    it('removes post mapping', () => {
      registry.registerPost('post-1', 'thread-1');
      registry.unregisterPost('post-1');

      expect(registry.getThreadIdForPost('post-1')).toBeUndefined();
    });

    it('does nothing for non-existent post', () => {
      registry.unregisterPost('nonexistent');
      // Should not throw
    });
  });

  describe('getThreadIdForPost', () => {
    it('returns thread ID for registered post', () => {
      registry.registerPost('post-abc', 'thread-xyz');
      expect(registry.getThreadIdForPost('post-abc')).toBe('thread-xyz');
    });

    it('returns undefined for unknown post', () => {
      expect(registry.getThreadIdForPost('unknown')).toBeUndefined();
    });
  });

  describe('findByPost', () => {
    it('finds session by post ID', () => {
      const session = createMockSession({ threadId: 'thread-1' });
      registry.register(session);
      registry.registerPost('post-1', 'thread-1');

      const found = registry.findByPost('post-1');
      expect(found).toBe(session);
    });

    it('returns undefined for unknown post', () => {
      const found = registry.findByPost('unknown-post');
      expect(found).toBeUndefined();
    });

    it('returns undefined if thread has no active session', () => {
      registry.registerPost('post-1', 'thread-without-session');

      const found = registry.findByPost('post-1');
      expect(found).toBeUndefined();
    });
  });

  describe('clearPostsForThread', () => {
    it('clears all posts for a thread', () => {
      registry.registerPost('post-1', 'thread-1');
      registry.registerPost('post-2', 'thread-1');
      registry.registerPost('post-3', 'thread-2');

      registry.clearPostsForThread('thread-1');

      expect(registry.getThreadIdForPost('post-1')).toBeUndefined();
      expect(registry.getThreadIdForPost('post-2')).toBeUndefined();
      expect(registry.getThreadIdForPost('post-3')).toBe('thread-2');
    });

    it('does nothing for thread with no posts', () => {
      registry.clearPostsForThread('nonexistent');
      // Should not throw
    });
  });

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  describe('getAll', () => {
    it('returns empty array when no sessions', () => {
      expect(registry.getAll()).toEqual([]);
    });

    it('returns all registered sessions', () => {
      const session1 = createMockSession({ platformId: 'p1', threadId: 't1' });
      const session2 = createMockSession({ platformId: 'p2', threadId: 't2' });

      registry.register(session1);
      registry.register(session2);

      const all = registry.getAll();
      expect(all).toHaveLength(2);
      expect(all).toContain(session1);
      expect(all).toContain(session2);
    });
  });

  describe('getActiveThreadIds', () => {
    it('returns empty array when no sessions', () => {
      expect(registry.getActiveThreadIds()).toEqual([]);
    });

    it('returns all active thread IDs', () => {
      registry.register(createMockSession({ threadId: 'thread-a' }));
      registry.register(createMockSession({ platformId: 'p2', threadId: 'thread-b' }));

      const threadIds = registry.getActiveThreadIds();
      expect(threadIds).toHaveLength(2);
      expect(threadIds).toContain('thread-a');
      expect(threadIds).toContain('thread-b');
    });
  });

  describe('size', () => {
    it('returns 0 for empty registry', () => {
      expect(registry.size).toBe(0);
    });

    it('returns correct count', () => {
      registry.register(createMockSession({ threadId: 't1' }));
      registry.register(createMockSession({ platformId: 'p2', threadId: 't2' }));

      expect(registry.size).toBe(2);
    });
  });

  describe('getForPlatform', () => {
    it('returns empty array for platform with no sessions', () => {
      expect(registry.getForPlatform('nonexistent')).toEqual([]);
    });

    it('returns only sessions for specified platform', () => {
      const s1 = createMockSession({ platformId: 'platform-a', threadId: 't1' });
      const s2 = createMockSession({ platformId: 'platform-a', threadId: 't2' });
      const s3 = createMockSession({ platformId: 'platform-b', threadId: 't3' });

      registry.register(s1);
      registry.register(s2);
      registry.register(s3);

      const platformASessions = registry.getForPlatform('platform-a');
      expect(platformASessions).toHaveLength(2);
      expect(platformASessions).toContain(s1);
      expect(platformASessions).toContain(s2);
      expect(platformASessions).not.toContain(s3);
    });
  });

  // ---------------------------------------------------------------------------
  // Persistence Integration
  // ---------------------------------------------------------------------------

  describe('hasPaused', () => {
    it('delegates to session store findByThread', () => {
      const mockSession: PersistedSession = {
        platformId: 'test',
        threadId: 'thread-1',
        claudeSessionId: 'claude-1',
        startedBy: 'user',
        startedAt: new Date().toISOString(),
        sessionNumber: 1,
        workingDir: '/test',
        sessionAllowedUsers: [],
        forceInteractivePermissions: false,
        sessionStartPostId: null,
        tasksPostId: null,
        lastTasksContent: null,
        lastActivityAt: new Date().toISOString(),
        planApproved: false,
      };

      mockStore = createMockSessionStore({
        findByThread: mock(() => mockSession),
      });
      registry = new SessionRegistry(mockStore);

      expect(registry.hasPaused('test', 'thread-1')).toBe(true);
      expect(mockStore.findByThread).toHaveBeenCalledWith('test', 'thread-1');
    });

    it('returns false when no paused session', () => {
      expect(registry.hasPaused('test', 'thread-1')).toBe(false);
    });
  });

  describe('getPersisted', () => {
    it('returns persisted session from store', () => {
      const mockSession: PersistedSession = {
        platformId: 'test',
        threadId: 'thread-1',
        claudeSessionId: 'claude-1',
        startedBy: 'user',
        startedAt: new Date().toISOString(),
        sessionNumber: 1,
        workingDir: '/test',
        sessionAllowedUsers: [],
        forceInteractivePermissions: false,
        sessionStartPostId: null,
        tasksPostId: null,
        lastTasksContent: null,
        lastActivityAt: new Date().toISOString(),
        planApproved: false,
      };

      mockStore = createMockSessionStore({
        findByThread: mock(() => mockSession),
      });
      registry = new SessionRegistry(mockStore);

      const result = registry.getPersisted('test', 'thread-1');
      expect(result).toBe(mockSession);
    });

    it('returns undefined when no persisted session', () => {
      const result = registry.getPersisted('test', 'thread-1');
      expect(result).toBeUndefined();
    });
  });

  describe('getPersistedByThreadId', () => {
    it('searches all persisted sessions for thread ID', () => {
      const mockSession: PersistedSession = {
        platformId: 'platform-x',
        threadId: 'target-thread',
        claudeSessionId: 'claude-1',
        startedBy: 'user',
        startedAt: new Date().toISOString(),
        sessionNumber: 1,
        workingDir: '/test',
        sessionAllowedUsers: [],
        forceInteractivePermissions: false,
        sessionStartPostId: null,
        tasksPostId: null,
        lastTasksContent: null,
        lastActivityAt: new Date().toISOString(),
        planApproved: false,
      };

      const sessionsMap = new Map<string, PersistedSession>([
        ['platform-x:target-thread', mockSession],
      ]);

      mockStore = createMockSessionStore({
        load: mock(() => sessionsMap),
      });
      registry = new SessionRegistry(mockStore);

      const result = registry.getPersistedByThreadId('target-thread');
      expect(result).toBe(mockSession);
    });

    it('returns undefined when thread not found', () => {
      mockStore = createMockSessionStore({
        load: mock(() => new Map()),
      });
      registry = new SessionRegistry(mockStore);

      const result = registry.getPersistedByThreadId('nonexistent');
      expect(result).toBeUndefined();
    });
  });

  describe('getSessionStore', () => {
    it('returns the underlying session store', () => {
      expect(registry.getSessionStore()).toBe(mockStore);
    });
  });

  // ---------------------------------------------------------------------------
  // Clear
  // ---------------------------------------------------------------------------

  describe('clear', () => {
    it('removes all sessions and posts', () => {
      registry.register(createMockSession({ threadId: 't1' }));
      registry.register(createMockSession({ platformId: 'p2', threadId: 't2' }));
      registry.registerPost('post-1', 't1');
      registry.registerPost('post-2', 't2');

      registry.clear();

      expect(registry.size).toBe(0);
      expect(registry.getThreadIdForPost('post-1')).toBeUndefined();
      expect(registry.getThreadIdForPost('post-2')).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Public Utilities
  // ---------------------------------------------------------------------------

  describe('getSessions', () => {
    it('returns sessions map for context building', () => {
      const session = createMockSession();
      registry.register(session);

      const sessionsMap = registry.getSessions();
      expect(sessionsMap.get(session.sessionId)).toBe(session);
    });
  });

  describe('getPostIndex', () => {
    it('returns post index map for context building', () => {
      registry.registerPost('post-1', 'thread-1');

      const postIndex = registry.getPostIndex();
      expect(postIndex.get('post-1')).toBe('thread-1');
    });
  });
});
