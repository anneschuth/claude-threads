/**
 * Tests for session/manager.ts - SessionManager
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { SessionManager } from './manager.js';
import type { PlatformClient, PlatformPost } from '../platform/index.js';
import { createMockFormatter } from '../test-utils/mock-formatter.js';
import { setLogHandler } from '../utils/logger.js';
import * as path from 'path';
import * as os from 'os';

// Create mock platform client
function createMockPlatform(platformId = 'test-platform') {
  const posts: Map<string, string> = new Map();
  let postIdCounter = 1;

  const mockPlatform: any = {
    platformId,
    platformType: 'mattermost',
    displayName: 'Test Platform',
    on: mock(() => mockPlatform),
    off: mock(() => mockPlatform),
    emit: mock(() => false),
    createPost: mock(async (message: string, threadId?: string): Promise<PlatformPost> => {
      const id = `post_${postIdCounter++}`;
      posts.set(id, message);
      return {
        id,
        platformId,
        channelId: 'channel1',
        userId: 'bot',
        message,
        rootId: threadId || '',
        createAt: Date.now(),
      };
    }),
    createInteractivePost: mock(async (message: string, _reactions: string[], threadId?: string): Promise<PlatformPost> => {
      const id = `post_${postIdCounter++}`;
      posts.set(id, message);
      return {
        id,
        platformId,
        channelId: 'channel1',
        userId: 'bot',
        message,
        rootId: threadId || '',
        createAt: Date.now(),
      };
    }),
    updatePost: mock(async (postId: string, message: string): Promise<PlatformPost> => {
      posts.set(postId, message);
      return {
        id: postId,
        platformId,
        channelId: 'channel1',
        userId: 'bot',
        message,
        rootId: '',
        createAt: Date.now(),
      };
    }),
    deletePost: mock(async (_postId: string): Promise<void> => {
      // No-op
    }),
    addReaction: mock(async (_postId: string, _emoji: string): Promise<void> => {}),
    removeReaction: mock(async (_postId: string, _emoji: string): Promise<void> => {}),
    pinPost: mock(async (_postId: string): Promise<void> => {}),
    unpinPost: mock(async (_postId: string): Promise<void> => {}),
    getPinnedPosts: mock(async (): Promise<string[]> => []),
    sendTyping: mock(() => {}),
    getFormatter: () => createMockFormatter(),
    isUserAllowed: mock((username: string) => username === 'admin' || username === 'allowed-user'),
    getBotUser: mock(async () => ({ id: 'bot-id', username: 'bot', displayName: 'Bot' })),
    disconnect: mock(() => {}),
    posts,
  };

  return mockPlatform as unknown as PlatformClient & { posts: Map<string, string> };
}

describe('SessionManager', () => {
  let manager: SessionManager;
  let platform: ReturnType<typeof createMockPlatform>;
  const testSessionsPath = path.join(os.tmpdir(), `test-sessions-${Date.now()}.json`);

  beforeEach(() => {
    platform = createMockPlatform();
    manager = new SessionManager('/test/dir', true, false, 'prompt', testSessionsPath);
    manager.addPlatform('test-platform', platform as unknown as PlatformClient);
  });

  describe('constructor', () => {
    test('creates instance with default options', () => {
      const m = new SessionManager('/test');
      expect(m).toBeDefined();
    });

    test('creates instance with all options', () => {
      const m = new SessionManager('/test', false, true, 'require', '/tmp/sessions.json');
      expect(m).toBeDefined();
    });
  });

  describe('addPlatform / removePlatform', () => {
    test('adds platform and registers event handlers', () => {
      const newPlatform = createMockPlatform('new-platform');
      manager.addPlatform('new-platform', newPlatform as unknown as PlatformClient);
      expect(newPlatform.on).toHaveBeenCalled();
    });

    test('removes platform', () => {
      manager.removePlatform('test-platform');
      // No error should be thrown
    });
  });

  describe('isSessionActive', () => {
    test('returns false when no sessions', () => {
      expect(manager.isSessionActive()).toBe(false);
    });
  });

  describe('isInSessionThread', () => {
    test('returns false for unknown thread', () => {
      expect(manager.isInSessionThread('unknown-thread')).toBe(false);
    });
  });

  describe('hasPausedSession', () => {
    test('returns false for unknown thread', () => {
      expect(manager.hasPausedSession('unknown-thread')).toBe(false);
    });
  });

  describe('getPersistedSession', () => {
    test('returns undefined for unknown thread', () => {
      expect(manager.getPersistedSession('unknown-thread')).toBeUndefined();
    });
  });

  describe('getActiveThreadIds', () => {
    test('returns empty array when no sessions', () => {
      expect(manager.getActiveThreadIds()).toEqual([]);
    });
  });

  describe('getSessionStartPostId', () => {
    test('returns undefined for unknown thread', () => {
      expect(manager.getSessionStartPostId('unknown-thread')).toBeUndefined();
    });
  });

  describe('isUserAllowedInSession', () => {
    test('returns false for unknown thread with unknown user', () => {
      expect(manager.isUserAllowedInSession('unknown-thread', 'random-user')).toBe(false);
    });
  });

  describe('hasPendingWorktreePrompt', () => {
    test('returns false for unknown thread', () => {
      expect(manager.hasPendingWorktreePrompt('unknown-thread')).toBe(false);
    });
  });

  describe('hasPendingContextPrompt', () => {
    test('returns false for unknown thread', () => {
      expect(manager.hasPendingContextPrompt('unknown-thread')).toBe(false);
    });
  });

  describe('isSessionInteractive', () => {
    test('returns false when skipPermissions is true', () => {
      // Manager was created with skipPermissions = true
      expect(manager.isSessionInteractive('unknown-thread')).toBe(false);
    });

    test('returns true when skipPermissions is false', () => {
      const m = new SessionManager('/test', false);
      expect(m.isSessionInteractive('any-thread')).toBe(true);
    });
  });

  describe('setSkipPermissions', () => {
    test('changes skipPermissions value', () => {
      manager.setSkipPermissions(false);
      // After setting to false, isSessionInteractive should return true
      expect(manager.isSessionInteractive('unknown-thread')).toBe(true);
    });
  });

  describe('setChromeEnabled', () => {
    test('changes chromeEnabled value', () => {
      manager.setChromeEnabled(true);
      // No direct getter, but should not throw
    });
  });

  describe('setShuttingDown', () => {
    test('sets shutting down flag', () => {
      manager.setShuttingDown();
      // No direct getter, but should not throw
    });
  });

  describe('session events', () => {
    test('emits session:add event', () => {
      const listener = mock(() => {});
      manager.on('session:add', listener);
      // Can't easily test without starting a session
    });

    test('emits session:update event', () => {
      const listener = mock(() => {});
      manager.on('session:update', listener);
      // Can't easily test without starting a session
    });

    test('emits session:remove event', () => {
      const listener = mock(() => {});
      manager.on('session:remove', listener);
      // Can't easily test without starting a session
    });
  });

  describe('killSession', () => {
    test('does nothing for unknown thread', async () => {
      await manager.killSession('unknown-thread');
      // Should not throw
    });
  });

  describe('killAllSessions', () => {
    test('does nothing when no sessions', () => {
      manager.killAllSessions();
      // Should not throw
    });
  });

  describe('cancelSession', () => {
    test('does nothing for unknown thread', async () => {
      await manager.cancelSession('unknown-thread', 'user');
      // Should not throw
    });
  });

  describe('interruptSession', () => {
    test('does nothing for unknown thread', async () => {
      await manager.interruptSession('unknown-thread', 'user');
      // Should not throw
    });
  });

  describe('changeDirectory', () => {
    test('does nothing for unknown thread', async () => {
      await manager.changeDirectory('unknown-thread', '/new/path', 'user');
      // Should not throw
    });
  });

  describe('inviteUser', () => {
    test('does nothing for unknown thread', async () => {
      await manager.inviteUser('unknown-thread', 'newuser', 'inviter');
      // Should not throw
    });
  });

  describe('kickUser', () => {
    test('does nothing for unknown thread', async () => {
      await manager.kickUser('unknown-thread', 'kickeduser', 'kicker');
      // Should not throw
    });
  });

  describe('enableInteractivePermissions', () => {
    test('does nothing for unknown thread', async () => {
      await manager.enableInteractivePermissions('unknown-thread', 'user');
      // Should not throw
    });
  });

  describe('requestMessageApproval', () => {
    test('does nothing for unknown thread', async () => {
      await manager.requestMessageApproval('unknown-thread', 'user', 'message');
      // Should not throw
    });
  });

  describe('sendFollowUp', () => {
    test('does nothing for unknown thread', async () => {
      await manager.sendFollowUp('unknown-thread', 'message');
      // Should not throw
    });
  });

  describe('resumePausedSession', () => {
    test('handles unknown thread gracefully', async () => {
      // This will try to find a persisted session which doesn't exist
      await manager.resumePausedSession('unknown-thread', 'message');
      // Should not throw - method handles missing session internally
    });
  });

  describe('worktree commands', () => {
    test('handleWorktreeBranchResponse does nothing for unknown thread', async () => {
      const result = await manager.handleWorktreeBranchResponse('unknown-thread', 'branch', 'user', 'post1');
      expect(result).toBe(false);
    });

    test('handleWorktreeSkip does nothing for unknown thread', async () => {
      await manager.handleWorktreeSkip('unknown-thread', 'user');
      // Should not throw
    });

    test('createAndSwitchToWorktree does nothing for unknown thread', async () => {
      await manager.createAndSwitchToWorktree('unknown-thread', 'branch', 'user');
      // Should not throw
    });

    test('switchToWorktree does nothing for unknown thread', async () => {
      await manager.switchToWorktree('unknown-thread', 'branch', 'user');
      // Should not throw
    });

    test('listWorktreesCommand does nothing for unknown thread', async () => {
      await manager.listWorktreesCommand('unknown-thread', 'user');
      // Should not throw
    });

    test('removeWorktreeCommand does nothing for unknown thread', async () => {
      await manager.removeWorktreeCommand('unknown-thread', 'branch', 'user');
      // Should not throw
    });

    test('disableWorktreePrompt does nothing for unknown thread', async () => {
      await manager.disableWorktreePrompt('unknown-thread', 'user');
      // Should not throw
    });
  });

  describe('postShutdownMessages', () => {
    test('does nothing when no sessions', async () => {
      await manager.postShutdownMessages();
      // Should not throw
    });
  });

  describe('shutdown', () => {
    test('shuts down gracefully with no sessions', async () => {
      await manager.shutdown('Shutting down');
      // Should not throw
    });
  });

  describe('offerContextPrompt', () => {
    test('returns false for unknown thread', async () => {
      // Can't easily test without a session, but the method requires a session object
    });
  });

  describe('pauseSessionsForPlatform', () => {
    test('does nothing when no sessions for platform', async () => {
      await manager.pauseSessionsForPlatform('test-platform');
      // Should not throw
    });
  });

  describe('resumePausedSessionsForPlatform', () => {
    test('does nothing when no paused sessions for platform', async () => {
      await manager.resumePausedSessionsForPlatform('test-platform');
      // Should not throw
    });
  });

  describe('addSideConversation', () => {
    test('does nothing for unknown thread', () => {
      // Should not throw
      manager.addSideConversation('unknown-thread', {
        fromUser: 'alice',
        mentionedUser: 'bob',
        message: 'test message',
        timestamp: new Date(),
        postId: 'post1',
      });
    });

    test('tracks side conversation for known thread', () => {
      // Create a mock session in the registry
      const mockSession = {
        threadId: 'test-thread',
        sessionId: 'test-platform:test-thread',
        pendingSideConversations: undefined as any,
      };
      // Access registry directly (it's public)
      (manager.registry as any).sessions.set('test-platform:test-thread', mockSession);

      manager.addSideConversation('test-thread', {
        fromUser: 'alice',
        mentionedUser: 'bob',
        message: 'test message',
        timestamp: new Date(),
        postId: 'post1',
      });

      expect(mockSession.pendingSideConversations).toBeDefined();
      expect(mockSession.pendingSideConversations.length).toBe(1);
      expect(mockSession.pendingSideConversations[0].fromUser).toBe('alice');
    });

    test('enforces max count limit', () => {
      const mockSession = {
        threadId: 'test-thread',
        sessionId: 'test-platform:test-thread',
        pendingSideConversations: [] as any[],
      };
      (manager.registry as any).sessions.set('test-platform:test-thread', mockSession);

      // Add 7 conversations (more than the 5 limit)
      for (let i = 0; i < 7; i++) {
        manager.addSideConversation('test-thread', {
          fromUser: `user${i}`,
          mentionedUser: 'bob',
          message: `message ${i}`,
          timestamp: new Date(),
          postId: `post${i}`,
        });
      }

      // Should only keep the last 5
      expect(mockSession.pendingSideConversations.length).toBe(5);
      expect(mockSession.pendingSideConversations[0].fromUser).toBe('user2');
      expect(mockSession.pendingSideConversations[4].fromUser).toBe('user6');
    });

    test('enforces max character limit', () => {
      const mockSession = {
        threadId: 'test-thread',
        sessionId: 'test-platform:test-thread',
        pendingSideConversations: [] as any[],
      };
      (manager.registry as any).sessions.set('test-platform:test-thread', mockSession);

      // Add conversations with 500 chars each (exceeds 2000 total after 5 messages)
      for (let i = 0; i < 5; i++) {
        manager.addSideConversation('test-thread', {
          fromUser: `user${i}`,
          mentionedUser: 'bob',
          message: 'A'.repeat(500),
          timestamp: new Date(),
          postId: `post${i}`,
        });
      }

      // Should only keep messages that fit in 2000 chars (4 messages = 2000 chars exactly)
      expect(mockSession.pendingSideConversations.length).toBe(4);
    });

    test('enforces max age limit', () => {
      const mockSession = {
        threadId: 'test-thread',
        sessionId: 'test-platform:test-thread',
        pendingSideConversations: [] as any[],
      };
      (manager.registry as any).sessions.set('test-platform:test-thread', mockSession);

      // Add an old conversation (31 minutes ago)
      const oldTimestamp = new Date(Date.now() - 31 * 60 * 1000);
      manager.addSideConversation('test-thread', {
        fromUser: 'olduser',
        mentionedUser: 'bob',
        message: 'old message',
        timestamp: oldTimestamp,
        postId: 'old-post',
      });

      // Add a recent conversation
      manager.addSideConversation('test-thread', {
        fromUser: 'newuser',
        mentionedUser: 'bob',
        message: 'new message',
        timestamp: new Date(),
        postId: 'new-post',
      });

      // Should only have the recent message (old one filtered by age)
      expect(mockSession.pendingSideConversations.length).toBe(1);
      expect(mockSession.pendingSideConversations[0].fromUser).toBe('newuser');
    });
  });

  // ==========================================================================
  // PR 1 safety net — targeted tests that exercise injected-session paths
  // ==========================================================================

  /** Inject a realistic-ish session directly into the registry. */
  function injectSession(
    mgr: SessionManager,
    platform: PlatformClient,
    threadId: string,
    overrides: Record<string, unknown> = {}
  ) {
    const sessionId = `test-platform:${threadId}`;
    const session: any = {
      platformId: 'test-platform',
      threadId,
      sessionId,
      claudeSessionId: `claude-${threadId}`,
      startedBy: 'alice',
      startedByDisplayName: 'Alice',
      startedAt: new Date(),
      lastActivityAt: new Date(),
      sessionNumber: 1,
      workingDir: '/test/dir',
      platform,
      claude: {
        isRunning: mock(() => true),
        kill: mock(() => Promise.resolve()),
        isPermanentFailure: mock(() => false),
        getPermanentFailureReason: mock(() => null),
      },
      planApproved: false,
      sessionAllowedUsers: new Set(['alice']),
      forceInteractivePermissions: false,
      sessionStartPostId: null,
      timers: { timeoutTimer: null, warningTimer: null, cleanupTimer: null },
      lifecycle: { state: 'active', resumeFailCount: 0, hasClaudeResponded: true },
      timeoutWarningPosted: false,
      messageCount: 0,
      messageManager: {
        getPendingContextPrompt: mock(() => null),
        getTaskListState: mock(() => ({ postId: null, content: null, isCompleted: false, isMinimized: false })),
        dispose: mock(() => {}),
      },
      ...overrides,
    };
    (mgr.registry as any).sessions.set(sessionId, session);
    return session;
  }

  describe('isSessionActive with injected session', () => {
    test('returns true when at least one session is registered', () => {
      injectSession(manager, platform as unknown as PlatformClient, 'thread-X');
      expect(manager.isSessionActive()).toBe(true);
    });
  });

  describe('isInSessionThread', () => {
    test('returns true for a registered thread', () => {
      injectSession(manager, platform as unknown as PlatformClient, 'thread-X');
      expect(manager.isInSessionThread('thread-X')).toBe(true);
    });
  });

  describe('getActiveThreadIds', () => {
    test('returns registered thread ids', () => {
      injectSession(manager, platform as unknown as PlatformClient, 'A');
      injectSession(manager, platform as unknown as PlatformClient, 'B');
      expect(manager.getActiveThreadIds().sort()).toEqual(['A', 'B']);
    });
  });

  describe('isUserAllowedInSession', () => {
    test('returns true for session owner', () => {
      injectSession(manager, platform as unknown as PlatformClient, 'thread-X', {
        sessionAllowedUsers: new Set(['alice']),
      });
      expect(manager.isUserAllowedInSession('thread-X', 'alice')).toBe(true);
    });

    test('returns true for globally-allowed user', () => {
      injectSession(manager, platform as unknown as PlatformClient, 'thread-X', {
        sessionAllowedUsers: new Set(['alice']),
      });
      expect(manager.isUserAllowedInSession('thread-X', 'admin')).toBe(true);
    });

    test('returns false for random user not invited', () => {
      injectSession(manager, platform as unknown as PlatformClient, 'thread-X', {
        sessionAllowedUsers: new Set(['alice']),
      });
      expect(manager.isUserAllowedInSession('thread-X', 'mallory')).toBe(false);
    });
  });

  describe('killSession (injected)', () => {
    test('kills an active session and drops it from registry', async () => {
      const session = injectSession(manager, platform as unknown as PlatformClient, 'thread-X');
      await manager.killSession('thread-X');
      expect(session.claude.kill).toHaveBeenCalled();
      expect((manager.registry as any).sessions.has('test-platform:thread-X')).toBe(false);
    });
  });

  describe('handleReaction (injected) — security gate', () => {
    test('ignores reactions from unauthorized users', async () => {
      const session = injectSession(manager, platform as unknown as PlatformClient, 'thread-X', {
        sessionStartPostId: 'start-post',
        sessionAllowedUsers: new Set(['alice']),
      });
      // Register the post so getSessionByPost finds it.
      (manager as any).registry.postIndex = (manager as any).registry.postIndex || new Map();
      (manager as any).registry.registerPost?.('start-post', 'thread-X', session.sessionId);
      // The test platform mock's isUserAllowed accepts 'admin'/'allowed-user'.
      // 'mallory' is NOT allowed anywhere.
      await (manager as any).handleReaction('test-platform', 'start-post', 'x', 'mallory', 'added');
      // killSession should not have been called (cancel would trigger it).
      expect(session.claude.kill).not.toHaveBeenCalled();
    });

    test('logs an audit entry when rejecting an unauthorized reaction', async () => {
      const session = injectSession(manager, platform as unknown as PlatformClient, 'thread-X', {
        sessionStartPostId: 'start-post',
        sessionAllowedUsers: new Set(['alice']),
      });
      (manager as any).registry.postIndex = (manager as any).registry.postIndex || new Map();
      (manager as any).registry.registerPost?.('start-post', 'thread-X', session.sessionId);

      // Logger emits through globalLogHandler when one is set (the UI layer
      // installs one at startup). In tests we install our own capture.
      const captured: Array<{ level: string; msg: string }> = [];
      setLogHandler((level, _component, msg) => {
        captured.push({ level, msg });
      });
      try {
        await (manager as any).handleReaction('test-platform', 'start-post', 'x', 'mallory', 'added');
      } finally {
        setLogHandler(null);
      }

      const audit = captured.find(entry => entry.msg.includes('reaction.rejected'));
      expect(audit).toBeDefined();
      expect(audit?.level).toBe('info');
      expect(audit?.msg).toContain('mallory');
    });
  });

  describe('handlePostDeleted', () => {
    test('is a no-op for unknown posts', () => {
      // Smoke test — any explicit post-delete cleanup hooks should tolerate unknown posts.
      // We simply confirm the method (if present) doesn't throw.
      if (typeof (manager as any).handlePostDeleted === 'function') {
        expect(() => (manager as any).handlePostDeleted('test-platform', 'unknown-post')).not.toThrow();
      }
    });
  });

  describe('setSkipPermissions + isSessionInteractive (injected session)', () => {
    test('forceInteractivePermissions overrides a skipPermissions=true manager', () => {
      // Fresh manager created with skipPermissions=true in outer beforeEach.
      injectSession(manager, platform as unknown as PlatformClient, 'thread-F', {
        forceInteractivePermissions: true,
      });
      expect(manager.isSessionInteractive('thread-F')).toBe(true);
    });
  });
});
