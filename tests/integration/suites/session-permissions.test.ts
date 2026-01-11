/**
 * Session Permissions Integration Tests
 *
 * Tests the tool_use flow display when Claude performs actions.
 *
 * NOTE: Full permission approval/denial testing requires the real MCP permission server,
 * which doesn't work with the mock CLI. These tests verify that tool_use events are
 * properly displayed to users, but don't test the actual approval/denial flow.
 * The approval/denial flow is tested in unit tests for the MCP permission server.
 *
 * Parameterized to run against both Mattermost and Slack platforms.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import {
  initTestContext,
  initAdminApi,
  startSession,
  waitForBotResponse,
  waitForSessionEnded,
  getThreadPosts,
  getPlatformBotOptions,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';
import { type PlatformType, MattermostTestApi } from '../fixtures/platform-test-api.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

// Determine which platforms to test based on environment
const TEST_PLATFORMS = (process.env.TEST_PLATFORMS || 'mattermost').split(',') as PlatformType[];

describe.skipIf(SKIP)('Session Permissions', () => {
  describe.each(TEST_PLATFORMS)('%s platform', (platformType) => {
    let config: ReturnType<typeof loadConfig>;
    let ctx: TestSessionContext;
    let adminApi: MattermostTestApi | null = null;
    let bot: TestBot;
    const testThreadIds: string[] = [];

    beforeAll(async () => {
      config = loadConfig();
      ctx = initTestContext(platformType);

      // Admin API only available for Mattermost
      if (platformType === 'mattermost') {
        adminApi = initAdminApi();
      }
    });

    afterAll(async () => {
      if (bot) {
        await bot.stop();
      }

      // Clean up test threads (Mattermost only with admin API)
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
      if (bot) {
        await bot.stop();
      }
      await new Promise((r) => setTimeout(r, 200));
    });

    // Get the bot username based on platform
    const getBotUsername = () => {
      if (platformType === 'mattermost') {
        return config.mattermost.bot.username;
      }
      // Slack uses a different format
      return config.slack?.botUsername || 'claude-test-bot';
    };

    describe('Tool Use Display', () => {
      it('should display tool_use information when Claude uses a tool', async () => {
        // Start bot - skipPermissions allows tool execution without prompts
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'permission-request',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
        }));

        const rootPost = await startSession(ctx, 'Write a file for me', getBotUsername());
        testThreadIds.push(rootPost.id);

        // Wait for bot to respond with tool_use content
        // The mock scenario emits: assistant (with tool_use) -> tool_result -> assistant (done) -> result
        await waitForBotResponse(ctx, rootPost.id, {
          timeout: 30000,
          minResponses: 2, // Session header + response with tool_use
        });

        // Wait for session to end (result event)
        await waitForSessionEnded(bot.sessionManager, rootPost.id, { timeout: 10000 });

        const allPosts = await getThreadPosts(ctx, rootPost.id);
        const botPosts = allPosts.filter((p) => p.userId === ctx.botUserId);

        // Debug: Log all bot posts to understand what's happening
        console.error(`[TEST DEBUG] Found ${botPosts.length} bot posts:`);
        botPosts.forEach((p, i) => {
          console.error(`[TEST DEBUG] Post ${i}: ${p.message.substring(0, 200)}...`);
        });

        // Verify we have meaningful responses
        expect(botPosts.length).toBeGreaterThanOrEqual(2);

        // Check that tool use was displayed (Write tool)
        const hasToolContent = botPosts.some((p) =>
          p.message.includes('Write') || p.message.includes('write') || p.message.includes('file')
        );
        console.error(`[TEST DEBUG] hasToolContent: ${hasToolContent}`);
        expect(hasToolContent).toBe(true);

        // Check that completion message was posted
        const hasCompletionMessage = botPosts.some((p) =>
          p.message.includes('Done') || p.message.includes('written')
        );
        expect(hasCompletionMessage).toBe(true);
      });

      it('should show tool name and action in tool_use posts', async () => {
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'permission-request',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
        }));

        const rootPost = await startSession(ctx, 'Create a test file', getBotUsername());
        testThreadIds.push(rootPost.id);

        // Wait for bot to respond
        await waitForBotResponse(ctx, rootPost.id, {
          timeout: 30000,
          minResponses: 2,
        });

        // Wait for session to end
        await waitForSessionEnded(bot.sessionManager, rootPost.id, { timeout: 10000 });

        const allPosts = await getThreadPosts(ctx, rootPost.id);
        const botPosts = allPosts.filter((p) => p.userId === ctx.botUserId);

        // With the permission-request scenario, we should see:
        // - Session header
        // - "I'll write that to a file for you" + Write tool info
        // - "Done! I've written the content..."
        expect(botPosts.length).toBeGreaterThanOrEqual(2);

        // Verify the response flow is complete
        const hasWriteAction = botPosts.some((p) =>
          /write|file/i.test(p.message)
        );
        expect(hasWriteAction).toBe(true);
      });
    });

    describe('Skip Permissions Mode', () => {
      it('should auto-approve when skipPermissions is true', async () => {
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'permission-request',
          skipPermissions: true, // Skip prompts
          debug: process.env.DEBUG === '1',
        }));

        const rootPost = await startSession(ctx, 'Write without asking', getBotUsername());
        testThreadIds.push(rootPost.id);

        // Wait for completion - with skipPermissions, tools execute without prompts
        await waitForBotResponse(ctx, rootPost.id, {
          timeout: 30000,
          minResponses: 2,
        });

        // Wait for session to end
        await waitForSessionEnded(bot.sessionManager, rootPost.id, { timeout: 10000 });

        const allPosts = await getThreadPosts(ctx, rootPost.id);
        const botPosts = allPosts.filter((p) => p.userId === ctx.botUserId);

        // Should have responses and tool execution completed
        expect(botPosts.length).toBeGreaterThanOrEqual(2);

        // Verify tool completed without prompts (look for completion message)
        const hasCompletion = botPosts.some((p) =>
          /done|written|success/i.test(p.message)
        );
        expect(hasCompletion).toBe(true);

        // Session should be ended (no pending permission prompts blocking)
        expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(false);
      });
    });

    describe('Permission Prompt Mode', () => {
      // Note: Full permission prompt testing requires the real MCP permission server.
      // The mock CLI doesn't support MCP, so we can only test that enabling
      // skipPermissions: false doesn't break the bot.

      it('should handle permission mode without crashing', async () => {
        // Start bot with interactive permissions enabled
        // Note: With mock CLI, this won't actually show prompts, but shouldn't crash
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'permission-request',
          skipPermissions: false, // Enable permission mode
          debug: process.env.DEBUG === '1',
        }));

        const rootPost = await startSession(ctx, 'Test permission mode', getBotUsername());
        testThreadIds.push(rootPost.id);

        // Wait for any bot response
        const responses = await waitForBotResponse(ctx, rootPost.id, {
          timeout: 30000,
          minResponses: 1,
        });

        // Should at least get a session header
        expect(responses.length).toBeGreaterThanOrEqual(1);

        // Bot should have created posts without crashing
        const allPosts = await getThreadPosts(ctx, rootPost.id);
        const botPosts = allPosts.filter((p) => p.userId === ctx.botUserId);
        expect(botPosts.length).toBeGreaterThanOrEqual(1);
      });
    });
  });
});
