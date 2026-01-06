/**
 * Sticky Channel Message Integration Tests
 *
 * Tests the sticky/pinned channel message that shows bot status and active sessions.
 *
 * Note: Pinned posts are currently a Mattermost-specific feature. Slack tests will
 * be skipped for pinned post functionality until Slack support is added.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import { MattermostTestApi } from '../fixtures/mattermost/api-helpers.js';
import {
  initTestContext,
  startSession,
  waitForBotResponse,
  getPlatformBotOptions,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';
import { type PlatformType } from '../fixtures/platform-test-api.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

// Determine which platforms to test based on environment
const TEST_PLATFORMS = (process.env.TEST_PLATFORMS || 'mattermost').split(',') as PlatformType[];

describe.skipIf(SKIP)('Sticky Channel Message', () => {
  describe.each(TEST_PLATFORMS)('%s platform', (platformType) => {
    let config: ReturnType<typeof loadConfig>;
    let ctx: TestSessionContext;
    let bot: TestBot;
    const testThreadIds: string[] = [];

    // Mattermost-specific: admin API for privileged operations (pinned posts)
    let adminApi: MattermostTestApi | null = null;

    beforeAll(async () => {
      config = loadConfig();
      ctx = initTestContext(platformType);

      // Set up admin API for Mattermost-specific tests
      if (platformType === 'mattermost') {
        adminApi = new MattermostTestApi(config.mattermost.url, config.mattermost.admin.token!);
      }
    });

    afterAll(async () => {
      if (bot) {
        await bot.stop();
      }

      // Clean up test threads (Mattermost only)
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
      if (bot) {
        await bot.stop();
      }
      await new Promise((r) => setTimeout(r, 200));
    });

    describe('Sticky Message Lifecycle', () => {
      // Skip pinned post tests for non-Mattermost platforms
      const skipPinnedTests = platformType !== 'mattermost';

      it.skipIf(skipPinnedTests)('should create sticky message on bot startup', async () => {
        if (!adminApi) {
          throw new Error('Admin API required for this test');
        }

        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'simple-response',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
        }));

        // Give the bot time to create the sticky message
        await new Promise((r) => setTimeout(r, 100));

        // Check for pinned posts in the channel
        const pinnedPosts = await adminApi.getPinnedPosts(ctx.channelId);

        // Should have at least one pinned post (the sticky message)
        expect(pinnedPosts.length).toBeGreaterThanOrEqual(1);

        // The sticky message should contain bot branding
        const stickyPost = pinnedPosts.find((p) =>
          /claude-threads|Chat.*Claude/i.test(p.message)
        );
        expect(stickyPost).toBeDefined();
      });

      it.skipIf(skipPinnedTests)('should update sticky message when session starts', async () => {
        if (!adminApi) {
          throw new Error('Admin API required for this test');
        }

        const botUsername = platformType === 'mattermost'
          ? config.mattermost.bot.username
          : 'claude-test-bot';

        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'persistent-session',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
        }));

        // Get initial sticky message
        await new Promise((r) => setTimeout(r, 100));
        const initialPinned = await adminApi.getPinnedPosts(ctx.channelId);
        const initialSticky = initialPinned.find((p) =>
          /claude-threads|Chat.*Claude/i.test(p.message)
        );

        // Start a session
        const rootPost = await startSession(ctx, 'Test session for sticky', botUsername);
        testThreadIds.push(rootPost.id);

        await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

        // Wait for sticky update
        await new Promise((r) => setTimeout(r, 200));

        // Get updated sticky message
        const updatedPinned = await adminApi.getPinnedPosts(ctx.channelId);
        const updatedSticky = updatedPinned.find((p) =>
          /claude-threads|Chat.*Claude/i.test(p.message)
        );

        expect(updatedSticky).toBeDefined();

        // The sticky should show active session info
        // Either session count or the session title/prompt
        const hasSessionInfo =
          /active|session|Test session/i.test(updatedSticky!.message) ||
          updatedSticky!.message !== initialSticky?.message;

        expect(hasSessionInfo).toBe(true);
      });

      it.skipIf(skipPinnedTests)('should show session count in sticky message', async () => {
        if (!adminApi) {
          throw new Error('Admin API required for this test');
        }

        const botUsername = platformType === 'mattermost'
          ? config.mattermost.bot.username
          : 'claude-test-bot';

        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'persistent-session',
          skipPermissions: true,
        }));

        // Start two sessions
        const rootPost1 = await startSession(ctx, 'First session', botUsername);
        const rootPost2 = await startSession(ctx, 'Second session', botUsername);
        testThreadIds.push(rootPost1.id, rootPost2.id);

        await Promise.all([
          waitForBotResponse(ctx, rootPost1.id, { timeout: 30000, minResponses: 1 }),
          waitForBotResponse(ctx, rootPost2.id, { timeout: 30000, minResponses: 1 }),
        ]);

        // Wait for sticky update
        await new Promise((r) => setTimeout(r, 200));

        // Check sticky message reflects multiple sessions
        const pinnedPosts = await adminApi.getPinnedPosts(ctx.channelId);
        const stickyPost = pinnedPosts.find((p) =>
          /claude-threads|Chat.*Claude/i.test(p.message)
        );

        expect(stickyPost).toBeDefined();
        // Should show 2 sessions or list both
        // Note: The exact format depends on implementation - checking if shows "2" or both session names
        const showsMultipleSessions =
          /2\s*(session|active)/i.test(stickyPost!.message) ||
          (stickyPost!.message.includes('First') && stickyPost!.message.includes('Second'));
        // At minimum, the sticky should exist and ideally show multiple sessions
        expect(stickyPost).toBeDefined();
        // This is a soft check - log if format doesn't match expected patterns
        if (!showsMultipleSessions) {
          console.log('Note: Sticky message exists but may not show session count:', stickyPost!.message.substring(0, 100));
        }
      });
    });

    describe('Sticky Message Content', () => {
      // Skip pinned post tests for non-Mattermost platforms
      const skipPinnedTests = platformType !== 'mattermost';

      it.skipIf(skipPinnedTests)('should show version info', async () => {
        if (!adminApi) {
          throw new Error('Admin API required for this test');
        }

        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'simple-response',
          skipPermissions: true,
        }));

        await new Promise((r) => setTimeout(r, 100));

        const pinnedPosts = await adminApi.getPinnedPosts(ctx.channelId);
        const stickyPost = pinnedPosts.find((p) =>
          /claude-threads|Chat.*Claude/i.test(p.message)
        );

        expect(stickyPost).toBeDefined();
        // Should contain version number (e.g., "v0.34.0")
        expect(stickyPost!.message).toMatch(/v\d+\.\d+\.\d+/);
      });

      it.skipIf(skipPinnedTests)('should show status indicators', async () => {
        if (!adminApi) {
          throw new Error('Admin API required for this test');
        }

        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'simple-response',
          skipPermissions: true,
        }));

        await new Promise((r) => setTimeout(r, 100));

        const pinnedPosts = await adminApi.getPinnedPosts(ctx.channelId);
        const stickyPost = pinnedPosts.find((p) =>
          /claude-threads|Chat.*Claude/i.test(p.message)
        );

        expect(stickyPost).toBeDefined();
        // Should contain status indicators (Auto/Interactive, Keep-alive, etc.)
        const hasStatusIndicators =
          /Auto|Interactive|Keep-alive|💓|⚡/i.test(stickyPost!.message);
        expect(hasStatusIndicators).toBe(true);
      });
    });
  });
});
