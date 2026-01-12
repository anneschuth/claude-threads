import { describe, it, expect, mock } from 'bun:test';
import {
  getContextSelectionFromReaction,
  formatContextForClaude,
  getValidContextOptions,
  CONTEXT_OPTIONS,
  CONTEXT_PROMPT_TIMEOUT_MS,
  getThreadContextCount,
  getThreadMessagesForContext,
  updateContextPromptPost,
  clearContextPromptTimeout,
  type PendingContextPrompt,
} from './handler.js';
import type { ThreadMessage, PlatformClient, PlatformPost } from '../../platform/index.js';
import type { Session } from '../../session/types.js';
import { createMockFormatter } from '../../test-utils/mock-formatter.js';

describe('context-prompt', () => {
  describe('getValidContextOptions', () => {
    it('returns empty array for 0 messages', () => {
      expect(getValidContextOptions(0)).toEqual([]);
    });

    it('returns empty array for 2 messages (less than smallest option)', () => {
      expect(getValidContextOptions(2)).toEqual([]);
    });

    it('returns [3] for 3 messages', () => {
      expect(getValidContextOptions(3)).toEqual([3]);
    });

    it('returns [3] for 4 messages', () => {
      expect(getValidContextOptions(4)).toEqual([3]);
    });

    it('returns [3, 5] for 5 messages', () => {
      expect(getValidContextOptions(5)).toEqual([3, 5]);
    });

    it('returns [3, 5] for 8 messages', () => {
      expect(getValidContextOptions(8)).toEqual([3, 5]);
    });

    it('returns [3, 5, 10] for 10 messages', () => {
      expect(getValidContextOptions(10)).toEqual([3, 5, 10]);
    });

    it('returns [3, 5, 10] for 20 messages', () => {
      expect(getValidContextOptions(20)).toEqual([3, 5, 10]);
    });
  });

  describe('getContextSelectionFromReaction', () => {
    const standardOptions = [3, 5, 10];
    const customOptions = [3, 5, 8]; // For 8 messages

    it('returns first option for "one" emoji', () => {
      expect(getContextSelectionFromReaction('one', standardOptions)).toBe(3);
      expect(getContextSelectionFromReaction('one', customOptions)).toBe(3);
    });

    it('returns second option for "two" emoji', () => {
      expect(getContextSelectionFromReaction('two', standardOptions)).toBe(5);
      expect(getContextSelectionFromReaction('two', customOptions)).toBe(5);
    });

    it('returns third option for "three" emoji', () => {
      expect(getContextSelectionFromReaction('three', standardOptions)).toBe(10);
      expect(getContextSelectionFromReaction('three', customOptions)).toBe(8); // "All 8 messages"
    });

    it('returns 0 (no context) for denial emojis', () => {
      expect(getContextSelectionFromReaction('-1', standardOptions)).toBe(0);
      expect(getContextSelectionFromReaction('thumbsdown', standardOptions)).toBe(0);
    });

    it('returns 0 (no context) for "x" emoji', () => {
      expect(getContextSelectionFromReaction('x', standardOptions)).toBe(0);
    });

    it('returns null for invalid emojis', () => {
      expect(getContextSelectionFromReaction('heart', standardOptions)).toBe(null);
      expect(getContextSelectionFromReaction('+1', standardOptions)).toBe(null);
    });

    it('returns null for out-of-range number emojis', () => {
      const twoOptions = [3, 5];
      expect(getContextSelectionFromReaction('three', twoOptions)).toBe(null);
    });

    it('handles unicode number emojis', () => {
      expect(getContextSelectionFromReaction('1️⃣', standardOptions)).toBe(3);
      expect(getContextSelectionFromReaction('2️⃣', standardOptions)).toBe(5);
      expect(getContextSelectionFromReaction('3️⃣', standardOptions)).toBe(10);
    });
  });

  describe('formatContextForClaude', () => {
    it('returns empty string for empty messages', () => {
      expect(formatContextForClaude([])).toBe('');
    });

    it('formats single message correctly', () => {
      const messages: ThreadMessage[] = [
        {
          id: '1',
          userId: 'user1',
          username: 'alice',
          message: 'Hello world',
          createAt: Date.now(),
        },
      ];

      const result = formatContextForClaude(messages);
      expect(result).toContain('[Previous conversation in this thread:]');
      expect(result).toContain('@alice: Hello world');
      expect(result).toContain('[Current request:]');
    });

    it('formats multiple messages in order', () => {
      const messages: ThreadMessage[] = [
        {
          id: '1',
          userId: 'user1',
          username: 'alice',
          message: 'First message',
          createAt: 1000,
        },
        {
          id: '2',
          userId: 'user2',
          username: 'bob',
          message: 'Second message',
          createAt: 2000,
        },
      ];

      const result = formatContextForClaude(messages);
      expect(result).toContain('@alice: First message');
      expect(result).toContain('@bob: Second message');
      // Check order (alice before bob)
      const aliceIndex = result.indexOf('@alice');
      const bobIndex = result.indexOf('@bob');
      expect(aliceIndex).toBeLessThan(bobIndex);
    });

    it('truncates very long messages', () => {
      const longMessage = 'x'.repeat(600);
      const messages: ThreadMessage[] = [
        {
          id: '1',
          userId: 'user1',
          username: 'alice',
          message: longMessage,
          createAt: Date.now(),
        },
      ];

      const result = formatContextForClaude(messages);
      expect(result).toContain('...');
      expect(result).not.toContain(longMessage);
    });

    it('includes separator and current request header', () => {
      const messages: ThreadMessage[] = [
        {
          id: '1',
          userId: 'user1',
          username: 'alice',
          message: 'Test',
          createAt: Date.now(),
        },
      ];

      const result = formatContextForClaude(messages);
      expect(result).toContain('---');
      expect(result).toContain('[Current request:]');
    });
  });

  describe('CONTEXT_OPTIONS', () => {
    it('has exactly 3 options', () => {
      expect(CONTEXT_OPTIONS.length).toBe(3);
    });

    it('options are in ascending order', () => {
      for (let i = 1; i < CONTEXT_OPTIONS.length; i++) {
        expect(CONTEXT_OPTIONS[i]).toBeGreaterThan(CONTEXT_OPTIONS[i - 1]);
      }
    });

    it('first option is 3 messages', () => {
      expect(CONTEXT_OPTIONS[0]).toBe(3);
    });
  });

  describe('CONTEXT_PROMPT_TIMEOUT_MS', () => {
    it('is 30 seconds', () => {
      expect(CONTEXT_PROMPT_TIMEOUT_MS).toBe(30000);
    });
  });

  // Helper to create a mock session
  function createMockSession(overrides?: {
    platformOverrides?: Partial<PlatformClient>;
    sessionOverrides?: Partial<Session>;
  }): Session {
    const mockPost: PlatformPost = { id: 'post-123', message: '', userId: 'bot', platformId: 'test-platform', channelId: 'channel-123' };

    const mockPlatform: Partial<PlatformClient> = {
      platformId: 'test-platform',
      platformType: 'mattermost',
      createPost: mock(() => Promise.resolve(mockPost)),
      updatePost: mock(() => Promise.resolve(mockPost)),
      addReaction: mock(() => Promise.resolve()),
      getFormatter: mock(() => createMockFormatter()),
      getThreadHistory: mock(() => Promise.resolve([])),
      ...overrides?.platformOverrides,
    };

    return {
      sessionId: 'test:thread-123',
      threadId: 'thread-123',
      platform: mockPlatform as PlatformClient,
      claude: {
        isRunning: mock(() => true),
        kill: mock(() => Promise.resolve()),
        sendMessage: mock(() => {}),
        on: mock(() => {}),
      } as any,
      claudeSessionId: 'claude-session-1',
      owner: 'testuser',
      startedBy: 'testuser',
      startedAt: new Date(),
      lastActivityAt: new Date(),
      buffer: '',
      sessionAllowedUsers: new Set(['testuser']),
      workingDir: '/test',
      isResumed: false,
      messageCount: 0,
      skipPermissions: true,
      ...overrides?.sessionOverrides,
    } as Session;
  }

  describe('getThreadContextCount', () => {
    it('returns count of non-bot messages', async () => {
      const messages: ThreadMessage[] = [
        { id: '1', userId: 'user1', username: 'alice', message: 'Hello', createAt: 1000 },
        { id: '2', userId: 'user2', username: 'bob', message: 'Hi', createAt: 2000 },
        { id: '3', userId: 'user3', username: 'carol', message: 'Hey', createAt: 3000 },
      ];

      const session = createMockSession({
        platformOverrides: {
          getThreadHistory: mock(() => Promise.resolve(messages)),
        },
      });

      const count = await getThreadContextCount(session);
      expect(count).toBe(3);
    });

    it('excludes specified post ID from count', async () => {
      const messages: ThreadMessage[] = [
        { id: '1', userId: 'user1', username: 'alice', message: 'Hello', createAt: 1000 },
        { id: '2', userId: 'user2', username: 'bob', message: 'Hi', createAt: 2000 },
      ];

      const session = createMockSession({
        platformOverrides: {
          getThreadHistory: mock(() => Promise.resolve(messages)),
        },
      });

      const count = await getThreadContextCount(session, '1');
      expect(count).toBe(1); // Excludes post with id '1'
    });

    it('returns 0 when getThreadHistory fails', async () => {
      const session = createMockSession({
        platformOverrides: {
          getThreadHistory: mock(() => Promise.reject(new Error('API error'))),
        },
      });

      const count = await getThreadContextCount(session);
      expect(count).toBe(0);
    });

    it('returns 0 for empty thread', async () => {
      const session = createMockSession({
        platformOverrides: {
          getThreadHistory: mock(() => Promise.resolve([])),
        },
      });

      const count = await getThreadContextCount(session);
      expect(count).toBe(0);
    });
  });

  describe('getThreadMessagesForContext', () => {
    it('returns messages up to the specified limit', async () => {
      const messages: ThreadMessage[] = [
        { id: '1', userId: 'user1', username: 'alice', message: 'Hello', createAt: 1000 },
        { id: '2', userId: 'user2', username: 'bob', message: 'Hi', createAt: 2000 },
        { id: '3', userId: 'user3', username: 'carol', message: 'Hey', createAt: 3000 },
      ];

      const session = createMockSession({
        platformOverrides: {
          getThreadHistory: mock(() => Promise.resolve(messages)),
        },
      });

      const result = await getThreadMessagesForContext(session, 5);
      expect(result.length).toBe(3);
    });

    it('filters out the excluded post ID', async () => {
      const messages: ThreadMessage[] = [
        { id: '1', userId: 'user1', username: 'alice', message: 'Hello', createAt: 1000 },
        { id: '2', userId: 'user2', username: 'bob', message: 'Hi', createAt: 2000 },
      ];

      const session = createMockSession({
        platformOverrides: {
          getThreadHistory: mock(() => Promise.resolve(messages)),
        },
      });

      const result = await getThreadMessagesForContext(session, 5, '2');
      expect(result.length).toBe(1);
      expect(result[0].id).toBe('1');
    });
  });

  describe('updateContextPromptPost', () => {
    it('updates post with timeout message', async () => {
      const session = createMockSession();

      await updateContextPromptPost(session, 'post-123', 'timeout');

      expect(session.platform.updatePost).toHaveBeenCalledWith(
        'post-123',
        '⏱️ Continuing without context (no response)'
      );
    });

    it('updates post with skip message (selection = 0)', async () => {
      const session = createMockSession();

      await updateContextPromptPost(session, 'post-123', 0, 'alice');

      expect(session.platform.updatePost).toHaveBeenCalledWith(
        'post-123',
        expect.stringContaining('Continuing without context')
      );
    });

    it('updates post with skip message (selection = "skip")', async () => {
      const session = createMockSession();

      await updateContextPromptPost(session, 'post-123', 'skip');

      expect(session.platform.updatePost).toHaveBeenCalledWith(
        'post-123',
        '✅ Continuing without context'
      );
    });

    it('updates post with message count selection', async () => {
      const session = createMockSession();

      await updateContextPromptPost(session, 'post-123', 5, 'bob');

      expect(session.platform.updatePost).toHaveBeenCalledWith(
        'post-123',
        expect.stringContaining('Including last 5 messages')
      );
    });

    it('includes username in message when provided', async () => {
      const session = createMockSession();

      await updateContextPromptPost(session, 'post-123', 5, 'charlie');

      expect(session.platform.updatePost).toHaveBeenCalledWith(
        'post-123',
        expect.stringContaining('charlie')
      );
    });

    it('handles update errors gracefully', async () => {
      const session = createMockSession({
        platformOverrides: {
          updatePost: mock(() => Promise.reject(new Error('Update failed'))),
        },
      });

      // Should not throw
      await expect(updateContextPromptPost(session, 'post-123', 'timeout')).resolves.toBeUndefined();
    });
  });

  describe('clearContextPromptTimeout', () => {
    it('clears the timeout when present', () => {
      const timeoutId = setTimeout(() => {}, 10000);
      const pending: PendingContextPrompt = {
        postId: 'post-123',
        queuedPrompt: 'test prompt',
        threadMessageCount: 5,
        createdAt: Date.now(),
        timeoutId,
        availableOptions: [3, 5],
      };

      clearContextPromptTimeout(pending);

      expect(pending.timeoutId).toBeUndefined();
    });

    it('handles pending without timeoutId', () => {
      const pending: PendingContextPrompt = {
        postId: 'post-123',
        queuedPrompt: 'test prompt',
        threadMessageCount: 5,
        createdAt: Date.now(),
        availableOptions: [3, 5],
      };

      // Should not throw
      clearContextPromptTimeout(pending);
      expect(pending.timeoutId).toBeUndefined();
    });
  });
});
