/**
 * Task List Integration Tests
 *
 * Tests the task list display functionality when Claude uses TodoWrite.
 *
 * Parameterized to run against both Mattermost and Slack platforms.
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
  getThreadPosts,
  getPlatformBotOptions,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';
import { type PlatformType } from '../fixtures/platform-test-api.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

// Determine which platforms to test based on environment
const TEST_PLATFORMS = (process.env.TEST_PLATFORMS || 'mattermost').split(',') as PlatformType[];

describe.skipIf(SKIP)('Task List Display', () => {
  describe.each(TEST_PLATFORMS)('%s platform', (platformType) => {
    let config: ReturnType<typeof loadConfig>;
    let ctx: TestSessionContext;
    const testThreadIds: string[] = [];

    // Mattermost-specific: admin API for cleanup
    let adminApi: MattermostTestApi | null = null;

    beforeAll(async () => {
      config = loadConfig();
      ctx = initTestContext(platformType);

      // Set up admin API for Mattermost cleanup
      if (platformType === 'mattermost') {
        adminApi = new MattermostTestApi(config.mattermost.url, config.mattermost.admin.token!);
      }
    });

    afterAll(async () => {
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

    describe('Task List Creation', () => {
      let bot: TestBot;

      afterEach(async () => {
        if (bot) {
          await bot.stop();
        }
      });

      it('should display task list when Claude uses TodoWrite', async () => {
        const botUsername = platformType === 'mattermost'
          ? config.mattermost.bot.username
          : 'claude-test-bot';

        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'task-list',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
        }));

        // Start a session with a message that triggers the task-list scenario
        const rootPost = await startSession(ctx, 'Help me plan the task list steps', botUsername);
        testThreadIds.push(rootPost.id);

        // Wait for initial response
        await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });
        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

        // Wait for task list post (should contain task list formatting)
        const taskPost = await waitForPostMatching(ctx, rootPost.id, /Tasks/, {
          timeout: 10000,
        });

        expect(taskPost).toBeDefined();
        // Task list should have task content
        expect(taskPost.message).toMatch(/Analyze|Create|Execute|plan/i);
      });

      it('should show task progress updates', async () => {
        const botUsername = platformType === 'mattermost'
          ? config.mattermost.bot.username
          : 'claude-test-bot';

        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'task-list',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
        }));

        const rootPost = await startSession(ctx, 'Help me plan the task list steps', botUsername);
        testThreadIds.push(rootPost.id);

        await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });
        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

        // Wait for completion message
        const completionPost = await waitForPostMatching(ctx, rootPost.id, /complete/i, {
          timeout: 15000,
        });

        expect(completionPost).toBeDefined();
      });

      it('should show completed status when all tasks done', async () => {
        const botUsername = platformType === 'mattermost'
          ? config.mattermost.bot.username
          : 'claude-test-bot';

        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'task-list',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
        }));

        const rootPost = await startSession(ctx, 'Help me plan the task list steps', botUsername);
        testThreadIds.push(rootPost.id);

        // Wait for session to complete (result event)
        await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

        // Give time for all task updates
        await new Promise((r) => setTimeout(r, 2000));

        // Verify completion via the "All tasks are complete!" message
        // Note: The task list post itself is deleted when all tasks complete,
        // so we look for the completion message instead
        const completionPost = await waitForPostMatching(ctx, rootPost.id, /all tasks.*complete/i, {
          timeout: 10000,
        });
        expect(completionPost).toBeDefined();
      });
    });

    describe('Task List Post Visibility', () => {
      let bot: TestBot;

      afterEach(async () => {
        if (bot) {
          await bot.stop();
        }
      });

      it('should create visible task list post in thread', async () => {
        const botUsername = platformType === 'mattermost'
          ? config.mattermost.bot.username
          : 'claude-test-bot';

        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'task-list',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
        }));

        const rootPost = await startSession(ctx, 'Help me plan the task list steps', botUsername);
        testThreadIds.push(rootPost.id);

        await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });
        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

        // Wait a bit for task list post to be created
        await new Promise((r) => setTimeout(r, 1000));

        // Verify task list post is visible in thread via API
        const threadPosts = await getThreadPosts(ctx, rootPost.id);

        // Should have multiple posts including task list
        expect(threadPosts.length).toBeGreaterThan(1);

        // At least one post should contain task-related content
        const hasTaskPost = threadPosts.some((p) =>
          /Tasks|Analyze|Create|Execute/i.test(p.message)
        );
        expect(hasTaskPost).toBe(true);
      });
    });
  });
});
