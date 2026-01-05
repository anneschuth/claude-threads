/**
 * Session Lifecycle Integration Tests
 *
 * Tests the complete session lifecycle: @mention → session start → response → end
 * Uses the mock Claude CLI for deterministic testing.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import { MattermostTestApi } from '../fixtures/mattermost/api-helpers.js';
import {
  initTestContext,
  startSession,
  waitForBotResponse,
  sendFollowUp,
  getThreadPosts,
  waitForSessionEnded,
  waitForStableBotPostCount,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, stopSharedBot, type TestBot } from '../helpers/bot-starter.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

describe.skipIf(SKIP)('Session Lifecycle', () => {
  let config: ReturnType<typeof loadConfig>;
  let ctx: TestSessionContext;
  let adminApi: MattermostTestApi;
  let bot: TestBot;
  const testThreadIds: string[] = [];

  beforeAll(async () => {
    config = loadConfig();

    // Create admin API for cleanup
    adminApi = new MattermostTestApi(config.mattermost.url, config.mattermost.admin.token!);

    // Initialize test context
    ctx = initTestContext();

    // Start the test bot with simple-response scenario
    bot = await startTestBot({
      scenario: 'simple-response',
      skipPermissions: true,
      debug: process.env.DEBUG === '1',
    });
  });

  afterAll(async () => {
    // Stop the bot
    await stopSharedBot();

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
    await new Promise((r) => setTimeout(r, 200));
  });

  describe('Session Start', () => {
    it('should start a session when @mentioned', async () => {
      const rootPost = await startSession(ctx, 'Hello, what can you do?', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // Wait for bot to respond
      const botResponses = await waitForBotResponse(ctx, rootPost.id, {
        timeout: 30000,
        minResponses: 1,
      });

      expect(botResponses.length).toBeGreaterThanOrEqual(1);

      // Bot should have posted something (session header or response)
      const allPosts = await getThreadPosts(ctx, rootPost.id);
      const botPosts = allPosts.filter((p) => p.user_id === ctx.botUserId);
      expect(botPosts.length).toBeGreaterThanOrEqual(1);
    });

    it('should reject unauthorized users', async () => {
      // Create a second API client for unauthorized user
      // Note: We'll use testuser2 who should NOT be in allowed users
      const user2Token = config.mattermost.testUsers[1]?.token;
      if (!user2Token) {
        console.log('Skipping unauthorized user test - no second test user');
        return;
      }

      // For this test, we need to restart the bot with ONLY testuser1 allowed
      // This explicitly excludes testuser2 from the allowed list
      const user1Username = config.mattermost.testUsers[0]?.username;
      await bot.stop();
      bot = await startTestBot({
        scenario: 'simple-response',
        skipPermissions: true,
        allowedUsersOverride: user1Username ? [user1Username] : [], // Only user1 allowed
      });

      // Create API client for testuser2
      const user2Api = new MattermostTestApi(config.mattermost.url, user2Token);

      // testuser2 tries to start a session (should be rejected since not in allowed list)
      const rootPost = await user2Api.createPost({
        channel_id: ctx.channelId,
        message: `@${config.mattermost.bot.username} hello`,
      });
      testThreadIds.push(rootPost.id);

      // Wait for bot to respond with authorization error
      const botResponse = await waitForBotResponse(ctx, rootPost.id, {
        timeout: 10000,
        minResponses: 1,
      });

      // Bot should post an authorization error message (not start a session)
      expect(botResponse.length).toBeGreaterThanOrEqual(1);
      const responseText = botResponse[0].message.toLowerCase();

      // The bot should indicate the user is not authorized
      expect(
        responseText.includes('not authorized') ||
        responseText.includes('not allowed') ||
        responseText.includes('permission') ||
        responseText.includes('allowed users')
      ).toBe(true);

      // Session should NOT be active for this unauthorized user
      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(false);
    });

    it('should require a prompt with the mention', async () => {
      // Just mention the bot without a prompt
      const rootPost = await ctx.api.createPost({
        channel_id: ctx.channelId,
        message: `@${config.mattermost.bot.username}`,
      });
      testThreadIds.push(rootPost.id);

      // Wait for bot response
      const botResponses = await waitForBotResponse(ctx, rootPost.id, {
        timeout: 30000,
        minResponses: 1,
      });

      // Bot should respond asking for a request
      expect(botResponses.length).toBeGreaterThanOrEqual(1);
      const response = botResponses[0].message;
      expect(response).toMatch(/mention|request/i);
    });
  });

  describe('Follow-up Messages', () => {
    it('should handle follow-up messages in a session', async () => {
      // Restart bot with multi-turn scenario (persistent so we can send follow-ups)
      await bot.stop();
      bot = await startTestBot({
        scenario: 'persistent-session',
        skipPermissions: true,
      });

      // Start a session
      const rootPost = await startSession(ctx, 'Start a conversation', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // Wait for initial response
      const initialResponses = await waitForBotResponse(ctx, rootPost.id, {
        timeout: 30000,
        minResponses: 1,
      });

      // Record initial bot post count
      const initialBotPostCount = initialResponses.length;
      expect(initialBotPostCount).toBeGreaterThanOrEqual(1);

      // Send a follow-up message
      await sendFollowUp(ctx, rootPost.id, 'This is a follow-up message');

      // Wait for follow-up response (should get at least one more bot post)
      const followUpResponses = await waitForBotResponse(ctx, rootPost.id, {
        timeout: 30000,
        minResponses: initialBotPostCount + 1, // Expect at least one more response
      });

      // Bot should have responded to the follow-up
      expect(followUpResponses.length).toBeGreaterThan(initialBotPostCount);
    });

    it('should ignore side conversations (@other_user)', async () => {
      // Restart bot with simple-response to ensure session ends cleanly
      await bot.stop();
      bot = await startTestBot({
        scenario: 'simple-response',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
      });

      // Start a session
      const rootPost = await startSession(ctx, 'Hello bot', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // Wait for initial response
      await waitForBotResponse(ctx, rootPost.id, {
        timeout: 30000,
        minResponses: 1,
      });

      // Wait for session to end (result event processed)
      await waitForSessionEnded(bot.sessionManager, rootPost.id, { timeout: 5000 });

      // Wait for bot post count to stabilize (ensures all buffered content is flushed)
      const initialBotPostCount = await waitForStableBotPostCount(ctx, rootPost.id, {
        timeout: 5000,
        stableFor: 500,
      });

      // Send a message to someone else in the thread (not @mentioning the bot)
      // Using a message that clearly does NOT mention the bot
      await sendFollowUp(ctx, rootPost.id, 'Hey team, what do you think about this?');

      // Wait for bot post count to stabilize again (check for unwanted responses)
      const afterBotPostCount = await waitForStableBotPostCount(ctx, rootPost.id, {
        timeout: 2000,
        stableFor: 500,
      });

      // Bot should not have started a new session or responded to non-mention
      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(false);
      expect(afterBotPostCount).toBe(initialBotPostCount);
    });
  });

  describe('Session End', () => {
    it('should complete session after receiving result event', async () => {
      // Start a session with simple-response (ends after one response)
      await bot.stop();
      bot = await startTestBot({
        scenario: 'simple-response',
        skipPermissions: true,
      });

      const rootPost = await startSession(ctx, 'Give me a simple response', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // Wait for response
      await waitForBotResponse(ctx, rootPost.id, {
        timeout: 30000,
        minResponses: 1,
      });

      // Session should complete (mock sends result event)
      // Wait for the session to end
      await waitForSessionEnded(bot.sessionManager, rootPost.id, { timeout: 5000 });

      // Session should no longer be active
      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(false);

      // Verify bot did respond
      const allPosts = await getThreadPosts(ctx, rootPost.id);
      const botPosts = allPosts.filter((p) => p.user_id === ctx.botUserId);
      expect(botPosts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Concurrent Sessions', () => {
    it('should handle multiple sessions in different threads', async () => {
      // Start two sessions nearly simultaneously
      const rootPost1 = await startSession(ctx, 'Session 1', config.mattermost.bot.username);
      const rootPost2 = await startSession(ctx, 'Session 2', config.mattermost.bot.username);

      testThreadIds.push(rootPost1.id);
      testThreadIds.push(rootPost2.id);

      // Wait for both to respond
      await Promise.all([
        waitForBotResponse(ctx, rootPost1.id, { timeout: 30000, minResponses: 1 }),
        waitForBotResponse(ctx, rootPost2.id, { timeout: 30000, minResponses: 1 }),
      ]);

      // Both should have responses
      const posts1 = await getThreadPosts(ctx, rootPost1.id);
      const posts2 = await getThreadPosts(ctx, rootPost2.id);

      const botPosts1 = posts1.filter((p) => p.user_id === ctx.botUserId);
      const botPosts2 = posts2.filter((p) => p.user_id === ctx.botUserId);

      expect(botPosts1.length).toBeGreaterThanOrEqual(1);
      expect(botPosts2.length).toBeGreaterThanOrEqual(1);
    });
  });
});
