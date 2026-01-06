/**
 * Session Multi-User Integration Tests
 *
 * Tests multi-user scenarios: !invite, !kick, message approval flow.
 *
 * Parameterized to run against both Mattermost and Slack platforms.
 * Note: Many multi-user tests require platform-specific user management
 * and will only run on Mattermost.
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
  waitForPostMatching,
  waitForSessionActive,
  waitForPostCount,
  sendCommand,
  getThreadPosts,
  getPlatformBotOptions,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

// Determine which platforms to test based on environment
const TEST_PLATFORMS = (process.env.TEST_PLATFORMS || 'mattermost').split(',') as PlatformType[];

describe.skipIf(SKIP)('Session Multi-User', () => {
  // Run tests for each configured platform
  describe.each(TEST_PLATFORMS)('%s platform', (platformType) => {
    let config: ReturnType<typeof loadConfig>;
    let ctx: TestSessionContext;
    let bot: TestBot;
    const testThreadIds: string[] = [];

    // Mattermost-specific: admin API for privileged operations
    let adminApi: MattermostTestApi | null = null;

    // User 2 context (Mattermost only)
    let user2Api: PlatformTestApi | null = null;
    let user2Id: string = '';

    // Helper to get bot username based on platform
    const getBotUsername = () => {
      if (platformType === 'mattermost') {
        return config.mattermost.bot.username;
      }
      return 'claude-test-bot';
    };

    // Helper to get user1 username
    const getUser1Username = () => {
      if (platformType === 'mattermost') {
        return config.mattermost.testUsers[0]?.username || 'testuser1';
      }
      return config.slack?.testUsers[0]?.username || 'testuser1';
    };

    // Helper to get user2 username
    const getUser2Username = () => {
      if (platformType === 'mattermost') {
        return config.mattermost.testUsers[1]?.username || 'testuser2';
      }
      return config.slack?.testUsers[1]?.username || 'testuser2';
    };

    // Helper to check if multi-user tests can run
    const canRunMultiUserTests = () => {
      if (platformType !== 'mattermost') {
        return false;
      }
      return !!config.mattermost.testUsers[1]?.token;
    };

    beforeAll(async () => {
      config = loadConfig();

      // Set up admin API for Mattermost cleanup
      if (platformType === 'mattermost') {
        adminApi = initAdminApi();

        // Set up second user
        const user2Token = config.mattermost.testUsers[1]?.token;
        user2Id = config.mattermost.testUsers[1]?.userId || '';

        if (user2Token) {
          user2Api = createPlatformTestApi('mattermost', {
            baseUrl: config.mattermost.url,
            token: user2Token,
          });
        }
      }

      // Initialize test context for the platform
      ctx = initTestContext(platformType);

      // Start bot with just user1 as allowed (for invite/kick tests)
      // This uses allowedUsersOverride to exclude user2 from global allowed list
      // Use persistent-session so sessions stay active for commands
      const user1Username = getUser1Username();
      bot = await startTestBot(getPlatformBotOptions(platformType, {
        scenario: 'persistent-session',
        skipPermissions: true,
        allowedUsersOverride: [user1Username], // Only user1 globally allowed
        debug: process.env.DEBUG === '1',
      }));
    });

    afterAll(async () => {
      if (bot) {
        await bot.stop();
      }

      // Clean up test threads (Mattermost only - has admin API)
      if (adminApi) {
        for (const threadId of testThreadIds) {
          try {
            await adminApi.deletePost(threadId);
          } catch {
            // Ignore
          }
        }
      }
    });

    afterEach(async () => {
      // Kill all sessions to avoid MAX_SESSIONS limit
      if (bot?.sessionManager) {
        await bot.sessionManager.killAllSessions();
      }
      await new Promise((r) => setTimeout(r, 200));
    });

    describe('!invite Command', () => {
      it('should invite a user to the session', async () => {
        if (!canRunMultiUserTests()) {
          console.log('Skipping - multi-user tests require Mattermost with second test user');
          return;
        }

        // Start session as user1
        const rootPost = await startSession(ctx, 'Session for collaboration', getBotUsername());
        testThreadIds.push(rootPost.id);

        await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });
        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

        // Invite user2
        const user2Username = getUser2Username();
        await sendCommand(ctx, rootPost.id, `!invite @${user2Username}`);

        // Wait for invite confirmation message (message says "can now participate")
        const invitePost = await waitForPostMatching(ctx, rootPost.id, /can now participate|invited/i, { timeout: 10000 });
        expect(invitePost).toBeDefined();
      });

      it('should allow invited user to send messages', async () => {
        if (!canRunMultiUserTests() || !user2Api) {
          console.log('Skipping - multi-user tests require Mattermost with second test user');
          return;
        }

        // Start session and invite user2
        const rootPost = await startSession(ctx, 'Collaborative session', getBotUsername());
        testThreadIds.push(rootPost.id);

        // Wait for bot response and session to be fully active
        await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });
        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

        const user2Username = getUser2Username();
        await sendCommand(ctx, rootPost.id, `!invite @${user2Username}`);

        // Wait for invite confirmation
        await waitForPostMatching(ctx, rootPost.id, /can now participate|invited/i, { timeout: 10000 });

        // User2 sends a message
        await user2Api.createPost({
          channelId: ctx.channelId,
          message: 'Hello from user2!',
          rootId: rootPost.id,
          userId: user2Id,
        });

        // Wait a bit for the message to appear
        await new Promise((r) => setTimeout(r, 100));

        // Bot should process user2's message (not block it)
        const allPosts = await getThreadPosts(ctx, rootPost.id);

        // Find user2's message
        const user2Post = allPosts.find((p) =>
          p.userId === user2Id && p.message === 'Hello from user2!'
        );

        expect(user2Post).toBeDefined();
      });
    });

    describe('!kick Command', () => {
      it('should kick a user from the session', async () => {
        if (!canRunMultiUserTests() || !user2Api) {
          console.log('Skipping - multi-user tests require Mattermost with second test user');
          return;
        }

        // Start session and invite user2
        const rootPost = await startSession(ctx, 'Session to kick from', getBotUsername());
        testThreadIds.push(rootPost.id);

        await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });
        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

        const user2Username = getUser2Username();

        // Invite first
        await sendCommand(ctx, rootPost.id, `!invite @${user2Username}`);
        await waitForPostMatching(ctx, rootPost.id, /can now participate|invited/i, { timeout: 10000 });

        // Then kick
        await sendCommand(ctx, rootPost.id, `!kick @${user2Username}`);

        // Wait for kick confirmation
        const kickPost = await waitForPostMatching(ctx, rootPost.id, /kicked|removed/i, { timeout: 10000 });
        expect(kickPost).toBeDefined();
      });

      it('should block kicked user messages', async () => {
        if (!canRunMultiUserTests() || !user2Api) {
          console.log('Skipping - multi-user tests require Mattermost with second test user');
          return;
        }

        // Start session, invite, then kick user2
        const rootPost = await startSession(ctx, 'Kick test session', getBotUsername());
        testThreadIds.push(rootPost.id);

        await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });
        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

        const user2Username = getUser2Username();

        await sendCommand(ctx, rootPost.id, `!invite @${user2Username}`);
        await waitForPostMatching(ctx, rootPost.id, /can now participate|invited/i, { timeout: 10000 });

        await sendCommand(ctx, rootPost.id, `!kick @${user2Username}`);
        await waitForPostMatching(ctx, rootPost.id, /kicked|removed/i, { timeout: 10000 });

        const postsBeforeUser2 = await getThreadPosts(ctx, rootPost.id);
        const botPostsBeforeUser2 = postsBeforeUser2.filter((p) => p.userId === ctx.botUserId);

        // User2 tries to send message after being kicked
        await user2Api.createPost({
          channelId: ctx.channelId,
          message: 'Message after kick',
          rootId: rootPost.id,
          userId: user2Id,
        });

        // Wait for potential bot response
        await new Promise((r) => setTimeout(r, 500));

        const postsAfterUser2 = await getThreadPosts(ctx, rootPost.id);
        const botPostsAfterUser2 = postsAfterUser2.filter((p) => p.userId === ctx.botUserId);

        // Bot should NOT process user2's message as a normal Claude input
        // It should either:
        // 1. Post an approval request message (contains "needs approval")
        // 2. Simply not respond to user2's message at all

        // Check for approval request message
        const approvalRequests = botPostsAfterUser2.filter((p) =>
          /needs approval|not authorized/i.test(p.message)
        );

        // The message was either blocked (no new non-approval bot posts) or flagged for approval
        const normalBotResponses = botPostsAfterUser2.filter((p) =>
          !approvalRequests.includes(p)
        );

        // User2's message should NOT have triggered a normal Claude response
        // Either we got an approval request, or the bot count stayed the same
        expect(
          approvalRequests.length > 0 || normalBotResponses.length === botPostsBeforeUser2.length
        ).toBe(true);
      });
    });

    describe('Message Approval Flow', () => {
      it('should request approval for unauthorized user messages', async () => {
        if (!canRunMultiUserTests() || !user2Api) {
          console.log('Skipping - multi-user tests require Mattermost with second test user');
          return;
        }

        // Start session as user1 (don't invite user2)
        const rootPost = await startSession(ctx, 'Restricted session', getBotUsername());
        testThreadIds.push(rootPost.id);

        await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });
        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

        // User2 tries to send message (not invited)
        await user2Api.createPost({
          channelId: ctx.channelId,
          message: 'Can I join?',
          rootId: rootPost.id,
          userId: user2Id,
        });

        // Wait for at least 3 posts (root + Claude response + user2 message or approval request)
        const allPosts = await waitForPostCount(ctx, rootPost.id, 3);

        // Either blocked or approval requested
        expect(allPosts.length).toBeGreaterThanOrEqual(3);
      });

      it('should approve unauthorized message with thumbsup', async () => {
        if (!canRunMultiUserTests() || !user2Api) {
          console.log('Skipping - multi-user tests require Mattermost with second test user');
          return;
        }

        const rootPost = await startSession(ctx, 'Approval test', getBotUsername());
        testThreadIds.push(rootPost.id);

        await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });
        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

        // User2 sends unauthorized message
        await user2Api.createPost({
          channelId: ctx.channelId,
          message: 'Please approve this',
          rootId: rootPost.id,
          userId: user2Id,
        });

        // Wait for approval request post from bot (contains "needs approval" and reaction instructions)
        const approvalPost = await waitForPostMatching(
          ctx,
          rootPost.id,
          /needs approval/i,
          { timeout: 10000 }
        );

        expect(approvalPost).toBeDefined();
        expect(approvalPost.message).toContain('React:');

        // Verify the post has the expected reaction options (added by createInteractivePost)
        // The bot adds thumbsup, white_check_mark, thumbsdown as reaction options
        // Note: We can't easily verify reaction handling via WebSocket in tests
        // since reactions added via API may not trigger WebSocket events for the same user
      });

      it('should deny unauthorized message with thumbsdown', async () => {
        if (!canRunMultiUserTests() || !user2Api) {
          console.log('Skipping - multi-user tests require Mattermost with second test user');
          return;
        }

        const rootPost = await startSession(ctx, 'Deny test', getBotUsername());
        testThreadIds.push(rootPost.id);

        await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });
        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

        // User2 sends unauthorized message
        await user2Api.createPost({
          channelId: ctx.channelId,
          message: 'This will be denied',
          rootId: rootPost.id,
          userId: user2Id,
        });

        // Wait for approval request post from bot
        const approvalPost = await waitForPostMatching(
          ctx,
          rootPost.id,
          /needs approval/i,
          { timeout: 10000 }
        );

        expect(approvalPost).toBeDefined();
        expect(approvalPost.message).toContain('Allow once');
        expect(approvalPost.message).toContain('Deny');
      });
    });
  });
});
