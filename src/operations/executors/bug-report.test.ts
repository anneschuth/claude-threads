/**
 * Tests for BugReportExecutor
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { BugReportExecutor } from './bug-report.js';
import type { ExecutorContext, PendingBugReport } from './types.js';
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

// Create sample pending bug report
function createSampleBugReport(overrides?: Partial<PendingBugReport>): PendingBugReport {
  return {
    postId: 'post-bug-123',
    title: 'Test Bug Report',
    body: 'This is the bug report body',
    userDescription: 'User found an issue',
    imageUrls: [],
    imageErrors: [],
    ...overrides,
  };
}

describe('BugReportExecutor', () => {
  let executor: BugReportExecutor;
  let ctx: ExecutorContext;
  let registeredPosts: Map<string, unknown>;
  let bugReportCompleted: { decision: 'approve' | 'deny'; report: PendingBugReport } | null;

  beforeEach(() => {
    registeredPosts = new Map();
    bugReportCompleted = null;

    // Create event emitter and subscribe to events
    const events = createMessageManagerEvents();
    events.on('bug-report:complete', ({ decision, report }) => {
      bugReportCompleted = { decision, report };
    });

    executor = new BugReportExecutor({
      registerPost: (postId, options) => {
        registeredPosts.set(postId, options);
      },
      updateLastMessage: (_post) => {
        // Track last message if needed
      },
      events,
    });

    ctx = createTestContext();
  });

  // ---------------------------------------------------------------------------
  // Constructor & Initialization
  // ---------------------------------------------------------------------------

  describe('Constructor & Initialization', () => {
    it('creates with default state', () => {
      const newExecutor = new BugReportExecutor({
        registerPost: () => {},
        updateLastMessage: () => {},
      });

      const state = newExecutor.getState();
      expect(state.pendingBugReport).toBeNull();
    });

    it('creates with dependencies injected', () => {
      const registerPostMock = mock(() => {});
      const updateLastMessageMock = mock(() => {});
      const events = createMessageManagerEvents();

      const newExecutor = new BugReportExecutor({
        registerPost: registerPostMock,
        updateLastMessage: updateLastMessageMock,
        events,
      });

      expect(newExecutor).toBeDefined();
      expect(newExecutor.getState().pendingBugReport).toBeNull();
    });

    it('state is properly initialized', () => {
      const state = executor.getState();
      expect(state).toEqual({ pendingBugReport: null });
    });
  });

  // ---------------------------------------------------------------------------
  // State Management
  // ---------------------------------------------------------------------------

  describe('State Management', () => {
    it('setPendingBugReport stores report correctly', () => {
      const report = createSampleBugReport();
      executor.setPendingBugReport(report);

      expect(executor.getPendingBugReport()).toEqual(report);
    });

    it('getPendingBugReport returns current report', () => {
      const report = createSampleBugReport({ title: 'Unique Title' });
      executor.setPendingBugReport(report);

      const retrieved = executor.getPendingBugReport();
      expect(retrieved?.title).toBe('Unique Title');
    });

    it('hasPendingBugReport returns true when report exists', () => {
      expect(executor.hasPendingBugReport()).toBe(false);

      executor.setPendingBugReport(createSampleBugReport());
      expect(executor.hasPendingBugReport()).toBe(true);
    });

    it('hasPendingBugReport returns false when no report', () => {
      expect(executor.hasPendingBugReport()).toBe(false);
    });

    it('clearPendingBugReport removes report', () => {
      executor.setPendingBugReport(createSampleBugReport());
      expect(executor.hasPendingBugReport()).toBe(true);

      executor.clearPendingBugReport();
      expect(executor.hasPendingBugReport()).toBe(false);
      expect(executor.getPendingBugReport()).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  describe('Persistence', () => {
    it('getState returns serializable state', () => {
      const report = createSampleBugReport();
      executor.setPendingBugReport(report);

      const state = executor.getState();
      // Should be serializable to JSON
      const serialized = JSON.stringify(state);
      const deserialized = JSON.parse(serialized);

      expect(deserialized.pendingBugReport.title).toBe(report.title);
      expect(deserialized.pendingBugReport.postId).toBe(report.postId);
    });

    it('getState returns a copy, not the original', () => {
      const report = createSampleBugReport();
      executor.setPendingBugReport(report);

      const state = executor.getState();
      // Modifying the returned state should not affect internal state
      if (state.pendingBugReport) {
        state.pendingBugReport.title = 'Modified';
      }

      expect(executor.getPendingBugReport()?.title).toBe('Test Bug Report');
    });

    it('reset returns clean initial state', () => {
      executor.setPendingBugReport(createSampleBugReport());
      expect(executor.hasPendingBugReport()).toBe(true);

      executor.reset();

      expect(executor.hasPendingBugReport()).toBe(false);
      expect(executor.getPendingBugReport()).toBeNull();
    });

    it('hydrateState restores from persisted data', () => {
      const persisted = {
        pendingBugReport: {
          postId: 'post-persisted-456',
          title: 'Persisted Bug',
          body: 'Persisted body',
          userDescription: 'Persisted description',
          imageUrls: ['http://example.com/image.png'],
          imageErrors: ['Error 1'],
        },
      };

      executor.hydrateState(persisted);

      expect(executor.hasPendingBugReport()).toBe(true);
      expect(executor.getPendingBugReport()?.postId).toBe('post-persisted-456');
      expect(executor.getPendingBugReport()?.title).toBe('Persisted Bug');
      expect(executor.getPendingBugReport()?.imageUrls).toEqual(['http://example.com/image.png']);
    });

    it('hydrateState handles null pendingBugReport', () => {
      // Set some initial state
      executor.setPendingBugReport(createSampleBugReport());
      expect(executor.hasPendingBugReport()).toBe(true);

      // Hydrate with null
      executor.hydrateState({ pendingBugReport: null });

      expect(executor.hasPendingBugReport()).toBe(false);
    });

    it('hydrateState handles undefined pendingBugReport', () => {
      // Set some initial state
      executor.setPendingBugReport(createSampleBugReport());
      expect(executor.hasPendingBugReport()).toBe(true);

      // Hydrate with undefined (should default to null)
      executor.hydrateState({});

      expect(executor.hasPendingBugReport()).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // handleReaction - Approval Flow
  // ---------------------------------------------------------------------------

  describe('handleReaction - Approval Flow', () => {
    it('returns false if no pending report', async () => {
      const handled = await executor.handleReaction(
        'post-123',
        '+1',
        'user',
        'added',
        ctx
      );

      expect(handled).toBe(false);
    });

    it('returns false if postId does not match', async () => {
      const report = createSampleBugReport({ postId: 'post-bug-123' });
      executor.setPendingBugReport(report);

      const handled = await executor.handleReaction(
        'wrong-post-id',
        '+1',
        'user',
        'added',
        ctx
      );

      expect(handled).toBe(false);
      expect(executor.hasPendingBugReport()).toBe(true);
    });

    it('returns false if action is removed', async () => {
      const report = createSampleBugReport();
      executor.setPendingBugReport(report);

      const handled = await executor.handleReaction(
        report.postId,
        '+1',
        'user',
        'removed',
        ctx
      );

      expect(handled).toBe(false);
      expect(executor.hasPendingBugReport()).toBe(true);
    });

    it('approves and submits when user reacts with thumbsup', async () => {
      const report = createSampleBugReport();
      executor.setPendingBugReport(report);

      const handled = await executor.handleReaction(
        report.postId,
        '+1',
        'approving-user',
        'added',
        ctx
      );

      expect(handled).toBe(true);
      expect(executor.hasPendingBugReport()).toBe(false);
      expect(bugReportCompleted).not.toBeNull();
      expect(bugReportCompleted?.decision).toBe('approve');
      expect(bugReportCompleted?.report.title).toBe('Test Bug Report');
    });

    it('approves with thumbsup emoji variant', async () => {
      const report = createSampleBugReport();
      executor.setPendingBugReport(report);

      const handled = await executor.handleReaction(
        report.postId,
        'thumbsup',
        'approving-user',
        'added',
        ctx
      );

      expect(handled).toBe(true);
      expect(bugReportCompleted?.decision).toBe('approve');
    });

    it('denies and cancels when user reacts with thumbsdown', async () => {
      const report = createSampleBugReport();
      executor.setPendingBugReport(report);

      const handled = await executor.handleReaction(
        report.postId,
        '-1',
        'denying-user',
        'added',
        ctx
      );

      expect(handled).toBe(true);
      expect(executor.hasPendingBugReport()).toBe(false);
      expect(bugReportCompleted).not.toBeNull();
      expect(bugReportCompleted?.decision).toBe('deny');
    });

    it('denies with thumbsdown emoji variant', async () => {
      const report = createSampleBugReport();
      executor.setPendingBugReport(report);

      const handled = await executor.handleReaction(
        report.postId,
        'thumbsdown',
        'denying-user',
        'added',
        ctx
      );

      expect(handled).toBe(true);
      expect(bugReportCompleted?.decision).toBe('deny');
    });

    it('clears pending state after handling', async () => {
      const report = createSampleBugReport();
      executor.setPendingBugReport(report);
      expect(executor.hasPendingBugReport()).toBe(true);

      await executor.handleReaction(
        report.postId,
        '+1',
        'user',
        'added',
        ctx
      );

      expect(executor.hasPendingBugReport()).toBe(false);
      expect(executor.getPendingBugReport()).toBeNull();
    });

    it('ignores unrelated emoji reactions', async () => {
      const report = createSampleBugReport();
      executor.setPendingBugReport(report);

      const handled = await executor.handleReaction(
        report.postId,
        'smile',
        'user',
        'added',
        ctx
      );

      expect(handled).toBe(false);
      expect(executor.hasPendingBugReport()).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // handleBugReportResponse
  // ---------------------------------------------------------------------------

  describe('handleBugReportResponse', () => {
    it('returns false if no pending report', async () => {
      const handled = await executor.handleBugReportResponse(
        'post-123',
        'approve',
        'user',
        ctx
      );

      expect(handled).toBe(false);
    });

    it('returns false if postId does not match', async () => {
      const report = createSampleBugReport({ postId: 'post-bug-123' });
      executor.setPendingBugReport(report);

      const handled = await executor.handleBugReportResponse(
        'wrong-post-id',
        'approve',
        'user',
        ctx
      );

      expect(handled).toBe(false);
      expect(executor.hasPendingBugReport()).toBe(true);
    });

    it('handles approve decision', async () => {
      const report = createSampleBugReport();
      executor.setPendingBugReport(report);

      const handled = await executor.handleBugReportResponse(
        report.postId,
        'approve',
        'approver',
        ctx
      );

      expect(handled).toBe(true);
      expect(ctx.platform.updatePost).toHaveBeenCalled();
      expect(bugReportCompleted?.decision).toBe('approve');
    });

    it('handles deny decision', async () => {
      const report = createSampleBugReport();
      executor.setPendingBugReport(report);

      const handled = await executor.handleBugReportResponse(
        report.postId,
        'deny',
        'denier',
        ctx
      );

      expect(handled).toBe(true);
      expect(ctx.platform.updatePost).toHaveBeenCalled();
      expect(bugReportCompleted?.decision).toBe('deny');
    });

    it('updates post with approval message', async () => {
      const report = createSampleBugReport();
      executor.setPendingBugReport(report);

      await executor.handleBugReportResponse(
        report.postId,
        'approve',
        'approver',
        ctx
      );

      // The updatePost should have been called with a message containing "submitted"
      const updatePostMock = ctx.platform.updatePost as ReturnType<typeof mock>;
      expect(updatePostMock).toHaveBeenCalled();
      const callArgs = updatePostMock.mock.calls[0];
      expect(callArgs[0]).toBe(report.postId);
      expect(callArgs[1]).toContain('submitted');
    });

    it('updates post with cancellation message', async () => {
      const report = createSampleBugReport();
      executor.setPendingBugReport(report);

      await executor.handleBugReportResponse(
        report.postId,
        'deny',
        'denier',
        ctx
      );

      const updatePostMock = ctx.platform.updatePost as ReturnType<typeof mock>;
      expect(updatePostMock).toHaveBeenCalled();
      const callArgs = updatePostMock.mock.calls[0];
      expect(callArgs[0]).toBe(report.postId);
      expect(callArgs[1]).toContain('cancelled');
    });
  });

  // ---------------------------------------------------------------------------
  // Event Emission
  // ---------------------------------------------------------------------------

  describe('Event Emission', () => {
    it('emits bug-report:complete event on approval', async () => {
      const report = createSampleBugReport({
        title: 'Event Test Bug',
        body: 'Event test body',
      });
      executor.setPendingBugReport(report);

      await executor.handleBugReportResponse(
        report.postId,
        'approve',
        'user',
        ctx
      );

      expect(bugReportCompleted).not.toBeNull();
      expect(bugReportCompleted?.decision).toBe('approve');
      expect(bugReportCompleted?.report.title).toBe('Event Test Bug');
      expect(bugReportCompleted?.report.body).toBe('Event test body');
    });

    it('emits bug-report:complete event on denial', async () => {
      const report = createSampleBugReport({
        title: 'Denied Bug',
      });
      executor.setPendingBugReport(report);

      await executor.handleBugReportResponse(
        report.postId,
        'deny',
        'user',
        ctx
      );

      expect(bugReportCompleted).not.toBeNull();
      expect(bugReportCompleted?.decision).toBe('deny');
      expect(bugReportCompleted?.report.title).toBe('Denied Bug');
    });

    it('does not emit event when no events emitter provided', async () => {
      // Create executor without events
      const executorNoEvents = new BugReportExecutor({
        registerPost: () => {},
        updateLastMessage: () => {},
        // No events parameter
      });

      const report = createSampleBugReport();
      executorNoEvents.setPendingBugReport(report);

      // Should not throw even without events
      const handled = await executorNoEvents.handleBugReportResponse(
        report.postId,
        'approve',
        'user',
        ctx
      );

      expect(handled).toBe(true);
      // bugReportCompleted should still be null since this executor has no events
      // (the global bugReportCompleted was set up for the main executor)
    });
  });

  // ---------------------------------------------------------------------------
  // Error Handling
  // ---------------------------------------------------------------------------

  describe('Error Handling', () => {
    it('handles updatePost failure gracefully', async () => {
      const failingPlatform = createMockPlatform();
      (failingPlatform.updatePost as ReturnType<typeof mock>).mockImplementation(
        async () => {
          throw new Error('Platform error');
        }
      );

      const failingCtx = createTestContext(failingPlatform);
      const report = createSampleBugReport();
      executor.setPendingBugReport(report);

      // Should not throw
      const handled = await executor.handleBugReportResponse(
        report.postId,
        'approve',
        'user',
        failingCtx
      );

      // Should still return true and clear state despite update failure
      expect(handled).toBe(true);
      expect(executor.hasPendingBugReport()).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Report with Error Context
  // ---------------------------------------------------------------------------

  describe('Report with Error Context', () => {
    it('preserves error context in bug report', () => {
      const errorContext = {
        postId: 'error-post-id',
        message: 'An error occurred',
        timestamp: new Date(),
      };

      const report = createSampleBugReport({ errorContext });
      executor.setPendingBugReport(report);

      const retrieved = executor.getPendingBugReport();
      expect(retrieved?.errorContext).toBeDefined();
      expect(retrieved?.errorContext?.postId).toBe('error-post-id');
      expect(retrieved?.errorContext?.message).toBe('An error occurred');
    });

    it('handles report with image urls', () => {
      const report = createSampleBugReport({
        imageUrls: ['http://example.com/img1.png', 'http://example.com/img2.png'],
      });
      executor.setPendingBugReport(report);

      const retrieved = executor.getPendingBugReport();
      expect(retrieved?.imageUrls).toHaveLength(2);
      expect(retrieved?.imageUrls[0]).toBe('http://example.com/img1.png');
    });

    it('handles report with image errors', () => {
      const report = createSampleBugReport({
        imageErrors: ['Failed to upload image 1', 'Failed to upload image 2'],
      });
      executor.setPendingBugReport(report);

      const retrieved = executor.getPendingBugReport();
      expect(retrieved?.imageErrors).toHaveLength(2);
      expect(retrieved?.imageErrors[0]).toBe('Failed to upload image 1');
    });
  });
});
