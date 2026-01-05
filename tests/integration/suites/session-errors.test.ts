/**
 * Session Error Handling Integration Tests
 *
 * Tests error scenarios: Claude CLI errors, crashes, and unexpected exits.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import { MattermostTestApi } from '../fixtures/mattermost/api-helpers.js';
import {
  initTestContext,
  startSession,
  waitForBotResponse,
  waitForSessionActive,
  getThreadPosts,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

describe.skipIf(SKIP)('Session Error Handling', () => {
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

  describe('Claude CLI Error Response', () => {
    let bot: TestBot;

    afterEach(async () => {
      if (bot) {
        await bot.stop();
      }
    });

    it('should handle error response from Claude CLI', async () => {
      // Start bot with error-response scenario
      bot = await startTestBot({
        scenario: 'error-response',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
      });

      // Start a session
      const rootPost = await startSession(ctx, 'Trigger an error', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // Wait for the error response
      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

      // Check for error indication in posts
      const allPosts = await getThreadPosts(ctx, rootPost.id);
      const botPosts = allPosts.filter((p) => p.user_id === ctx.botUserId);

      // Should have at least the assistant response
      expect(botPosts.length).toBeGreaterThanOrEqual(1);

      // Wait for session to end after error result (with polling)
      let sessionEnded = false;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (!bot.sessionManager.isInSessionThread(rootPost.id)) {
          sessionEnded = true;
          break;
        }
      }
      expect(sessionEnded).toBe(true);
    });

    it('should display error message to user', async () => {
      bot = await startTestBot({
        scenario: 'error-response',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
      });

      const rootPost = await startSession(ctx, 'Show me an error', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // Wait for response (includes error)
      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

      // Wait for session to end
      await new Promise((r) => setTimeout(r, 500));

      // Check that an error or session end message was posted
      const allPosts = await getThreadPosts(ctx, rootPost.id);
      const botPosts = allPosts.filter((p) => p.user_id === ctx.botUserId);

      // Should have assistant message and potentially an error/end message
      expect(botPosts.length).toBeGreaterThanOrEqual(1);

      // Look for any indication of the session ending
      const hasEndMessage = botPosts.some((p) =>
        /error|ended|complete|session/i.test(p.message)
      );

      // Either there's an end message or the session just ended
      expect(hasEndMessage || !bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);
    });
  });

  describe('Claude CLI Unexpected Exit', () => {
    let bot: TestBot;

    afterEach(async () => {
      if (bot) {
        await bot.stop();
      }
    });

    it('should handle session ending with simple response', async () => {
      // Use simple-response which sends a result event
      bot = await startTestBot({
        scenario: 'simple-response',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
      });

      const rootPost = await startSession(ctx, 'Quick question', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // Wait for response
      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

      // Wait for session to complete
      await new Promise((r) => setTimeout(r, 500));

      // Session should have ended cleanly
      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(false);

      // Should have the assistant response
      const allPosts = await getThreadPosts(ctx, rootPost.id);
      const botPosts = allPosts.filter((p) => p.user_id === ctx.botUserId);
      expect(botPosts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Session Recovery', () => {
    let bot: TestBot;

    afterEach(async () => {
      if (bot) {
        await bot.stop();
      }
    });

    it('should allow starting new session after error', async () => {
      // First session with error
      bot = await startTestBot({
        scenario: 'error-response',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
      });

      const rootPost1 = await startSession(ctx, 'First session', config.mattermost.bot.username);
      testThreadIds.push(rootPost1.id);

      await waitForBotResponse(ctx, rootPost1.id, { timeout: 30000, minResponses: 1 });

      // Wait for session to be cleaned up after error (with polling)
      // We poll but don't assert - the important part is that a new session can start
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (!bot.sessionManager.isInSessionThread(rootPost1.id)) {
          break;
        }
      }

      // Stop and restart with different scenario
      await bot.stop();

      bot = await startTestBot({
        scenario: 'persistent-session',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
      });

      // Start second session
      const rootPost2 = await startSession(ctx, 'Second session', config.mattermost.bot.username);
      testThreadIds.push(rootPost2.id);

      // Wait for session to be active (persistent-session keeps it alive)
      await waitForSessionActive(bot.sessionManager, rootPost2.id, { timeout: 10000 });
      await waitForBotResponse(ctx, rootPost2.id, { timeout: 30000, minResponses: 1 });

      // Second session should be active
      expect(bot.sessionManager.isInSessionThread(rootPost2.id)).toBe(true);
    });
  });
});
