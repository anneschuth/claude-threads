/**
 * Session Limits Integration Tests
 *
 * Tests resource limits: MAX_SESSIONS enforcement.
 *
 * Parameterized to run against both Mattermost and Slack platforms.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import { MattermostTestApi } from '../fixtures/mattermost/api-helpers.js';
import {
  initTestContext,
  startSession,
  waitForSessionActive,
  waitForPostMatching,
  getPlatformBotOptions,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';
import { type PlatformType } from '../fixtures/platform-test-api.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

// Determine which platforms to test based on environment
const TEST_PLATFORMS = (process.env.TEST_PLATFORMS || 'mattermost').split(',') as PlatformType[];

describe.skipIf(SKIP)('Session Limits', () => {
  describe.each(TEST_PLATFORMS)('%s platform', (platformType) => {
    let config: ReturnType<typeof loadConfig>;
    let ctx: TestSessionContext;
    let bot: TestBot;
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

    afterEach(async () => {
      if (bot) {
        await bot.stop();
      }
    });

    describe('MAX_SESSIONS Limit', () => {
      it('should reject new session when at capacity', async () => {
        const botUsername = platformType === 'mattermost'
          ? config.mattermost.bot.username
          : 'claude-test-bot';

        // Use a small cap so we only need ONE setup session before hitting it.
        // Previous version started 5 real sessions sequentially under default
        // cap=5, which under CI Mattermost overhead easily blew past 30s.
        // Cap behavior is independent of cap value, so testing with cap=1
        // exercises the same code path in a fraction of the time.
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'persistent-session',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
          maxSessions: 1,
        }));

        // Start first (only allowed) session
        const rootPost1 = await startSession(ctx, 'Session 1', botUsername);
        testThreadIds.push(rootPost1.id);
        await waitForSessionActive(bot.sessionManager, rootPost1.id, { timeout: 15000 });

        // Verify we have 1 active session
        expect(bot.sessionManager.getActiveThreadIds().length).toBe(1);

        // Try to start a second session — should be rejected
        const rootPost2 = await startSession(ctx, 'Session 2 (should fail)', botUsername);
        testThreadIds.push(rootPost2.id);

        const busyPost = await waitForPostMatching(ctx, rootPost2.id, /Too busy/i, { timeout: 15000 });
        expect(busyPost).toBeDefined();
        expect(busyPost.message).toContain('1 sessions active');
        expect(busyPost.message).toContain('Please try again later');

        // Second session should NOT be active
        expect(bot.sessionManager.isInSessionThread(rootPost2.id)).toBe(false);

        // Should still have only 1 session
        expect(bot.sessionManager.getActiveThreadIds().length).toBe(1);
      });

      it('should allow new session after one ends', async () => {
        const botUsername = platformType === 'mattermost'
          ? config.mattermost.bot.username
          : 'claude-test-bot';

        // Same cap=1 trick as above: exercise the kill-frees-slot code path
        // with just two session starts instead of five.
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'persistent-session',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
          maxSessions: 1,
        }));

        // Start one session to hit the (1-session) limit
        const rootPost = await startSession(ctx, 'Session 1', botUsername);
        testThreadIds.push(rootPost.id);
        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 15000 });

        expect(bot.sessionManager.getActiveThreadIds().length).toBe(1);

        // Kill the session to free up space. killSession already awaits.
        await bot.sessionManager.killSession(rootPost.id);

        // Should now have 0 sessions
        expect(bot.sessionManager.getActiveThreadIds().length).toBe(0);

        // Now starting a new session should work
        const newRootPost = await startSession(ctx, 'New session after kill', botUsername);
        testThreadIds.push(newRootPost.id);

        await waitForSessionActive(bot.sessionManager, newRootPost.id, { timeout: 15000 });

        // New session should be active
        expect(bot.sessionManager.isInSessionThread(newRootPost.id)).toBe(true);

        // Should be back at 1 session
        expect(bot.sessionManager.getActiveThreadIds().length).toBe(1);
      });
    });
  });
});
