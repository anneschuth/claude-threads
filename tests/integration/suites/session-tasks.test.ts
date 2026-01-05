/**
 * Task List Integration Tests
 *
 * Tests the task list display functionality when Claude uses TodoWrite.
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
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

describe.skipIf(SKIP)('Task List Display', () => {
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

  describe('Task List Creation', () => {
    let bot: TestBot;

    afterEach(async () => {
      if (bot) {
        await bot.stop();
      }
    });

    it('should display task list when Claude uses TodoWrite', async () => {
      bot = await startTestBot({
        scenario: 'task-list',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
      });

      // Start a session with a message that triggers the task-list scenario
      const rootPost = await startSession(ctx, 'Help me plan the task list steps', config.mattermost.bot.username);
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
      bot = await startTestBot({
        scenario: 'task-list',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
      });

      const rootPost = await startSession(ctx, 'Help me plan the task list steps', config.mattermost.bot.username);
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
      bot = await startTestBot({
        scenario: 'task-list',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
      });

      const rootPost = await startSession(ctx, 'Help me plan the task list steps', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // Wait for session to complete (result event)
      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

      // Give time for all task updates
      await new Promise((r) => setTimeout(r, 2000));

      // Verify completed status via posts - should show 100% or 3/3
      const taskPost = await waitForPostMatching(ctx, rootPost.id, /100%|3\/3/i, {
        timeout: 5000,
      });
      expect(taskPost).toBeDefined();
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
      bot = await startTestBot({
        scenario: 'task-list',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
      });

      const rootPost = await startSession(ctx, 'Help me plan the task list steps', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });
      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

      // Wait a bit for task list post to be created
      await new Promise((r) => setTimeout(r, 1000));

      // Verify task list post is visible in thread via API
      const { posts } = await adminApi.getThreadPosts(rootPost.id);
      const threadPosts = Object.values(posts);

      // Should have multiple posts including task list
      expect(threadPosts.length).toBeGreaterThan(1);

      // At least one post should contain task-related content
      const hasTaskPost = threadPosts.some((p: { message: string }) =>
        /Tasks|Analyze|Create|Execute/i.test(p.message)
      );
      expect(hasTaskPost).toBe(true);
    });
  });
});
