/**
 * Session Error Handling Integration Tests
 *
 * Tests error scenarios: Claude CLI errors, crashes, and unexpected exits.
 *
 * Parameterized to run against both Mattermost and Slack platforms.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import { MattermostTestApi } from '../fixtures/mattermost/api-helpers.js';
import {
  initTestContext,
  startSession,
  waitForBotResponse,
  waitForSessionActive,
  waitForSessionEnded,
  getThreadPosts,
  getPlatformBotOptions,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';
import { type PlatformType } from '../fixtures/platform-test-api.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

// Determine which platforms to test based on environment
const TEST_PLATFORMS = (process.env.TEST_PLATFORMS || 'mattermost').split(',') as PlatformType[];

describe.skipIf(SKIP)('Session Error Handling', () => {
  describe.each(TEST_PLATFORMS)('%s platform', (platformType) => {
    let config: ReturnType<typeof loadConfig>;
    let ctx: TestSessionContext;
    const testThreadIds: string[] = [];

    // Mattermost-specific: admin API for cleanup
    let adminApi: MattermostTestApi | null = null;

    beforeAll(async () => {
      config = loadConfig();
      ctx = initTestContext(platformType);

      // Set up admin API for Mattermost cleanup
      if (platformType === 'mattermost') {
        adminApi = new MattermostTestApi(config.mattermost.url, config.mattermost.admin.token!);
      }
    });

    afterAll(async () => {
      // Clean up test threads (Mattermost only - has admin API)
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

    describe('Claude CLI Error Response', () => {
      let bot: TestBot;

      afterEach(async () => {
        if (bot) {
          await bot.stop();
        }
      });

      it('should handle error response from Claude CLI', async () => {
        const botUsername = platformType === 'mattermost'
          ? config.mattermost.bot.username
          : 'claude-test-bot';

        // Start bot with error-response scenario
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'error-response',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
        }));

        // Start a session
        const rootPost = await startSession(ctx, 'Trigger an error', botUsername);
        testThreadIds.push(rootPost.id);

        // Wait for the error response
        await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

        // Check for error indication in posts
        const allPosts = await getThreadPosts(ctx, rootPost.id);
        const botPosts = allPosts.filter((p) => p.userId === ctx.botUserId);

        // Should have at least the assistant response
        expect(botPosts.length).toBeGreaterThanOrEqual(1);

        // Wait for session to end after error result
        await waitForSessionEnded(bot.sessionManager, rootPost.id, { timeout: 2000 });
        expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(false);
      });

      it('should display error message to user', async () => {
        const botUsername = platformType === 'mattermost'
          ? config.mattermost.bot.username
          : 'claude-test-bot';

        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'error-response',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
        }));

        const rootPost = await startSession(ctx, 'Show me an error', botUsername);
        testThreadIds.push(rootPost.id);

        // Wait for response (includes error)
        await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

        // Wait for session to end
        await new Promise((r) => setTimeout(r, 500));

        // Check that an error or session end message was posted
        const allPosts = await getThreadPosts(ctx, rootPost.id);
        const botPosts = allPosts.filter((p) => p.userId === ctx.botUserId);

        // Should have assistant message and potentially an error/end message
        expect(botPosts.length).toBeGreaterThanOrEqual(1);

        // Look for any indication of the session ending
        const hasEndMessage = botPosts.some((p) =>
          /error|ended|complete|session/i.test(p.message)
        );

        // Either there's an end message or the session just ended
        expect(hasEndMessage || !bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);
      });
    });

    describe('Claude CLI Unexpected Exit', () => {
      let bot: TestBot;

      afterEach(async () => {
        if (bot) {
          await bot.stop();
        }
      });

      it('should handle session ending with simple response', async () => {
        const botUsername = platformType === 'mattermost'
          ? config.mattermost.bot.username
          : 'claude-test-bot';

        // Use simple-response which sends a result event
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'simple-response',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
        }));

        const rootPost = await startSession(ctx, 'Quick question', botUsername);
        testThreadIds.push(rootPost.id);

        // Wait for response
        await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

        // Wait for session to complete
        await new Promise((r) => setTimeout(r, 500));

        // Session should have ended cleanly
        expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(false);

        // Should have the assistant response
        const allPosts = await getThreadPosts(ctx, rootPost.id);
        const botPosts = allPosts.filter((p) => p.userId === ctx.botUserId);
        expect(botPosts.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe('Session Recovery', () => {
      let bot: TestBot;

      afterEach(async () => {
        if (bot) {
          await bot.stop();
        }
      });

      it('should allow starting new session after error', async () => {
        const botUsername = platformType === 'mattermost'
          ? config.mattermost.bot.username
          : 'claude-test-bot';

        // First session with error
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'error-response',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
        }));

        const rootPost1 = await startSession(ctx, 'First session', botUsername);
        testThreadIds.push(rootPost1.id);

        await waitForBotResponse(ctx, rootPost1.id, { timeout: 30000, minResponses: 1 });

        // Wait for session to be cleaned up after error
        // We use try/catch since the important part is that a new session can start
        try {
          await waitForSessionEnded(bot.sessionManager, rootPost1.id, { timeout: 2000 });
        } catch {
          // Session might already be ended, that's fine
        }

        // Stop and restart with different scenario
        await bot.stop();

        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'persistent-session',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
        }));

        // Start second session
        const rootPost2 = await startSession(ctx, 'Second session', botUsername);
        testThreadIds.push(rootPost2.id);

        // Wait for session to be active (persistent-session keeps it alive)
        await waitForSessionActive(bot.sessionManager, rootPost2.id, { timeout: 10000 });
        await waitForBotResponse(ctx, rootPost2.id, { timeout: 30000, minResponses: 1 });

        // Second session should be active
        expect(bot.sessionManager.isInSessionThread(rootPost2.id)).toBe(true);
      });
    });
  });
});
