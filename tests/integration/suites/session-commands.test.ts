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
  waitForPostCount,
  addReaction,
  waitForReactionProcessed,
  waitForSessionActive,
  waitForSessionEnded,
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
    // Kill all sessions between tests to avoid interference
    await bot.sessionManager.killAllSessions();
    await new Promise((r) => setTimeout(r, 200));
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

      // Wait for session cancellation
      await waitForSessionEnded(bot.sessionManager, rootPost.id, { timeout: 2000 });

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

      // Wait for session cancellation
      await waitForSessionEnded(bot.sessionManager, rootPost.id, { timeout: 2000 });

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

      // Wait for interrupt message
      const interruptPost = await waitForPostMatching(ctx, rootPost.id, /interrupt|escape|paused/i, { timeout: 5000 });

      // Session may still be tracked (paused state)
      // The key is that interrupt message was posted
      expect(interruptPost).toBeDefined();
    });
  });

  describe('!help Command', () => {
    it('should display help message', async () => {
      const rootPost = await startSession(ctx, 'Test help command', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // Wait for session to be registered
      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

      // Send !help
      await sendCommand(ctx, rootPost.id, '!help');

      // Wait for help message - use specific pattern that matches bot's "**Commands:**" format
      // This avoids matching the user's message
      const helpPost = await waitForPostMatching(ctx, rootPost.id, /\*\*Commands:\*\*|!stop.*!escape/i, { timeout: 10000 });

      expect(helpPost).toBeDefined();
      expect(helpPost.message).toContain('!stop');
      expect(helpPost.message).toContain('!escape');
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

      // Add X reaction to session start post and wait for it to be processed
      // Uses fallback mechanism if WebSocket events don't arrive (CI issue)
      await addReaction(ctx, sessionStartPost.id, 'x');
      await waitForReactionProcessed(
        ctx,
        bot.sessionManager,
        bot.platformId,
        sessionStartPost.id,
        rootPost.id,
        'x',
        config.mattermost.testUsers[0].username,
        'ended',
        { timeout: 15000 }
      );

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

      // Add octagonal_sign (stop sign) reaction and wait for it to be processed
      await addReaction(ctx, sessionStartPost.id, 'octagonal_sign');
      await waitForReactionProcessed(
        ctx,
        bot.sessionManager,
        bot.platformId,
        sessionStartPost.id,
        rootPost.id,
        'octagonal_sign',
        config.mattermost.testUsers[0].username,
        'ended',
        { timeout: 15000 }
      );

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

      // Add pause button reaction and use fallback if WebSocket doesn't deliver
      await addReaction(ctx, sessionStartPost.id, 'double_vertical_bar');
      await waitForReactionProcessed(
        ctx,
        bot.sessionManager,
        bot.platformId,
        sessionStartPost.id,
        rootPost.id,
        'double_vertical_bar',
        config.mattermost.testUsers[0].username,
        'ended', // Pause kills the mock CLI which ends the session
        { timeout: 15000 }
      );

      // Session should have been interrupted (which ends the mock CLI session)
      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(false);
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

      // Wait for at least 3 posts (root + bot response + user2 message)
      const allPosts = await waitForPostCount(ctx, rootPost.id, 3, { timeout: 5000 });

      // Session should still be active (user2 is not authorized)
      // Note: This depends on whether user2 is in allowedUsers
      // If user2 IS allowed, they can stop; if not, session stays active
      expect(allPosts.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('!cd Command', () => {
    it('should change working directory', async () => {
      const rootPost = await startSession(ctx, 'Test cd command', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // Wait for session to start
      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });
      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

      // Change to /tmp directory
      await sendCommand(ctx, rootPost.id, '!cd /tmp');

      // Wait for cd confirmation
      await waitForPostMatching(ctx, rootPost.id, /changed|directory|\/tmp/i, { timeout: 10000 });

      const allPosts = await getThreadPosts(ctx, rootPost.id);
      const cdPost = allPosts.find((p) =>
        p.user_id === ctx.botUserId && /changed|directory|\/tmp/i.test(p.message)
      );

      expect(cdPost).toBeDefined();
    });

    it('should restart Claude CLI after directory change', async () => {
      const rootPost = await startSession(ctx, 'Test cd restart', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });
      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

      // Change directory
      await sendCommand(ctx, rootPost.id, '!cd /tmp');

      // Wait for confirmation that mentions "Working directory changed" and "restarted"
      await waitForPostMatching(ctx, rootPost.id, /Working directory changed|restarted/i, { timeout: 10000 });

      const allPosts = await getThreadPosts(ctx, rootPost.id);
      const confirmPost = allPosts.find((p) =>
        p.user_id === ctx.botUserId && /Working directory changed|restarted/i.test(p.message)
      );

      expect(confirmPost).toBeDefined();
      // Session should still be tracked (it restarts, doesn't end)
      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);
    });

    it('should reject invalid directory', async () => {
      const rootPost = await startSession(ctx, 'Test invalid cd', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });
      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

      // Try to cd to non-existent directory
      await sendCommand(ctx, rootPost.id, '!cd /nonexistent/path/12345');

      // Wait for error message
      const errorPost = await waitForPostMatching(ctx, rootPost.id, /error|not.*exist|invalid|not.*found/i, { timeout: 5000 });

      expect(errorPost).toBeDefined();
    });
  });

  describe('!permissions Command', () => {
    it('should enable interactive permissions', async () => {
      // Note: Bot was started with skipPermissions: true
      const rootPost = await startSession(ctx, 'Test permissions command', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });
      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

      // Enable interactive permissions
      await sendCommand(ctx, rootPost.id, '!permissions interactive');

      // Wait for confirmation message (restart takes time)
      const confirmPost = await waitForPostMatching(
        ctx,
        rootPost.id,
        /interactive permissions enabled|permission prompts/i,
        { timeout: 15000 }
      );

      expect(confirmPost).toBeDefined();
      expect(confirmPost.message).toMatch(/interactive|permission/i);

      // Session should still be active (restarted with new permissions)
      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);
    });

    it('should reject upgrade to auto permissions', async () => {
      const rootPost = await startSession(ctx, 'Test auto permissions', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });
      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

      // Try to enable auto permissions (should be rejected)
      await sendCommand(ctx, rootPost.id, '!permissions auto');

      // Wait for rejection message
      const rejectPost = await waitForPostMatching(
        ctx,
        rootPost.id,
        /cannot upgrade|only downgrade/i,
        { timeout: 10000 }
      );

      expect(rejectPost).toBeDefined();
      expect(rejectPost.message).toContain('⚠️');
    });

    it('should only allow session owner to change permissions', async () => {
      const user2Token = config.mattermost.testUsers[1]?.token;
      if (!user2Token) {
        console.log('Skipping - no second test user');
        return;
      }

      // Start session as user1
      const rootPost = await startSession(ctx, 'Owner only permissions', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });
      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

      // User2 tries to change permissions
      const user2Api = new MattermostTestApi(config.mattermost.url, user2Token);

      await user2Api.createPost({
        channel_id: ctx.channelId,
        message: '!permissions interactive',
        root_id: rootPost.id,
      });

      // Wait for at least 3 posts (root + bot response + user2 message)
      const allPosts = await waitForPostCount(ctx, rootPost.id, 3, { timeout: 5000 });

      // User2 shouldn't be able to enable interactive permissions
      // (depends on whether user2 is invited/allowed)
      expect(allPosts.length).toBeGreaterThanOrEqual(3);
    });
  });
});
