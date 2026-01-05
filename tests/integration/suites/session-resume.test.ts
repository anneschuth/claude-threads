/**
 * Session Resume Integration Tests
 *
 * Tests session persistence and resume functionality including:
 * - Resume via 🔄 reaction
 * - Resume after bot restart (simulated by stopping and starting bot)
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import { MattermostTestApi } from '../fixtures/mattermost/api-helpers.js';
import {
  initTestContext,
  startSession,
  waitForBotResponse,
  waitForSessionHeader,
  waitForSessionActive,
  waitForSessionEnded,
  addReaction,
  waitForReactionProcessed,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

describe.skipIf(SKIP)('Session Resume', () => {
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
    await new Promise((r) => setTimeout(r, process.env.CI ? 500 : 200));
  });

  describe('Resume via Emoji Reaction', () => {
    it('should resume killed session with 🔄 reaction on session header', async () => {
      // Start a session
      const rootPost = await startSession(ctx, 'Test resume session', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // Wait for session to be registered
      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 15000 });

      // Get the session header post (the one with logo/version, NOT assistant response)
      const sessionHeaderPost = await waitForSessionHeader(ctx, rootPost.id, { timeout: 30000, sessionManager: bot.sessionManager });

      // Small delay to ensure session is persisted before we kill it
      // (persistence happens asynchronously after first response)
      await new Promise((r) => setTimeout(r, 200));

      // Kill the session but preserve persistence (simulating timeout)
      // Pass false to keep the session persisted for resume
      await bot.sessionManager.killSession(rootPost.id, false);
      await waitForSessionEnded(bot.sessionManager, rootPost.id, { timeout: 5000 });

      // Session should be ended
      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(false);

      // React with 🔄 to resume and wait for it to be processed
      await addReaction(ctx, sessionHeaderPost.id, 'arrows_counterclockwise');
      await waitForReactionProcessed(
        ctx,
        bot.sessionManager,
        bot.platformId,
        sessionHeaderPost.id,
        rootPost.id,
        'arrows_counterclockwise',
        config.mattermost.testUsers[0].username,
        'active',
        { timeout: 15000 }
      );

      // Session should be resumed
      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);
    });

    it('should resume with ▶️ (arrow_forward) emoji', async () => {
      const rootPost = await startSession(ctx, 'Test arrow forward resume', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 15000 });

      // Get the session header post (the one with logo/version)
      const sessionHeaderPost = await waitForSessionHeader(ctx, rootPost.id, { timeout: 30000, sessionManager: bot.sessionManager });

      // Small delay to ensure session is persisted
      await new Promise((r) => setTimeout(r, 200));

      // Kill session but preserve for resume
      await bot.sessionManager.killSession(rootPost.id, false);
      await waitForSessionEnded(bot.sessionManager, rootPost.id, { timeout: 5000 });

      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(false);

      // React with arrow_forward and wait for it to be processed
      await addReaction(ctx, sessionHeaderPost.id, 'arrow_forward');
      await waitForReactionProcessed(
        ctx,
        bot.sessionManager,
        bot.platformId,
        sessionHeaderPost.id,
        rootPost.id,
        'arrow_forward',
        config.mattermost.testUsers[0].username,
        'active',
        { timeout: 15000 }
      );

      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);
    });

    it('should resume with 🔁 (repeat) emoji', async () => {
      const rootPost = await startSession(ctx, 'Test repeat resume', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 15000 });

      // Get the session header post (the one with logo/version)
      const sessionHeaderPost = await waitForSessionHeader(ctx, rootPost.id, { timeout: 30000, sessionManager: bot.sessionManager });

      // Small delay to ensure session is persisted
      await new Promise((r) => setTimeout(r, 200));

      // Kill session but preserve for resume
      await bot.sessionManager.killSession(rootPost.id, false);
      await waitForSessionEnded(bot.sessionManager, rootPost.id, { timeout: 5000 });

      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(false);

      // React with repeat and wait for it to be processed
      await addReaction(ctx, sessionHeaderPost.id, 'repeat');
      await waitForReactionProcessed(
        ctx,
        bot.sessionManager,
        bot.platformId,
        sessionHeaderPost.id,
        rootPost.id,
        'repeat',
        config.mattermost.testUsers[0].username,
        'active',
        { timeout: 15000 }
      );

      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);
    });

    it('should not resume if session is already active', async () => {
      const rootPost = await startSession(ctx, 'Test no double resume', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 15000 });

      // Get the session header post (the one with logo/version)
      const sessionHeaderPost = await waitForSessionHeader(ctx, rootPost.id, { timeout: 30000, sessionManager: bot.sessionManager });

      // Session is active
      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);

      // React with 🔄 while session is still active
      await addReaction(ctx, sessionHeaderPost.id, 'arrows_counterclockwise');

      // Wait a bit for any potential processing
      await new Promise((r) => setTimeout(r, 500));

      // Session should still be active (no duplicate created)
      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);
      expect(bot.sessionManager.getActiveThreadIds().length).toBe(1);
    });
  });

  describe('Resume After Bot Restart', () => {
    it('should auto-resume sessions on bot restart', async () => {
      // Start a session
      const rootPost = await startSession(ctx, 'Test bot restart resume', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 15000 });

      await waitForBotResponse(ctx, rootPost.id, {
        timeout: 30000,
        minResponses: 1,
      });

      // Verify session is active
      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);

      // Save the sessions path before stopping (needed for restart)
      const savedSessionsPath = bot.sessionsPath;

      // Stop the bot but preserve sessions
      await bot.stopAndPreserveSessions();

      // Small delay
      await new Promise((r) => setTimeout(r, 200));

      // Restart the bot without clearing persisted sessions
      // Pass the same sessionsPath to find the persisted session
      bot = await startTestBot({
        scenario: 'persistent-session',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
        clearPersistedSessions: false, // Keep persisted sessions
        sessionsPath: savedSessionsPath, // Reuse same sessions file
      });

      // Wait for initialization and auto-resume
      await new Promise((r) => setTimeout(r, 1000));

      // The session should have been auto-resumed (bot resumes persisted sessions on start)
      // Check that it's either active OR paused (persisted for manual resume)
      const isActive = bot.sessionManager.isInSessionThread(rootPost.id);
      const isPaused = bot.sessionManager.hasPausedSession(rootPost.id);
      expect(isActive || isPaused).toBe(true);
    });
  });
});
