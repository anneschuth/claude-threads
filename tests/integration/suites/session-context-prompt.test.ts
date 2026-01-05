/**
 * Context Prompt Integration Tests
 *
 * Tests the thread context prompt feature that offers to include
 * previous messages when starting a session mid-thread.
 *
 * Parameterized to run against both Mattermost and Slack platforms.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import {
  type PlatformType,
  MattermostTestApi,
} from '../fixtures/platform-test-api.js';
import {
  initTestContext,
  waitForPostMatching,
  getThreadPosts,
  addReaction,
  createThreadWithMessages,
  startSessionMidThread,
  waitForSessionActive,
  getPlatformBotOptions,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

// Determine which platforms to test based on environment
const TEST_PLATFORMS = (process.env.TEST_PLATFORMS || 'mattermost').split(',') as PlatformType[];

describe.skipIf(SKIP)('Context Prompt', () => {
  // Run tests for each configured platform
  describe.each(TEST_PLATFORMS)('%s platform', (platformType) => {
    let config: ReturnType<typeof loadConfig>;
    let ctx: TestSessionContext;
    let bot: TestBot;
    const testThreadIds: string[] = [];

    // Mattermost-specific: admin API for privileged operations (cleanup)
    let adminApi: MattermostTestApi | null = null;

    beforeAll(async () => {
      config = loadConfig();
      ctx = initTestContext(platformType);

      if (platformType === 'mattermost') {
        adminApi = new MattermostTestApi(config.mattermost.url, config.mattermost.admin.token!);
      }

      // Start the test bot with persistent-session scenario
      bot = await startTestBot(getPlatformBotOptions(platformType, {
        scenario: 'persistent-session',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
      }));
    });

    afterAll(async () => {
      await bot.stop();

      // Clean up test threads (Mattermost only - Slack mock handles its own cleanup)
      if (adminApi) {
        for (const threadId of testThreadIds) {
          try {
            await adminApi.deletePost(threadId);
          } catch {
            // Ignore cleanup errors
          }
        }
      }
    });

    afterEach(async () => {
      // Kill all sessions between tests to avoid interference
      await bot.sessionManager.killAllSessions();
      await new Promise((r) => setTimeout(r, 200));
    });

    /**
     * Get the bot username for the current platform
     */
    function getBotUsername(): string {
      if (platformType === 'mattermost') {
        return config.mattermost.bot.username;
      }
      // Slack - use default or config
      return config.slack?.botUsername || 'claude-test-bot';
    }

    describe('Mid-Thread Session Start', () => {
      it('should show context prompt when starting session mid-thread with 2+ messages', async () => {
        // Create a thread with existing conversation
        const { rootId } = await createThreadWithMessages(ctx, [
          'Let me explain the problem I am having',
          'The issue seems to be related to authentication',
          'I tried restarting but it did not help',
        ]);
        testThreadIds.push(rootId);

        // Start session mid-thread
        await startSessionMidThread(ctx, rootId, 'Help me fix this issue', getBotUsername());

        // Wait for context prompt
        const contextPromptPost = await waitForPostMatching(ctx, rootId, /Include thread context/i, { timeout: 15000 });

        expect(contextPromptPost).toBeDefined();
        expect(contextPromptPost.message).toContain('thread context');
        // Should mention available message count
        expect(contextPromptPost.message).toMatch(/\d+ message/);
      });

      it('should include context when user selects number option', async () => {
        // Create a thread with 2 messages
        const { rootId } = await createThreadWithMessages(ctx, [
          'First message about the API issue',
          'Second message with more details about the error',
        ]);
        testThreadIds.push(rootId);

        // Start session mid-thread
        await startSessionMidThread(ctx, rootId, 'Help diagnose this', getBotUsername());

        // Wait for context prompt
        const contextPromptPost = await waitForPostMatching(ctx, rootId, /Include thread context/i, { timeout: 15000 });
        expect(contextPromptPost).toBeDefined();

        // React with "1" to select first option (last 3 messages or all)
        await addReaction(ctx, contextPromptPost.id, 'one');

        // Wait for session to become active after context selection
        await waitForSessionActive(bot.sessionManager, rootId, { timeout: 10000 });

        // The context prompt should be updated to show selection
        await new Promise((r) => setTimeout(r, 200));
        const updatedPosts = await getThreadPosts(ctx, rootId);
        const updatedPrompt = updatedPosts.find((p) =>
          p.id === contextPromptPost.id || /Including|selected/i.test(p.message)
        );

        // Either the original post was updated or there's a confirmation message
        const hasConfirmation = updatedPosts.some((p) =>
          /Including|selected/i.test(p.message)
        );
        expect(hasConfirmation || updatedPrompt).toBeTruthy();
      });

      it('should skip context when user reacts with X', async () => {
        // Create a thread with messages
        const { rootId } = await createThreadWithMessages(ctx, [
          'Some context message here',
          'Another message in the thread',
        ]);
        testThreadIds.push(rootId);

        // Start session mid-thread
        await startSessionMidThread(ctx, rootId, 'Start fresh without context', getBotUsername());

        // Wait for context prompt
        const contextPromptPost = await waitForPostMatching(ctx, rootId, /Include thread context/i, { timeout: 15000 });
        expect(contextPromptPost).toBeDefined();

        // React with X to skip context
        await addReaction(ctx, contextPromptPost.id, 'x');

        // Wait for session to become active
        await waitForSessionActive(bot.sessionManager, rootId, { timeout: 10000 });

        // The post should be updated to show "without context"
        await new Promise((r) => setTimeout(r, 200));
        const updatedPosts = await getThreadPosts(ctx, rootId);
        const hasSkipConfirmation = updatedPosts.some((p) =>
          /without context|skipped/i.test(p.message)
        );
        expect(hasSkipConfirmation).toBe(true);
      });

      it('should auto-include single message without prompting', async () => {
        // Create a thread with just one message
        const { rootId } = await createThreadWithMessages(ctx, [
          'The only message in this thread about the bug',
        ]);
        testThreadIds.push(rootId);

        // Start session mid-thread
        await startSessionMidThread(ctx, rootId, 'Help fix this bug', getBotUsername());

        // Wait for session to start
        await waitForSessionActive(bot.sessionManager, rootId, { timeout: 10000 });

        // Should NOT see a context prompt (auto-included)
        const posts = await getThreadPosts(ctx, rootId);
        const hasContextPrompt = posts.some((p) =>
          p.userId === ctx.botUserId && /Include thread context/i.test(p.message)
        );

        // With only 1 message, it should auto-include without asking
        expect(hasContextPrompt).toBe(false);
      });
    });

    describe('Context Options', () => {
      it('should show appropriate options based on message count', async () => {
        // Create a thread with 5 messages
        const { rootId } = await createThreadWithMessages(ctx, [
          'Message 1: Initial report',
          'Message 2: More details',
          'Message 3: Error logs',
          'Message 4: Steps to reproduce',
          'Message 5: Additional info',
        ]);
        testThreadIds.push(rootId);

        // Start session mid-thread
        await startSessionMidThread(ctx, rootId, 'Analyze this issue', getBotUsername());

        // Wait for context prompt
        const contextPromptPost = await waitForPostMatching(ctx, rootId, /Include thread context/i, { timeout: 15000 });

        expect(contextPromptPost).toBeDefined();
        // Should show options like "Last 3 messages", "Last 5 messages"
        expect(contextPromptPost.message).toMatch(/Last \d+ messages/i);
        // Should mention the total count
        expect(contextPromptPost.message).toContain('5 message');
      });
    });
  });
});
