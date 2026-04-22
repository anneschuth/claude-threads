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

      // Start the test bot with persistent-session scenario.
      // maxSessions=1 means we only need 1 setup session to hit the cap
      // instead of 5. The cap-check code path is identical regardless of
      // value, so this exercises the same logic in a fraction of the time.
      // Bot is shared across both tests (afterEach killAllSessions resets
      // count to 0) — creating a fresh bot per test caused the first
      // sticky/header API calls to compound with Mattermost's transient
      // 500 retries and starve claude.start() of CPU long enough to hit
      // the test timeout.
      bot = await startTestBot(getPlatformBotOptions(platformType, {
        scenario: 'persistent-session',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
        maxSessions: 1,
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

    // First session start in CI takes 5-10s (Mattermost contention on the
    // initial post + sticky + header). Generous budget but bounded since
    // we now only do ONE session start per test instead of five.
    const startTimeout = process.env.CI ? 20000 : 10000;

    describe('MAX_SESSIONS Limit', () => {
      it('should reject new session when at capacity', async () => {
        const botUsername = platformType === 'mattermost'
          ? config.mattermost.bot.username
          : 'claude-test-bot';

        // Start first (only allowed) session
        const rootPost1 = await startSession(ctx, 'Session 1', botUsername);
        testThreadIds.push(rootPost1.id);
        await waitForSessionActive(bot.sessionManager, rootPost1.id, { timeout: startTimeout });

        // Verify we have 1 active session at the cap
        expect(bot.sessionManager.getActiveThreadIds().length).toBe(1);

        // Try to start a second session — should be rejected
        const rootPost2 = await startSession(ctx, 'Session 2 (should fail)', botUsername);
        testThreadIds.push(rootPost2.id);

        const busyPost = await waitForPostMatching(ctx, rootPost2.id, /Too busy/i, { timeout: startTimeout });
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

        // Cap is 1, so this exercises the kill-frees-slot code path with two
        // session starts instead of five.
        const rootPost1 = await startSession(ctx, 'Session 1', botUsername);
        testThreadIds.push(rootPost1.id);
        await waitForSessionActive(bot.sessionManager, rootPost1.id, { timeout: startTimeout });

        expect(bot.sessionManager.getActiveThreadIds().length).toBe(1);

        // Kill the session to free up space. killSession already awaits.
        await bot.sessionManager.killSession(rootPost1.id);

        // Should now have 0 sessions
        expect(bot.sessionManager.getActiveThreadIds().length).toBe(0);

        // Now starting a new session should work
        const newRootPost = await startSession(ctx, 'New session after kill', botUsername);
        testThreadIds.push(newRootPost.id);

        await waitForSessionActive(bot.sessionManager, newRootPost.id, { timeout: startTimeout });

        // New session should be active
        expect(bot.sessionManager.isInSessionThread(newRootPost.id)).toBe(true);

        // Should be back at 1 session
        expect(bot.sessionManager.getActiveThreadIds().length).toBe(1);
      });
    });
  });
});
