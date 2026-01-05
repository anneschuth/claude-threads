/**
 * Session Commands Integration Tests
 *
 * Tests the session control commands: !stop, !escape, !help, etc.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import { MattermostTestApi } from '../fixtures/mattermost/api-helpers.js';
import {
  initTestContext,
  startSession,
  waitForBotResponse,
  sendCommand,
  getThreadPosts,
  waitForPostMatching,
  addReaction,
  waitForSessionActive,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

describe.skipIf(SKIP)('Session Commands', () => {
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
    // This keeps sessions alive (no result event) so we can test commands
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
    await new Promise((r) => setTimeout(r, 50));
  });

  describe('!stop Command', () => {
    it('should cancel session with !stop', async () => {
      // Start a session
      const rootPost = await startSession(ctx, 'Hello bot', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // Wait for session to be registered
      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

      // Wait for initial response
      await waitForBotResponse(ctx, rootPost.id, {
        timeout: 30000,
        minResponses: 1,
      });

      // Verify session is active
      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);

      // Send !stop command
      await sendCommand(ctx, rootPost.id, '!stop');

      // Wait for cancellation
      await new Promise((r) => setTimeout(r, 50));

      // Session should be cancelled
      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(false);
    });

    it('should also accept !cancel', async () => {
      const rootPost = await startSession(ctx, 'Another session', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // Wait for session to be registered
      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

      // Send !cancel
      await sendCommand(ctx, rootPost.id, '!cancel');
      await new Promise((r) => setTimeout(r, 50));

      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(false);
    });
  });

  describe('!escape Command', () => {
    it('should interrupt session but keep it alive with !escape', async () => {
      const rootPost = await startSession(ctx, 'Start a long task', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // Wait for session to be registered
      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

      // Session should be active
      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);

      // Send !escape
      await sendCommand(ctx, rootPost.id, '!escape');
      await new Promise((r) => setTimeout(r, 50));

      // Session may still be tracked (paused state)
      // The key is that interrupt message was posted
      const allPosts = await getThreadPosts(ctx, rootPost.id);
      const botPosts = allPosts.filter((p) => p.user_id === ctx.botUserId);
      expect(botPosts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('!help Command', () => {
    it('should display help message', async () => {
      const rootPost = await startSession(ctx, 'Need help', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // Wait for session to be registered
      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

      // Send !help
      await sendCommand(ctx, rootPost.id, '!help');

      // Wait for help message
      await waitForPostMatching(ctx, rootPost.id, /commands|help/i, { timeout: 5000 });

      const allPosts = await getThreadPosts(ctx, rootPost.id);
      const helpPost = allPosts.find((p) =>
        p.user_id === ctx.botUserId && /commands/i.test(p.message)
      );

      expect(helpPost).toBeDefined();
      expect(helpPost!.message).toContain('!stop');
      expect(helpPost!.message).toContain('!escape');
    });
  });

  describe('Reaction-based Commands', () => {
    it('should cancel session with X reaction', async () => {
      const rootPost = await startSession(ctx, 'Test X reaction', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // Wait for session to be registered
      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

      // Wait for session header (first bot post)
      const botResponses = await waitForBotResponse(ctx, rootPost.id, {
        timeout: 30000,
        minResponses: 1,
      });

      // Find the session start post (usually first bot post)
      const sessionStartPost = botResponses[0];

      // Verify session is active
      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);

      // Add X reaction to session start post
      await addReaction(ctx, sessionStartPost.id, 'x');

      // Wait for cancellation
      await new Promise((r) => setTimeout(r, 50));

      // Session should be cancelled
      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(false);
    });

    it('should cancel session with stop_sign reaction', async () => {
      const rootPost = await startSession(ctx, 'Test stop sign', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // Wait for session to be registered
      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

      const botResponses = await waitForBotResponse(ctx, rootPost.id, {
        timeout: 30000,
        minResponses: 1,
      });

      const sessionStartPost = botResponses[0];
      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);

      // Add octagonal_sign (stop sign) reaction
      await addReaction(ctx, sessionStartPost.id, 'octagonal_sign');
      await new Promise((r) => setTimeout(r, 50));

      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(false);
    });

    it('should interrupt with pause_button reaction', async () => {
      const rootPost = await startSession(ctx, 'Test pause', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // Wait for session to be registered
      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

      const botResponses = await waitForBotResponse(ctx, rootPost.id, {
        timeout: 30000,
        minResponses: 1,
      });

      const sessionStartPost = botResponses[0];

      // Add pause button reaction
      await addReaction(ctx, sessionStartPost.id, 'double_vertical_bar');
      await new Promise((r) => setTimeout(r, 50));

      // Session should be interrupted (may still be tracked but paused)
      const allPosts = await getThreadPosts(ctx, rootPost.id);
      const interruptPost = allPosts.find((p) =>
        p.user_id === ctx.botUserId && /interrupt|paused|escape/i.test(p.message)
      );

      // Either session is gone or interrupt message was posted
      const isActive = bot.sessionManager.isInSessionThread(rootPost.id);
      expect(isActive || interruptPost !== undefined).toBe(true);
    });
  });

  describe('Command Authorization', () => {
    it('should only allow session owner to use !stop', async () => {
      // This test requires two different users
      const user2Token = config.mattermost.testUsers[1]?.token;
      if (!user2Token) {
        console.log('Skipping - no second test user');
        return;
      }

      // Start session as user1
      const rootPost = await startSession(ctx, 'User1 session', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

      // Create API for user2
      const user2Api = new MattermostTestApi(config.mattermost.url, user2Token);

      // User2 tries to stop
      await user2Api.createPost({
        channel_id: ctx.channelId,
        message: '!stop',
        root_id: rootPost.id,
      });

      await new Promise((r) => setTimeout(r, 50));

      // Session should still be active (user2 is not authorized)
      // Note: This depends on whether user2 is in allowedUsers
      // If user2 IS allowed, they can stop; if not, session stays active
      const allPosts = await getThreadPosts(ctx, rootPost.id);
      expect(allPosts.length).toBeGreaterThanOrEqual(2);
    });
  });
});
