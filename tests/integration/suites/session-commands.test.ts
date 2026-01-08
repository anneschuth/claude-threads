/**
 * Session Commands Integration Tests
 *
 * Tests the session control commands: !stop, !escape, !help, etc.
 *
 * Parameterized to run against both Mattermost and Slack platforms.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import {
  createPlatformTestApi,
  type PlatformTestApi,
  type PlatformType,
  MattermostTestApi,
} from '../fixtures/platform-test-api.js';
import {
  initTestContext,
  initAdminApi,
  startSession,
  waitForBotResponse,
  waitForSessionHeader,
  sendCommand,
  getThreadPosts,
  waitForPostMatching,
  waitForPostCount,
  addReaction,
  waitForReactionProcessed,
  waitForSessionActive,
  waitForSessionEnded,
  getPlatformBotOptions,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

// Determine which platforms to test based on environment
const TEST_PLATFORMS = (process.env.TEST_PLATFORMS || 'mattermost').split(',') as PlatformType[];

describe.skipIf(SKIP)('Session Commands', () => {
  // Run tests for each configured platform
  describe.each(TEST_PLATFORMS)('%s platform', (platformType) => {
    let config: ReturnType<typeof loadConfig>;
    let ctx: TestSessionContext;
    let bot: TestBot;
    const testThreadIds: string[] = [];

    // Mattermost-specific: admin API for privileged operations
    let adminApi: MattermostTestApi | null = null;

    // Helper to get bot username based on platform
    const getBotUsername = () => {
      if (platformType === 'mattermost') {
        return config.mattermost.bot.username;
      }
      return 'claude-test-bot';
    };

    // Helper to get test user username for reaction processing
    const getTestUsername = () => {
      if (platformType === 'mattermost') {
        return config.mattermost.testUsers[0].username;
      }
      return config.slack?.testUsers[0]?.username || 'testuser1';
    };

    // Helper to get user1 username
    const getUser1Username = () => {
      if (platformType === 'mattermost') {
        return config.mattermost.testUsers[0]?.username || 'testuser1';
      }
      return config.slack?.testUsers[0]?.username || 'testuser1';
    };

    // Helper to get user2 token (Mattermost only)
    const getUser2Token = () => {
      if (platformType === 'mattermost') {
        return config.mattermost.testUsers[1]?.token;
      }
      return null;
    };

    // Helper to create a second user API (Mattermost only)
    const createUser2Api = (): PlatformTestApi | null => {
      if (platformType === 'mattermost') {
        const user2Token = config.mattermost.testUsers[1]?.token;
        if (!user2Token) return null;
        return createPlatformTestApi('mattermost', {
          baseUrl: config.mattermost.url,
          token: user2Token,
        });
      }
      return null;
    };

    beforeAll(async () => {
      config = loadConfig();

      // Set up admin API for Mattermost cleanup
      if (platformType === 'mattermost') {
        adminApi = initAdminApi();
      }

      // Initialize test context for the platform
      ctx = initTestContext(platformType);

      // Start the test bot with persistent-session scenario
      // This keeps sessions alive (no result event) so we can test commands
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
      // Kill all sessions between tests to avoid interference
      await bot.sessionManager.killAllSessions();
      // Longer delay in CI to ensure cleanup completes before next test
      await new Promise((r) => setTimeout(r, process.env.CI ? 500 : 200));
    });

    describe('!stop Command', () => {
      it('should cancel session with !stop', async () => {
        // Start a session
        const rootPost = await startSession(ctx, 'Hello bot', getBotUsername());
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
        const rootPost = await startSession(ctx, 'Another session', getBotUsername());
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
        const rootPost = await startSession(ctx, 'Start a long task', getBotUsername());
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
        const rootPost = await startSession(ctx, 'Test help command', getBotUsername());
        testThreadIds.push(rootPost.id);

        // Wait for session to be registered
        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

        await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

        // Send !help
        await sendCommand(ctx, rootPost.id, '!help');

        // Wait for help message - use pattern that matches both Mattermost (**Commands:**) and Slack (*Commands:*)
        // This avoids matching the user's message
        const helpPost = await waitForPostMatching(ctx, rootPost.id, /\*{1,2}Commands:\*{1,2}|!stop.*!escape/i, { timeout: 10000 });

        expect(helpPost).toBeDefined();
        expect(helpPost.message).toContain('!stop');
        expect(helpPost.message).toContain('!escape');
      });
    });

    describe('Reaction-based Commands', () => {
      it('should cancel session with X reaction', async () => {
        const rootPost = await startSession(ctx, 'Test X reaction', getBotUsername());
        testThreadIds.push(rootPost.id);

        // Wait for session to be registered
        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

        // Wait for session header (the post with logo/version, NOT assistant response)
        const sessionHeaderPost = await waitForSessionHeader(ctx, rootPost.id, { timeout: 30000, sessionManager: bot.sessionManager });

        // Verify session is active
        expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);

        // Add X reaction to session header post and wait for it to be processed
        // Uses fallback mechanism if WebSocket events don't arrive (CI issue)
        await addReaction(ctx, sessionHeaderPost.id, 'x');
        await waitForReactionProcessed(
          ctx,
          bot.sessionManager,
          bot.platformId,
          sessionHeaderPost.id,
          rootPost.id,
          'x',
          getTestUsername(),
          'ended',
          { timeout: 15000 }
        );

        // Session should be cancelled
        expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(false);
      });

      it('should cancel session with stop_sign reaction', async () => {
        const rootPost = await startSession(ctx, 'Test stop sign', getBotUsername());
        testThreadIds.push(rootPost.id);

        // Wait for session to be registered
        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

        // Wait for session header (the post with logo/version)
        const sessionHeaderPost = await waitForSessionHeader(ctx, rootPost.id, { timeout: 30000, sessionManager: bot.sessionManager });
        expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);

        // Add octagonal_sign (stop sign) reaction and wait for it to be processed
        await addReaction(ctx, sessionHeaderPost.id, 'octagonal_sign');
        await waitForReactionProcessed(
          ctx,
          bot.sessionManager,
          bot.platformId,
          sessionHeaderPost.id,
          rootPost.id,
          'octagonal_sign',
          getTestUsername(),
          'ended',
          { timeout: 15000 }
        );

        expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(false);
      });

      it('should interrupt with pause_button reaction', async () => {
        const rootPost = await startSession(ctx, 'Test pause', getBotUsername());
        testThreadIds.push(rootPost.id);

        // Wait for session to be registered
        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

        // Wait for session header (the post with logo/version)
        const sessionHeaderPost = await waitForSessionHeader(ctx, rootPost.id, { timeout: 30000, sessionManager: bot.sessionManager });

        // Add pause button reaction and use fallback if WebSocket doesn't deliver
        await addReaction(ctx, sessionHeaderPost.id, 'double_vertical_bar');
        await waitForReactionProcessed(
          ctx,
          bot.sessionManager,
          bot.platformId,
          sessionHeaderPost.id,
          rootPost.id,
          'double_vertical_bar',
          getTestUsername(),
          'ended', // Pause kills the mock CLI which ends the session
          { timeout: 15000 }
        );

        // Session should have been interrupted (which ends the mock CLI session)
        expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(false);
      });
    });

    describe('Command Authorization', () => {
      it('should only allow session-allowed users to use !stop', async () => {
        // This test requires two different users - Mattermost only
        if (platformType !== 'mattermost') {
          console.log('Skipping command authorization test - platform does not support multi-user tokens');
          return;
        }

        // Note: The bot allows ANY globally allowed user to !stop, not just the session owner.
        // To test authorization, we need user2 to NOT be globally allowed.
        const user2Token = getUser2Token();
        if (!user2Token) {
          console.log('Skipping - no second test user');
          return;
        }

        // Stop the default bot and restart with only user1 globally allowed
        await bot.sessionManager.killAllSessions();
        await bot.stop();

        const user1Username = getUser1Username();
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'persistent-session',
          skipPermissions: true,
          allowedUsersOverride: [user1Username], // Only user1 is globally allowed
          debug: process.env.DEBUG === '1',
        }));

        // Start session as user1
        const rootPost = await startSession(ctx, 'User1 session', getBotUsername());
        testThreadIds.push(rootPost.id);

        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });
        await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

        // Verify session is active before user2's attempt
        expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);

        // Create API for user2 (who is NOT globally allowed)
        const user2Api = createUser2Api();
        if (!user2Api) {
          console.log('Skipping - could not create user2 API');
          return;
        }

        // User2 tries to stop (should be ignored since user2 is not in session and not globally allowed)
        const user2Id = config.mattermost.testUsers[1]?.userId || '';
        await user2Api.createPost({
          channelId: ctx.channelId,
          message: '!stop',
          rootId: rootPost.id,
          userId: user2Id,
        });

        // Wait for the message to be processed
        await waitForPostCount(ctx, rootPost.id, 3, { timeout: 5000 });

        // Give the bot time to process the command (if it would)
        await new Promise((r) => setTimeout(r, 500));

        // Session should STILL be active - user2 is not authorized (not in session, not globally allowed)
        expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);
      });
    });

    describe('!cd Command', () => {
      it('should change working directory', async () => {
        const rootPost = await startSession(ctx, 'Test cd command', getBotUsername());
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
          p.userId === ctx.botUserId && /changed|directory|\/tmp/i.test(p.message)
        );

        expect(cdPost).toBeDefined();
      });

      it('should restart Claude CLI after directory change', async () => {
        const rootPost = await startSession(ctx, 'Test cd restart', getBotUsername());
        testThreadIds.push(rootPost.id);

        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });
        await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

        // Change directory
        await sendCommand(ctx, rootPost.id, '!cd /tmp');

        // Wait for confirmation that mentions "Working directory changed" and "restarted"
        await waitForPostMatching(ctx, rootPost.id, /Working directory changed|restarted/i, { timeout: 10000 });

        const allPosts = await getThreadPosts(ctx, rootPost.id);
        const confirmPost = allPosts.find((p) =>
          p.userId === ctx.botUserId && /Working directory changed|restarted/i.test(p.message)
        );

        expect(confirmPost).toBeDefined();
        // Session should still be tracked (it restarts, doesn't end)
        expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);
      });

      it('should reject invalid directory', async () => {
        const rootPost = await startSession(ctx, 'Test invalid cd', getBotUsername());
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
        const rootPost = await startSession(ctx, 'Test permissions command', getBotUsername());
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
        const rootPost = await startSession(ctx, 'Test auto permissions', getBotUsername());
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
        // Accept either Unicode emoji or shortcode (Mattermost converts for mobile)
        expect(rejectPost.message).toMatch(/⚠️|:warning:/);
      });

      it('should only allow session-allowed users to change permissions', async () => {
        // This test requires two different users - Mattermost only
        if (platformType !== 'mattermost') {
          console.log('Skipping permissions authorization test - platform does not support multi-user tokens');
          return;
        }

        // Note: The bot allows session owner OR globally allowed users to change permissions.
        // To test authorization, we need user2 to NOT be globally allowed.
        const user2Token = getUser2Token();
        if (!user2Token) {
          console.log('Skipping - no second test user');
          return;
        }

        // Stop the default bot and restart with only user1 globally allowed
        await bot.sessionManager.killAllSessions();
        await bot.stop();

        const user1Username = getUser1Username();
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'persistent-session',
          skipPermissions: true, // Start with skip so we can test enabling interactive
          allowedUsersOverride: [user1Username], // Only user1 is globally allowed
          debug: process.env.DEBUG === '1',
        }));

        // Start session as user1
        const rootPost = await startSession(ctx, 'Owner only permissions', getBotUsername());
        testThreadIds.push(rootPost.id);

        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });
        await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

        // User2 tries to change permissions (should be rejected - not globally allowed, not session owner)
        const user2Api = createUser2Api();
        if (!user2Api) {
          console.log('Skipping - could not create user2 API');
          return;
        }

        const user2IdForPerm = config.mattermost.testUsers[1]?.userId || '';
        await user2Api.createPost({
          channelId: ctx.channelId,
          message: '!permissions interactive',
          rootId: rootPost.id,
          userId: user2IdForPerm,
        });

        // Wait for the message to be processed
        await waitForPostCount(ctx, rootPost.id, 3, { timeout: 5000 });

        // Give the bot time to process and potentially show error
        await new Promise((r) => setTimeout(r, 500));

        // Check for rejection message - bot should post "only @user1 or allowed users can change permissions"
        const allPosts = await getThreadPosts(ctx, rootPost.id);
        const botPosts = allPosts.filter((p) => p.userId === ctx.botUserId);

        // Look for rejection/error message from bot
        const hasRejectionMessage = botPosts.some((p) =>
          /only.*can change|not authorized|cannot change/i.test(p.message)
        );

        // User2's command should have been rejected
        expect(hasRejectionMessage).toBe(true);
      });
    });
  });
});
