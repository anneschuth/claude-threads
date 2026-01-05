/**
 * !kill Command Integration Tests
 *
 * Tests the emergency shutdown command that kills all sessions and exits.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import { MattermostTestApi } from '../fixtures/mattermost/api-helpers.js';
import {
  initTestContext,
  startSession,
  waitForBotResponse,
  waitForPostMatching,
  waitForSessionActive,
  sendFollowUp,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

describe.skipIf(SKIP)('!kill Command', () => {
  let config: ReturnType<typeof loadConfig>;
  let ctx: TestSessionContext;
  let adminApi: MattermostTestApi;
  const testThreadIds: string[] = [];

  beforeAll(async () => {
    config = loadConfig();
    adminApi = new MattermostTestApi(config.mattermost.url, config.mattermost.admin.token!);
    ctx = initTestContext();
  });

  afterAll(async () => {
    // Clean up test threads
    for (const threadId of testThreadIds) {
      try {
        await adminApi.deletePost(threadId);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('Authorization', () => {
    let bot: TestBot;

    afterEach(async () => {
      if (bot) {
        await bot.stop();
      }
    });

    it('should reject !kill from unauthorized user', async () => {
      // Start bot with only testuser1 allowed
      const user1Username = config.mattermost.testUsers[0]?.username || 'testuser1';
      bot = await startTestBot({
        scenario: 'persistent-session',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
        allowedUsersOverride: [user1Username],
      });

      // Start a session first
      const rootPost = await startSession(ctx, 'Test session', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });
      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

      // User2 (not allowed) tries !kill
      const user2Api = new MattermostTestApi(
        config.mattermost.url,
        config.mattermost.testUsers[1]?.token || ''
      );

      if (!config.mattermost.testUsers[1]?.token) {
        console.log('Skipping - no second test user');
        return;
      }

      await user2Api.createPost({
        channel_id: ctx.channelId,
        message: '!kill',
        root_id: rootPost.id,
      });

      // Should get rejection message
      const rejectPost = await waitForPostMatching(ctx, rootPost.id, /only authorized users/i, {
        timeout: 5000,
      });

      expect(rejectPost).toBeDefined();
      expect(rejectPost.message).toContain('⛔');

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
      const bot = await startTestBot({
        scenario: 'persistent-session',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
      });

      // Start two sessions
      const rootPost1 = await startSession(ctx, 'Session 1 for kill test', config.mattermost.bot.username);
      testThreadIds.push(rootPost1.id);

      await waitForBotResponse(ctx, rootPost1.id, { timeout: 30000, minResponses: 1 });
      await waitForSessionActive(bot.sessionManager, rootPost1.id, { timeout: 10000 });

      const rootPost2 = await startSession(ctx, 'Session 2 for kill test', config.mattermost.bot.username);
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
        timeout: 5000,
      });
      expect(shutdownPost1).toBeDefined();

      const shutdownPost2 = await waitForPostMatching(ctx, rootPost2.id, /EMERGENCY SHUTDOWN/i, {
        timeout: 5000,
      });
      expect(shutdownPost2).toBeDefined();

      // Bot should be disconnected (no need to call stop)
    });

    it('should work with @mention !kill syntax', async () => {
      const bot = await startTestBot({
        scenario: 'persistent-session',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
      });

      // Start a session
      const rootPost = await startSession(ctx, 'Kill via mention', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });
      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

      // Send @bot !kill
      await ctx.api.createPost({
        channel_id: ctx.channelId,
        message: `@${config.mattermost.bot.username} !kill`,
        root_id: rootPost.id,
      });

      // Wait for kill to process
      await new Promise((r) => setTimeout(r, 500));

      // Session should be killed
      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(false);

      // Check for emergency shutdown message
      const shutdownPost = await waitForPostMatching(ctx, rootPost.id, /EMERGENCY SHUTDOWN/i, {
        timeout: 5000,
      });
      expect(shutdownPost).toBeDefined();
    });
  });
});
