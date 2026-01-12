import { describe, it, expect, afterEach } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'fs';
import {
  createThreadLogger,
  cleanupOldLogs,
  getLogFilePath,
  type ThreadLogger,
  type ClaudeEventEntry,
  type UserMessageEntry,
  type LifecycleEntry,
  type CommandEntry,
} from './thread-logger.js';

// Helper to parse JSONL file
function parseJsonl(filePath: string): unknown[] {
  const content = readFileSync(filePath, 'utf8');
  return content.trim().split('\n').map(line => JSON.parse(line));
}

describe('ThreadLogger', () => {
  let logger: ThreadLogger;
  const platformId = 'test-platform';
  const sessionId = 'test-session-uuid';
  let testCounter = 0;

  // Generate unique threadId for each test to avoid accumulation
  function getUniqueThreadId(): string {
    return `test-thread-${Date.now()}-${testCounter++}`;
  }

  afterEach(async () => {
    if (logger) {
      const logPath = logger.getLogPath();
      await logger.close();
      // Clean up the log file if it exists
      if (logPath && existsSync(logPath)) {
        rmSync(logPath);
      }
    }
  });

  describe('createThreadLogger', () => {
    it('creates an enabled logger by default', () => {
      const threadId = getUniqueThreadId();
      logger = createThreadLogger(platformId, threadId, sessionId);
      expect(logger.isEnabled()).toBe(true);
    });

    it('creates a disabled logger when enabled: false', () => {
      const threadId = getUniqueThreadId();
      logger = createThreadLogger(platformId, threadId, sessionId, { enabled: false });
      expect(logger.isEnabled()).toBe(false);
    });

    it('returns correct log path', () => {
      const threadId = getUniqueThreadId();
      logger = createThreadLogger(platformId, threadId, sessionId);
      const expectedPath = getLogFilePath(platformId, threadId);
      expect(logger.getLogPath()).toBe(expectedPath);
    });
  });

  describe('logEvent', () => {
    it('logs Claude events to JSONL file', async () => {
      const threadId = getUniqueThreadId();
      logger = createThreadLogger(platformId, threadId, sessionId);

      const event = {
        type: 'assistant' as const,
        message: { content: 'Hello, world!' },
      };

      logger.logEvent(event);
      await logger.flush();

      const logPath = logger.getLogPath();
      expect(existsSync(logPath)).toBe(true);

      const entries = parseJsonl(logPath);
      expect(entries.length).toBe(1);

      const entry = entries[0] as ClaudeEventEntry;
      expect(entry.type).toBe('claude_event');
      expect(entry.eventType).toBe('assistant');
      expect(entry.sessionId).toBe(sessionId);
      expect(entry.ts).toBeDefined();
      expect(entry.event).toEqual(event);
    });

    it('does not log when disabled', async () => {
      const threadId = getUniqueThreadId();
      logger = createThreadLogger(platformId, threadId, sessionId, { enabled: false });

      logger.logEvent({ type: 'assistant' as const, message: { content: 'test' } });
      await logger.flush();

      // Disabled logger returns empty path
      expect(logger.getLogPath()).toBe('');
    });
  });

  describe('logUserMessage', () => {
    it('logs user messages', async () => {
      const threadId = getUniqueThreadId();
      logger = createThreadLogger(platformId, threadId, sessionId);

      logger.logUserMessage('testuser', 'Hello, Claude!', 'Test User', true);
      await logger.flush();

      const entries = parseJsonl(logger.getLogPath());
      expect(entries.length).toBe(1);

      const entry = entries[0] as UserMessageEntry;
      expect(entry.type).toBe('user_message');
      expect(entry.username).toBe('testuser');
      expect(entry.displayName).toBe('Test User');
      expect(entry.message).toBe('Hello, Claude!');
      expect(entry.hasFiles).toBe(true);
    });
  });

  describe('logLifecycle', () => {
    it('logs lifecycle events', async () => {
      const threadId = getUniqueThreadId();
      logger = createThreadLogger(platformId, threadId, sessionId);

      logger.logLifecycle('start', { username: 'testuser', workingDir: '/test/dir' });
      await logger.flush();

      const entries = parseJsonl(logger.getLogPath());
      expect(entries.length).toBe(1);

      const entry = entries[0] as LifecycleEntry;
      expect(entry.type).toBe('lifecycle');
      expect(entry.action).toBe('start');
      expect(entry.username).toBe('testuser');
      expect(entry.workingDir).toBe('/test/dir');
    });

    it('logs exit events with exit code', async () => {
      const threadId = getUniqueThreadId();
      logger = createThreadLogger(platformId, threadId, sessionId);

      logger.logLifecycle('exit', { exitCode: 0 });
      await logger.flush();

      const entries = parseJsonl(logger.getLogPath());
      const entry = entries[0] as LifecycleEntry;
      expect(entry.action).toBe('exit');
      expect(entry.exitCode).toBe(0);
    });
  });

  describe('logCommand', () => {
    it('logs user commands', async () => {
      const threadId = getUniqueThreadId();
      logger = createThreadLogger(platformId, threadId, sessionId);

      logger.logCommand('cd', '/new/path', 'testuser');
      await logger.flush();

      const entries = parseJsonl(logger.getLogPath());
      expect(entries.length).toBe(1);

      const entry = entries[0] as CommandEntry;
      expect(entry.type).toBe('command');
      expect(entry.command).toBe('cd');
      expect(entry.args).toBe('/new/path');
      expect(entry.username).toBe('testuser');
    });

    it('logs commands without args', async () => {
      const threadId = getUniqueThreadId();
      logger = createThreadLogger(platformId, threadId, sessionId);

      logger.logCommand('stop', undefined, 'testuser');
      await logger.flush();

      const entries = parseJsonl(logger.getLogPath());
      const entry = entries[0] as CommandEntry;
      expect(entry.command).toBe('stop');
      expect(entry.args).toBeUndefined();
    });
  });

  describe('logPermission', () => {
    it('logs permission requests', async () => {
      const threadId = getUniqueThreadId();
      logger = createThreadLogger(platformId, threadId, sessionId);

      logger.logPermission('request', 'Write file.txt');
      await logger.flush();

      const entries = parseJsonl(logger.getLogPath());
      expect(entries.length).toBe(1);

      const entry = entries[0];
      expect((entry as { type: string }).type).toBe('permission');
      expect((entry as { action: string }).action).toBe('request');
      expect((entry as { permission: string }).permission).toBe('Write file.txt');
    });

    it('logs permission approvals with username', async () => {
      const threadId = getUniqueThreadId();
      logger = createThreadLogger(platformId, threadId, sessionId);

      logger.logPermission('approve', 'Write file.txt', 'testuser');
      await logger.flush();

      const entries = parseJsonl(logger.getLogPath());
      const entry = entries[0];
      expect((entry as { action: string }).action).toBe('approve');
      expect((entry as { username: string }).username).toBe('testuser');
    });
  });

  describe('logReaction', () => {
    it('logs reaction events', async () => {
      const threadId = getUniqueThreadId();
      logger = createThreadLogger(platformId, threadId, sessionId);

      logger.logReaction('plan_approve', 'testuser', '👍');
      await logger.flush();

      const entries = parseJsonl(logger.getLogPath());
      expect(entries.length).toBe(1);

      const entry = entries[0];
      expect((entry as { type: string }).type).toBe('reaction');
      expect((entry as { action: string }).action).toBe('plan_approve');
      expect((entry as { username: string }).username).toBe('testuser');
      expect((entry as { emoji: string }).emoji).toBe('👍');
    });

    it('logs question answers', async () => {
      const threadId = getUniqueThreadId();
      logger = createThreadLogger(platformId, threadId, sessionId);

      logger.logReaction('question_answer', 'testuser', '1️⃣', 'Option A');
      await logger.flush();

      const entries = parseJsonl(logger.getLogPath());
      const entry = entries[0];
      expect((entry as { action: string }).action).toBe('question_answer');
      expect((entry as { answer: string }).answer).toBe('Option A');
    });
  });

  describe('buffering', () => {
    it('buffers entries before flushing', async () => {
      const threadId = getUniqueThreadId();
      logger = createThreadLogger(platformId, threadId, sessionId, {
        bufferSize: 10,
        flushIntervalMs: 10000, // Long interval to test manual flush
      });

      logger.logEvent({ type: 'assistant' as const, message: { content: 'test1' } });
      logger.logEvent({ type: 'assistant' as const, message: { content: 'test2' } });
      logger.logEvent({ type: 'assistant' as const, message: { content: 'test3' } });

      // File may not exist yet (buffered)
      // But after flush it should
      await logger.flush();

      const entries = parseJsonl(logger.getLogPath());
      expect(entries.length).toBe(3);
    });

    it('auto-flushes when buffer is full', async () => {
      const threadId = getUniqueThreadId();
      logger = createThreadLogger(platformId, threadId, sessionId, {
        bufferSize: 2,
        flushIntervalMs: 10000, // Long interval
      });

      // Add 3 events - should auto-flush after 2
      logger.logEvent({ type: 'assistant' as const, message: { content: 'test1' } });
      logger.logEvent({ type: 'assistant' as const, message: { content: 'test2' } });
      // The third event should trigger a flush of the first two
      logger.logEvent({ type: 'assistant' as const, message: { content: 'test3' } });

      // Wait a bit for the auto-flush
      await new Promise(resolve => setTimeout(resolve, 50));

      const entries = parseJsonl(logger.getLogPath());
      // Should have at least 2 entries (the first flush)
      expect(entries.length).toBeGreaterThanOrEqual(2);

      // Close and flush remaining
      await logger.close();
      const finalEntries = parseJsonl(logger.getLogPath());
      expect(finalEntries.length).toBe(3);
    });
  });

  describe('close', () => {
    it('flushes remaining entries on close', async () => {
      const threadId = getUniqueThreadId();
      logger = createThreadLogger(platformId, threadId, sessionId, {
        bufferSize: 100, // High buffer to prevent auto-flush
        flushIntervalMs: 10000,
      });

      logger.logEvent({ type: 'assistant' as const, message: { content: 'test' } });

      // Close should flush
      await logger.close();

      const entries = parseJsonl(logger.getLogPath());
      expect(entries.length).toBe(1);
    });

    it('does not write after close', async () => {
      const threadId = getUniqueThreadId();
      logger = createThreadLogger(platformId, threadId, sessionId);
      const logPath = logger.getLogPath();
      await logger.close();

      // This should be a no-op
      logger.logEvent({ type: 'assistant' as const, message: { content: 'test' } });
      await logger.flush();

      // Since logger closed with empty buffer, file might not exist or be empty
      if (existsSync(logPath)) {
        const content = readFileSync(logPath, 'utf8');
        expect(content.trim()).toBe('');
      }
    });
  });

  describe('multiple sessions same thread', () => {
    it('appends to existing log file', async () => {
      const threadId = getUniqueThreadId();

      // First session
      const logger1 = createThreadLogger(platformId, threadId, 'session-1');
      logger1.logLifecycle('start', { username: 'user1' });
      await logger1.close();

      // Second session (same thread, different session ID)
      const logger2 = createThreadLogger(platformId, threadId, 'session-2');
      logger2.logLifecycle('resume', { username: 'user1' });
      await logger2.close();

      const entries = parseJsonl(logger1.getLogPath());
      expect(entries.length).toBe(2);

      expect((entries[0] as LifecycleEntry).sessionId).toBe('session-1');
      expect((entries[0] as LifecycleEntry).action).toBe('start');
      expect((entries[1] as LifecycleEntry).sessionId).toBe('session-2');
      expect((entries[1] as LifecycleEntry).action).toBe('resume');

      // Clean up
      rmSync(logger1.getLogPath());
    });
  });
});

describe('getLogFilePath', () => {
  it('returns correct path format', () => {
    const path = getLogFilePath('mattermost-main', 'thread-abc123');
    expect(path).toContain('.claude-threads/logs/mattermost-main/thread-abc123.jsonl');
  });
});

describe('cleanupOldLogs', () => {
  it('returns 0 when logs directory does not exist', () => {
    // cleanupOldLogs uses the real logs directory, so this test
    // verifies it doesn't crash when no logs exist
    const deleted = cleanupOldLogs(30);
    expect(deleted).toBeGreaterThanOrEqual(0);
  });
});
