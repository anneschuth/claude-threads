/**
 * Tests for MessageApprovalExecutor
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { MessageApprovalExecutor } from './message-approval.js';
import type { ExecutorContext, PendingMessageApproval } from './types.js';
import type { PlatformClient, PlatformFormatter, PlatformPost } from '../../platform/index.js';
import { DefaultContentBreaker } from '../content-breaker.js';
import { PostTracker } from '../post-tracker.js';
import { createMessageManagerEvents } from '../message-manager-events.js';

// Mock formatter
const mockFormatter: PlatformFormatter = {
  formatBold: (text: string) => `**${text}**`,
  formatItalic: (text: string) => `_${text}_`,
  formatCode: (text: string) => `\`${text}\``,
  formatCodeBlock: (text: string, lang?: string) =>
    lang ? `\`\`\`${lang}\n${text}\n\`\`\`` : `\`\`\`\n${text}\n\`\`\``,
  formatLink: (text: string, url: string) => `[${text}](${url})`,
  formatStrikethrough: (text: string) => `~~${text}~~`,
  formatMarkdown: (text: string) => text,
  formatUserMention: (userId: string) => `@${userId}`,
  formatHorizontalRule: () => '---',
  formatBlockquote: (text: string) => `> ${text}`,
  formatListItem: (text: string) => `- ${text}`,
  formatNumberedListItem: (n: number, text: string) => `${n}. ${text}`,
  formatHeading: (text: string, level: number) => `${'#'.repeat(level)} ${text}`,
  escapeText: (text: string) => text,
  formatTable: (_headers: string[], _rows: string[][]) => '',
  formatKeyValueList: (_items: [string, string, string][]) => '',
};

// Create mock platform
function createMockPlatform(): PlatformClient {
  const posts = new Map<string, { content: string; reactions: string[] }>();
  let postIdCounter = 0;

  return {
    getFormatter: () => mockFormatter,
    createPost: mock(async (content: string, _threadId: string): Promise<PlatformPost> => {
      const id = `post_${++postIdCounter}`;
      posts.set(id, { content, reactions: [] });
      return { id, platformId: 'test', channelId: 'channel-1', message: content, createAt: Date.now(), userId: 'bot' };
    }),
    createInteractivePost: mock(async (content: string, reactions: string[], _threadId: string): Promise<PlatformPost> => {
      const id = `post_${++postIdCounter}`;
      posts.set(id, { content, reactions });
      return { id, platformId: 'test', channelId: 'channel-1', message: content, createAt: Date.now(), userId: 'bot' };
    }),
    updatePost: mock(async (postId: string, content: string): Promise<void> => {
      const post = posts.get(postId);
      if (post) {
        post.content = content;
      }
    }),
    deletePost: mock(async (_postId: string): Promise<void> => {}),
    getMessageLimits: () => ({ maxLength: 16000, hardThreshold: 12000 }),
    pinPost: mock(async () => {}),
    unpinPost: mock(async () => {}),
    addReaction: mock(async () => {}),
    removeReaction: mock(async () => {}),
  } as unknown as PlatformClient;
}

// Create context for tests
function createTestContext(platform?: PlatformClient): ExecutorContext {
  const p = platform ?? createMockPlatform();
  const threadId = 'thread-123';

  return {
    sessionId: 'test:session-1',
    threadId,
    platform: p,
    postTracker: new PostTracker(),
    contentBreaker: new DefaultContentBreaker(),
    formatter: mockFormatter,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, debugJson: () => {}, forSession: () => ({} as any) } as any,
    createPost: async (content, _options) => {
      const post = await p.createPost(content, threadId);
      return post;
    },
    createInteractivePost: async (content, reactions, _options) => {
      const post = await p.createInteractivePost(content, reactions, threadId);
      return post;
    },
  };
}

describe('MessageApprovalExecutor', () => {
  let executor: MessageApprovalExecutor;
  let ctx: ExecutorContext;
  let messageApprovalCompleted: { decision: string; fromUser: string; originalMessage: string; approvedBy: string } | null;

  beforeEach(() => {
    messageApprovalCompleted = null;

    // Create event emitter and subscribe to events
    const events = createMessageManagerEvents();
    events.on('message-approval:complete', ({ decision, fromUser, originalMessage, approvedBy }) => {
      messageApprovalCompleted = { decision, fromUser, originalMessage, approvedBy };
    });

    executor = new MessageApprovalExecutor({
      registerPost: (_postId, _options) => {},
      updateLastMessage: (_post) => {},
      events,
    });

    ctx = createTestContext();
  });

  describe('Message Approval Operations', () => {
    it('sets pending message approval', () => {
      const approval: PendingMessageApproval = {
        postId: 'post-123',
        fromUser: 'unauthorized-user',
        originalMessage: 'Hello world',
      };

      executor.setPendingMessageApproval(approval);

      expect(executor.hasPendingMessageApproval()).toBe(true);
      expect(executor.getPendingMessageApproval()).toEqual(approval);
    });

    it('handles allow decision', async () => {
      const approval: PendingMessageApproval = {
        postId: 'post-123',
        fromUser: 'unauthorized-user',
        originalMessage: 'Hello world',
      };

      executor.setPendingMessageApproval(approval);

      const handled = await executor.handleMessageApprovalResponse(
        'post-123',
        'allow',
        'approver-user',
        ctx
      );

      expect(handled).toBe(true);
      expect(executor.hasPendingMessageApproval()).toBe(false);
      expect(messageApprovalCompleted).not.toBeNull();
      expect(messageApprovalCompleted!.decision).toBe('allow');
      expect(messageApprovalCompleted!.fromUser).toBe('unauthorized-user');
      expect(messageApprovalCompleted!.originalMessage).toBe('Hello world');
      expect(messageApprovalCompleted!.approvedBy).toBe('approver-user');
    });

    it('handles invite decision', async () => {
      const approval: PendingMessageApproval = {
        postId: 'post-123',
        fromUser: 'unauthorized-user',
        originalMessage: 'Hello world',
      };

      executor.setPendingMessageApproval(approval);

      const handled = await executor.handleMessageApprovalResponse(
        'post-123',
        'invite',
        'approver-user',
        ctx
      );

      expect(handled).toBe(true);
      expect(messageApprovalCompleted!.decision).toBe('invite');
      expect(messageApprovalCompleted!.approvedBy).toBe('approver-user');
    });

    it('handles deny decision', async () => {
      const approval: PendingMessageApproval = {
        postId: 'post-123',
        fromUser: 'unauthorized-user',
        originalMessage: 'Hello world',
      };

      executor.setPendingMessageApproval(approval);

      const handled = await executor.handleMessageApprovalResponse(
        'post-123',
        'deny',
        'approver-user',
        ctx
      );

      expect(handled).toBe(true);
      expect(messageApprovalCompleted!.decision).toBe('deny');
      expect(messageApprovalCompleted!.approvedBy).toBe('approver-user');
    });

    it('ignores response for wrong post', async () => {
      const approval: PendingMessageApproval = {
        postId: 'post-123',
        fromUser: 'unauthorized-user',
        originalMessage: 'Hello world',
      };

      executor.setPendingMessageApproval(approval);

      const handled = await executor.handleMessageApprovalResponse(
        'wrong-post-id',
        'allow',
        'approver-user',
        ctx
      );

      expect(handled).toBe(false);
      expect(executor.hasPendingMessageApproval()).toBe(true);
    });
  });

  describe('State Management', () => {
    it('clears pending message approval', () => {
      const approval: PendingMessageApproval = {
        postId: 'post-123',
        fromUser: 'unauthorized-user',
        originalMessage: 'Hello world',
      };

      executor.setPendingMessageApproval(approval);
      expect(executor.hasPendingMessageApproval()).toBe(true);

      executor.clearPendingMessageApproval();
      expect(executor.hasPendingMessageApproval()).toBe(false);
    });

    it('resets state correctly', () => {
      const approval: PendingMessageApproval = {
        postId: 'post-123',
        fromUser: 'unauthorized-user',
        originalMessage: 'Hello world',
      };

      executor.setPendingMessageApproval(approval);
      expect(executor.hasPendingMessageApproval()).toBe(true);

      executor.reset();
      expect(executor.hasPendingMessageApproval()).toBe(false);
    });

    it('hydrates state from persisted data', () => {
      const persisted = {
        pendingMessageApproval: {
          postId: 'post-456',
          fromUser: 'persisted-user',
          originalMessage: 'Persisted message',
        },
      };

      executor.hydrateState(persisted);

      expect(executor.hasPendingMessageApproval()).toBe(true);
      expect(executor.getPendingMessageApproval()?.fromUser).toBe('persisted-user');
    });
  });

  describe('Reaction Handling', () => {
    it('handles approval emoji reaction', async () => {
      const approval: PendingMessageApproval = {
        postId: 'post-123',
        fromUser: 'unauthorized-user',
        originalMessage: 'Hello world',
      };

      executor.setPendingMessageApproval(approval);

      const handled = await executor.handleReaction('post-123', '+1', 'approver', 'added', ctx);

      expect(handled).toBe(true);
      expect(messageApprovalCompleted!.decision).toBe('allow');
    });

    it('handles invite emoji reaction', async () => {
      const approval: PendingMessageApproval = {
        postId: 'post-123',
        fromUser: 'unauthorized-user',
        originalMessage: 'Hello world',
      };

      executor.setPendingMessageApproval(approval);

      const handled = await executor.handleReaction('post-123', 'white_check_mark', 'approver', 'added', ctx);

      expect(handled).toBe(true);
      expect(messageApprovalCompleted!.decision).toBe('invite');
    });

    it('handles denial emoji reaction', async () => {
      const approval: PendingMessageApproval = {
        postId: 'post-123',
        fromUser: 'unauthorized-user',
        originalMessage: 'Hello world',
      };

      executor.setPendingMessageApproval(approval);

      const handled = await executor.handleReaction('post-123', '-1', 'approver', 'added', ctx);

      expect(handled).toBe(true);
      expect(messageApprovalCompleted!.decision).toBe('deny');
    });

    it('ignores removed reactions', async () => {
      const approval: PendingMessageApproval = {
        postId: 'post-123',
        fromUser: 'unauthorized-user',
        originalMessage: 'Hello world',
      };

      executor.setPendingMessageApproval(approval);

      const handled = await executor.handleReaction('post-123', '+1', 'approver', 'removed', ctx);

      expect(handled).toBe(false);
      expect(executor.hasPendingMessageApproval()).toBe(true);
    });
  });
});
