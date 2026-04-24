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

      // Start the test bot with persistent-session scenario
      // This keeps sessions alive so we can test limits
      bot = await startTestBot(getPlatformBotOptions(platformType, {
        scenario: 'persistent-session',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
      }));
    });

    afterAll(async () => {
      await bot.stop();

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
      // Kill all sessions between tests to avoid interference. killAllSessions
      // already awaits — no extra sleep needed.
      await bot.sessionManager.killAllSessions();
    });

    // Five sequential session starts in the rejection test. CI overhead
    // per start fluctuates wildly — observed failure points: 21.9s (20s
    // budget), 32.6s (30s), 42.7s (40s), 62.0s (60s). Variance comes from
    // Mattermost-server-side race conditions under concurrent post creation:
    // even on 10.11.15 there are residual `pq: duplicate key` failures on
    // the Posts table that require client-side retries (3.5s budget each).
    // 90s gives 1.5x headroom over the worst observed value (62s) and
    // sits comfortably under the 120s per-bun-test cap.
    // Local stays at 10s — local Mattermost is fast.
    const startTimeout = process.env.CI ? 90000 : 10000;

    describe('MAX_SESSIONS Limit', () => {
      it('should reject new session when at capacity', async () => {
        const botUsername = platformType === 'mattermost'
          ? (bot?.botUsername ?? config.mattermost.bot.username)
          : 'claude-test-bot';

        // Loop the 5 setup session starts so the test stays compact.
        for (let i = 1; i <= 5; i++) {
          const rp = await startSession(ctx, `Session ${i}`, botUsername);
          testThreadIds.push(rp.id);
          await waitForSessionActive(bot.sessionManager, rp.id, { timeout: startTimeout });
        }

        // Verify we have 5 active sessions
        expect(bot.sessionManager.getActiveThreadIds().length).toBe(5);

        // Try to start sixth session (should be rejected)
        const rootPost6 = await startSession(ctx, 'Session 6 (should fail)', botUsername);
        testThreadIds.push(rootPost6.id);

        // Wait for "Too busy" message
        const busyPost = await waitForPostMatching(ctx, rootPost6.id, /Too busy/i, { timeout: startTimeout });
        expect(busyPost).toBeDefined();
        expect(busyPost.message).toContain('5 sessions active');
        expect(busyPost.message).toContain('Please try again later');

        // Sixth session should NOT be active
        expect(bot.sessionManager.isInSessionThread(rootPost6.id)).toBe(false);

        // Should still have only 5 sessions
        expect(bot.sessionManager.getActiveThreadIds().length).toBe(5);
      });

      it('should allow new session after one ends', async () => {
        const botUsername = platformType === 'mattermost'
          ? (bot?.botUsername ?? config.mattermost.bot.username)
          : 'claude-test-bot';

        // Start 5 sessions to hit the limit
        const rootPosts: string[] = [];
        for (let i = 1; i <= 5; i++) {
          const rootPost = await startSession(ctx, `Session ${i}`, botUsername);
          testThreadIds.push(rootPost.id);
          rootPosts.push(rootPost.id);
          await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: startTimeout });
        }

        // Verify we have 5 sessions
        expect(bot.sessionManager.getActiveThreadIds().length).toBe(5);

        // Kill one session to free up space. killSession already awaits.
        await bot.sessionManager.killSession(rootPosts[0]);

        // Should now have 4 sessions
        expect(bot.sessionManager.getActiveThreadIds().length).toBe(4);

        // Now starting a new session should work
        const newRootPost = await startSession(ctx, 'New session after kill', botUsername);
        testThreadIds.push(newRootPost.id);

        await waitForSessionActive(bot.sessionManager, newRootPost.id, { timeout: startTimeout });

        // New session should be active
        expect(bot.sessionManager.isInSessionThread(newRootPost.id)).toBe(true);

        // Should be back at 5 sessions
        expect(bot.sessionManager.getActiveThreadIds().length).toBe(5);
      });
    });
  });
});
