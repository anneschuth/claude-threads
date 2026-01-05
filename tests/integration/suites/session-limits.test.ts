/**
 * Session Limits Integration Tests
 *
 * Tests resource limits: MAX_SESSIONS enforcement.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import { MattermostTestApi } from '../fixtures/mattermost/api-helpers.js';
import {
  initTestContext,
  startSession,
  waitForSessionActive,
  waitForPostMatching,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

describe.skipIf(SKIP)('Session Limits', () => {
  let config: ReturnType<typeof loadConfig>;
  let ctx: TestSessionContext;
  let adminApi: MattermostTestApi;
  let bot: TestBot;
  const testThreadIds: string[] = [];

  beforeAll(async () => {
    config = loadConfig();
    adminApi = new MattermostTestApi(config.mattermost.url, config.mattermost.admin.token!);
    ctx = initTestContext();

    // Start the test bot with persistent-session scenario
    // This keeps sessions alive so we can test limits
    bot = await startTestBot({
      scenario: 'persistent-session',
      skipPermissions: true,
      debug: process.env.DEBUG === '1',
    });
  });

  afterAll(async () => {
    await bot.stop();

    // Clean up test threads
    for (const threadId of testThreadIds) {
      try {
        await adminApi.deletePost(threadId);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  afterEach(async () => {
    // Kill all sessions between tests to avoid interference
    await bot.sessionManager.killAllSessions();
    // Longer delay in CI to ensure cleanup completes before next test
    await new Promise((r) => setTimeout(r, process.env.CI ? 1000 : 200));
  });

  describe('MAX_SESSIONS Limit', () => {
    it('should reject new session when at capacity', async () => {
      // Get the max sessions limit (default is 5)
      // We'll start max sessions, then try to start one more

      // Start first session
      const rootPost1 = await startSession(ctx, 'Session 1', config.mattermost.bot.username);
      testThreadIds.push(rootPost1.id);
      await waitForSessionActive(bot.sessionManager, rootPost1.id, { timeout: 10000 });

      // Start second session
      const rootPost2 = await startSession(ctx, 'Session 2', config.mattermost.bot.username);
      testThreadIds.push(rootPost2.id);
      await waitForSessionActive(bot.sessionManager, rootPost2.id, { timeout: 10000 });

      // Start third session
      const rootPost3 = await startSession(ctx, 'Session 3', config.mattermost.bot.username);
      testThreadIds.push(rootPost3.id);
      await waitForSessionActive(bot.sessionManager, rootPost3.id, { timeout: 10000 });

      // Start fourth session
      const rootPost4 = await startSession(ctx, 'Session 4', config.mattermost.bot.username);
      testThreadIds.push(rootPost4.id);
      await waitForSessionActive(bot.sessionManager, rootPost4.id, { timeout: 10000 });

      // Start fifth session (at limit now)
      const rootPost5 = await startSession(ctx, 'Session 5', config.mattermost.bot.username);
      testThreadIds.push(rootPost5.id);
      await waitForSessionActive(bot.sessionManager, rootPost5.id, { timeout: 10000 });

      // Verify we have 5 active sessions
      expect(bot.sessionManager.getActiveThreadIds().length).toBe(5);

      // Try to start sixth session (should be rejected)
      const rootPost6 = await startSession(ctx, 'Session 6 (should fail)', config.mattermost.bot.username);
      testThreadIds.push(rootPost6.id);

      // Wait for "Too busy" message
      const busyPost = await waitForPostMatching(ctx, rootPost6.id, /Too busy/i, { timeout: 10000 });
      expect(busyPost).toBeDefined();
      expect(busyPost.message).toContain('5 sessions active');
      expect(busyPost.message).toContain('Please try again later');

      // Sixth session should NOT be active
      expect(bot.sessionManager.isInSessionThread(rootPost6.id)).toBe(false);

      // Should still have only 5 sessions
      expect(bot.sessionManager.getActiveThreadIds().length).toBe(5);
    });

    it('should allow new session after one ends', async () => {
      // Start 5 sessions to hit the limit
      // Use longer timeout in CI as starting multiple sessions can be slow
      const rootPosts: string[] = [];

      for (let i = 1; i <= 5; i++) {
        const rootPost = await startSession(ctx, `Session ${i}`, config.mattermost.bot.username);
        testThreadIds.push(rootPost.id);
        rootPosts.push(rootPost.id);
        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 15000 });
      }

      // Verify we have 5 sessions
      expect(bot.sessionManager.getActiveThreadIds().length).toBe(5);

      // Kill one session to free up space
      await bot.sessionManager.killSession(rootPosts[0]);
      await new Promise((r) => setTimeout(r, process.env.CI ? 1000 : 500)); // Longer wait for CI

      // Should now have 4 sessions
      expect(bot.sessionManager.getActiveThreadIds().length).toBe(4);

      // Now starting a new session should work
      const newRootPost = await startSession(ctx, 'New session after kill', config.mattermost.bot.username);
      testThreadIds.push(newRootPost.id);

      // Wait for session to become active (longer timeout in CI due to resource contention)
      await waitForSessionActive(bot.sessionManager, newRootPost.id, { timeout: 20000 });

      // New session should be active
      expect(bot.sessionManager.isInSessionThread(newRootPost.id)).toBe(true);

      // Should be back at 5 sessions
      expect(bot.sessionManager.getActiveThreadIds().length).toBe(5);
    });
  });
});
