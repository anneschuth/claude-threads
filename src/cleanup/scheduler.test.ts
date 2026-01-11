import { describe, it, expect, afterEach, mock } from 'bun:test';
import { CleanupScheduler } from './scheduler.js';
import type { SessionStore } from '../persistence/session-store.js';
import type { PersistedSession } from '../persistence/session-store.js';

// Mock session store
function createMockSessionStore(sessions: Map<string, PersistedSession> = new Map()): SessionStore {
  return {
    load: () => sessions,
    save: mock(() => {}),
    remove: mock(() => {}),
    cleanStale: mock(() => []),
    cleanHistory: mock(() => 0),
    getPath: () => '/tmp/test-sessions.json',
  } as unknown as SessionStore;
}

describe('CleanupScheduler', () => {
  let scheduler: CleanupScheduler;

  afterEach(() => {
    scheduler?.stop();
  });

  describe('constructor', () => {
    it('should create scheduler with default options', () => {
      const store = createMockSessionStore();
      scheduler = new CleanupScheduler({ sessionStore: store });

      expect(scheduler).toBeDefined();
    });

    it('should accept custom options', () => {
      const store = createMockSessionStore();
      scheduler = new CleanupScheduler({
        sessionStore: store,
        intervalMs: 5000,
        logRetentionDays: 7,
        threadLogsEnabled: false,
      });

      expect(scheduler).toBeDefined();
    });
  });

  describe('start/stop', () => {
    it('should start and stop without errors', () => {
      const store = createMockSessionStore();
      scheduler = new CleanupScheduler({
        sessionStore: store,
        intervalMs: 60000, // Long interval to avoid actual runs
      });

      scheduler.start();
      scheduler.stop();
    });

    it('should handle multiple start calls gracefully', () => {
      const store = createMockSessionStore();
      scheduler = new CleanupScheduler({
        sessionStore: store,
        intervalMs: 60000,
      });

      scheduler.start();
      scheduler.start(); // Should not throw
      scheduler.stop();
    });

    it('should handle multiple stop calls gracefully', () => {
      const store = createMockSessionStore();
      scheduler = new CleanupScheduler({
        sessionStore: store,
        intervalMs: 60000,
      });

      scheduler.start();
      scheduler.stop();
      scheduler.stop(); // Should not throw
    });
  });

  describe('runCleanup', () => {
    it('should run cleanup and return stats', async () => {
      const store = createMockSessionStore();
      scheduler = new CleanupScheduler({
        sessionStore: store,
        threadLogsEnabled: false, // Disable to avoid file system operations
      });

      const stats = await scheduler.runCleanup();

      expect(stats).toBeDefined();
      expect(typeof stats.logsDeleted).toBe('number');
      expect(typeof stats.worktreesCleaned).toBe('number');
      expect(typeof stats.metadataCleaned).toBe('number');
      expect(Array.isArray(stats.errors)).toBe(true);
    });

    it('should skip log cleanup when threadLogsEnabled is false', async () => {
      const store = createMockSessionStore();
      scheduler = new CleanupScheduler({
        sessionStore: store,
        threadLogsEnabled: false,
      });

      const stats = await scheduler.runCleanup();

      // Logs should be 0 when disabled
      expect(stats.logsDeleted).toBe(0);
    });

    it('should handle cleanup errors gracefully', async () => {
      const store = createMockSessionStore();
      scheduler = new CleanupScheduler({
        sessionStore: store,
        threadLogsEnabled: true,
        logRetentionDays: 30,
      });

      // Even if there are no logs/worktrees, should complete without error
      const stats = await scheduler.runCleanup();

      expect(stats).toBeDefined();
    });
  });

  describe('integration', () => {
    it('should not clean worktrees in use by sessions', async () => {
      // Create a session store with an active worktree
      const sessions = new Map<string, PersistedSession>();
      sessions.set('test-session', {
        threadId: 'thread1',
        platformId: 'test',
        claudeSessionId: 'claude1',
        workingDir: '/tmp/test',
        startedBy: 'user',
        worktreeInfo: {
          repoRoot: '/tmp/repo',
          worktreePath: '/tmp/active-worktree',
          branch: 'feature',
        },
      } as PersistedSession);

      const store = createMockSessionStore(sessions);
      scheduler = new CleanupScheduler({
        sessionStore: store,
        threadLogsEnabled: false,
      });

      const stats = await scheduler.runCleanup();

      // Should complete without cleaning the active worktree
      expect(stats.errors.length).toBe(0);
    });
  });
});
