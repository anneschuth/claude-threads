/**
 * Session Resume Integration Tests
 *
 * Tests session persistence and resume functionality including:
 * - Resume via reaction emoji
 * - Resume after bot restart (simulated by stopping and starting bot)
 *
 * Parameterized to run against both Mattermost and Slack platforms.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import {
  type PlatformType,
  MattermostTestApi,
} from '../fixtures/platform-test-api.js';
import {
  initTestContext,
  startSession,
  waitForBotResponse,
  waitForSessionHeader,
  waitForSessionActive,
  waitForSessionEnded,
  addReaction,
  waitForReactionProcessed,
  getPlatformBotOptions,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

// Determine which platforms to test based on environment
const TEST_PLATFORMS = (process.env.TEST_PLATFORMS || 'mattermost').split(',') as PlatformType[];

describe.skipIf(SKIP)('Session Resume', () => {
  // Run tests for each configured platform
  describe.each(TEST_PLATFORMS)('%s platform', (platformType) => {
    let config: ReturnType<typeof loadConfig>;
    let ctx: TestSessionContext;
    let bot: TestBot;
    const testThreadIds: string[] = [];

    // Mattermost-specific: admin API for privileged operations (cleanup)
    let adminApi: MattermostTestApi | null = null;

    beforeAll(async () => {
      config = loadConfig();
      ctx = initTestContext(platformType);

      if (platformType === 'mattermost') {
        adminApi = new MattermostTestApi(config.mattermost.url, config.mattermost.admin.token!);
      }

      // Start the test bot with persistent-session scenario
      bot = await startTestBot(getPlatformBotOptions(platformType, {
        scenario: 'persistent-session',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
      }));
    });

    afterAll(async () => {
      await bot.stop();

      // Clean up test threads (Mattermost only - Slack mock handles its own cleanup)
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
      // Kill all sessions between tests to avoid interference
      await bot.sessionManager.killAllSessions();
      // Longer delay in CI to ensure cleanup completes before next test
      await new Promise((r) => setTimeout(r, process.env.CI ? 500 : 200));
    });

    /**
     * Get the bot username for the current platform
     */
    function getBotUsername(): string {
      if (platformType === 'mattermost') {
        return config.mattermost.bot.username;
      }
      // Slack - use default or config
      return config.slack?.botUsername || 'claude-test-bot';
    }

    /**
     * Get the test user's username for the current platform
     */
    function getTestUsername(): string {
      if (platformType === 'mattermost') {
        return config.mattermost.testUsers[0].username;
      }
      return config.slack?.testUsers[0]?.username || 'testuser1';
    }

    describe('Resume via Emoji Reaction', () => {
      it('should resume killed session with arrows_counterclockwise reaction on session header', async () => {
        // Start a session
        const rootPost = await startSession(ctx, 'Test resume session', getBotUsername());
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

        // React with arrows_counterclockwise to resume and wait for it to be processed
        await addReaction(ctx, sessionHeaderPost.id, 'arrows_counterclockwise');
        await waitForReactionProcessed(
          ctx,
          bot.sessionManager,
          bot.platformId,
          sessionHeaderPost.id,
          rootPost.id,
          'arrows_counterclockwise',
          getTestUsername(),
          'active',
          { timeout: 15000 }
        );

        // Session should be resumed
        expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);
      });

      it('should resume with arrow_forward emoji', async () => {
        const rootPost = await startSession(ctx, 'Test arrow forward resume', getBotUsername());
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
          getTestUsername(),
          'active',
          { timeout: 15000 }
        );

        expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);
      });

      it('should resume with repeat emoji', async () => {
        const rootPost = await startSession(ctx, 'Test repeat resume', getBotUsername());
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
          getTestUsername(),
          'active',
          { timeout: 15000 }
        );

        expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);
      });

      it('should not resume if session is already active', async () => {
        const rootPost = await startSession(ctx, 'Test no double resume', getBotUsername());
        testThreadIds.push(rootPost.id);

        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 15000 });

        // Get the session header post (the one with logo/version)
        const sessionHeaderPost = await waitForSessionHeader(ctx, rootPost.id, { timeout: 30000, sessionManager: bot.sessionManager });

        // Session is active
        expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);

        // React with arrows_counterclockwise while session is still active
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
        const rootPost = await startSession(ctx, 'Test bot restart resume', getBotUsername());
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
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'persistent-session',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
          clearPersistedSessions: false, // Keep persisted sessions
          sessionsPath: savedSessionsPath, // Reuse same sessions file
        }));

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
});
