/**
 * !kill Command Integration Tests
 *
 * Tests the emergency shutdown command that kills all sessions and exits.
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
  startSession,
  waitForBotResponse,
  waitForPostMatching,
  waitForSessionActive,
  sendFollowUp,
  getPlatformBotOptions,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

// Determine which platforms to test based on environment
const TEST_PLATFORMS = (process.env.TEST_PLATFORMS || 'mattermost').split(',') as PlatformType[];

describe.skipIf(SKIP)('!kill Command', () => {
  // Run tests for each configured platform
  describe.each(TEST_PLATFORMS)('%s platform', (platformType) => {
    let config: ReturnType<typeof loadConfig>;
    let ctx: TestSessionContext;
    const testThreadIds: string[] = [];

    // Mattermost-specific: admin API for privileged operations (cleanup)
    let adminApi: MattermostTestApi | null = null;

    beforeAll(async () => {
      config = loadConfig();
      ctx = initTestContext(platformType);

      if (platformType === 'mattermost') {
        adminApi = new MattermostTestApi(config.mattermost.url, config.mattermost.admin.token!);
      }
    });

    afterAll(async () => {
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

    /**
     * Get the first test user's username for the current platform
     */
    function getTestUser1Username(): string {
      if (platformType === 'mattermost') {
        return config.mattermost.testUsers[0]?.username || 'testuser1';
      }
      return config.slack?.testUsers[0]?.username || 'testuser1';
    }

    /**
     * Get the second test user's token for the current platform (Mattermost only)
     * Returns null if not available
     */
    function getTestUser2Token(): string | null {
      if (platformType === 'mattermost') {
        return config.mattermost.testUsers[1]?.token || null;
      }
      // Slack doesn't support per-user tokens in test mode
      return null;
    }

    describe('Authorization', () => {
      let bot: TestBot;

      afterEach(async () => {
        if (bot) {
          await bot.stop();
        }
      });

      it('should reject !kill from unauthorized user', async () => {
        // This test requires multiple test users with different permissions
        // Only available on Mattermost currently
        const user2Token = getTestUser2Token();
        if (!user2Token) {
          console.log('Skipping - no second test user available for this platform');
          return;
        }

        // Start bot with only testuser1 allowed
        const user1Username = getTestUser1Username();
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'persistent-session',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
          allowedUsersOverride: [user1Username],
        }));

        // Start a session first
        const rootPost = await startSession(ctx, 'Test session', getBotUsername());
        testThreadIds.push(rootPost.id);

        await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });
        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

        // User2 (not allowed) tries !kill - Mattermost specific
        const user2Api = new MattermostTestApi(
          config.mattermost.url,
          user2Token
        );

        await user2Api.createPost({
          channel_id: ctx.channelId,
          message: '!kill',
          root_id: rootPost.id,
        });

        // Should get rejection message
        const rejectPost = await waitForPostMatching(ctx, rootPost.id, /only authorized users/i, {
          timeout: 10000,
        });

        expect(rejectPost).toBeDefined();
        expect(rejectPost.message.toLowerCase()).toContain('only authorized users');

        // Session should still be active
        expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);
      });
    });

    describe('Emergency Shutdown', () => {
      // Note: !kill disconnects the bot itself, but we need cleanup in case test fails early
      afterEach(async () => {
        // Ensure env vars are cleared even if test failed before !kill ran
        delete process.env.CLAUDE_PATH;
        delete process.env.CLAUDE_SCENARIO;
        await new Promise((r) => setTimeout(r, 100));
      });

      it('should kill all sessions and notify them', async () => {
        // Start bot
        const bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'persistent-session',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
        }));

        // Start two sessions
        const rootPost1 = await startSession(ctx, 'Session 1 for kill test', getBotUsername());
        testThreadIds.push(rootPost1.id);

        await waitForBotResponse(ctx, rootPost1.id, { timeout: 30000, minResponses: 1 });
        await waitForSessionActive(bot.sessionManager, rootPost1.id, { timeout: 10000 });

        const rootPost2 = await startSession(ctx, 'Session 2 for kill test', getBotUsername());
        testThreadIds.push(rootPost2.id);

        await waitForBotResponse(ctx, rootPost2.id, { timeout: 30000, minResponses: 1 });
        await waitForSessionActive(bot.sessionManager, rootPost2.id, { timeout: 10000 });

        // Verify both sessions are active
        expect(bot.sessionManager.isInSessionThread(rootPost1.id)).toBe(true);
        expect(bot.sessionManager.isInSessionThread(rootPost2.id)).toBe(true);

        // Send !kill command
        await sendFollowUp(ctx, rootPost1.id, '!kill');

        // Wait a bit for the kill to process
        await new Promise((r) => setTimeout(r, 500));

        // Both sessions should be killed
        expect(bot.sessionManager.isInSessionThread(rootPost1.id)).toBe(false);
        expect(bot.sessionManager.isInSessionThread(rootPost2.id)).toBe(false);

        // Check for emergency shutdown message in both threads
        const shutdownPost1 = await waitForPostMatching(ctx, rootPost1.id, /EMERGENCY SHUTDOWN/i, {
          timeout: 10000,
        });
        expect(shutdownPost1).toBeDefined();

        const shutdownPost2 = await waitForPostMatching(ctx, rootPost2.id, /EMERGENCY SHUTDOWN/i, {
          timeout: 10000,
        });
        expect(shutdownPost2).toBeDefined();

        // Bot should be disconnected (no need to call stop)
      });

      it('should work with @mention !kill syntax', async () => {
        const bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'persistent-session',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
        }));

        // Start a session
        const rootPost = await startSession(ctx, 'Kill via mention', getBotUsername());
        testThreadIds.push(rootPost.id);

        await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });
        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

        // Send @bot !kill
        await ctx.api.createPost({
          channelId: ctx.channelId,
          message: `@${getBotUsername()} !kill`,
          rootId: rootPost.id,
          userId: ctx.testUserId,
        });

        // Wait for kill to process
        await new Promise((r) => setTimeout(r, 500));

        // Session should be killed
        expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(false);

        // Check for emergency shutdown message
        const shutdownPost = await waitForPostMatching(ctx, rootPost.id, /EMERGENCY SHUTDOWN/i, {
          timeout: 10000,
        });
        expect(shutdownPost).toBeDefined();
      });
    });
  });
});
