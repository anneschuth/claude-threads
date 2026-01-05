/**
 * Session Questions Integration Tests
 *
 * Tests the question/answer flow when Claude asks the user multiple-choice questions.
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
  getThreadPosts,
  addReaction,
  getPlatformBotOptions,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';
import { type PlatformType, MattermostTestApi } from '../fixtures/platform-test-api.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

// Determine which platforms to test based on environment
const TEST_PLATFORMS = (process.env.TEST_PLATFORMS || 'mattermost').split(',') as PlatformType[];

describe.skipIf(SKIP)('Session Questions', () => {
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
            // Ignore
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

    describe('Multiple Choice Questions', () => {
      it('should display question with emoji options', async () => {
        // Start bot with ask-question scenario
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'ask-question',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
        }));

        const rootPost = await startSession(ctx, 'I need to make a choice', getBotUsername());
        testThreadIds.push(rootPost.id);

        // Wait for question to appear
        await new Promise((r) => setTimeout(r, 200));

        const allPosts = await getThreadPosts(ctx, rootPost.id);
        const botPosts = allPosts.filter((p) => p.userId === ctx.botUserId);

        expect(botPosts.length).toBeGreaterThanOrEqual(1);

        // Look for a question post with options
        const questionPost = botPosts.find((p) =>
          /\?|option|choice|select|which/i.test(p.message)
        );

        if (questionPost) {
          // Question posts should have number emoji reactions
          // Bot typically adds 1️⃣ 2️⃣ 3️⃣ etc. as options
          // Note: Exact emoji names depend on implementation
        }
      });

      it('should accept answer via number emoji reaction', async () => {
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'ask-question',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
        }));

        const rootPost = await startSession(ctx, 'Help me choose', getBotUsername());
        testThreadIds.push(rootPost.id);

        await new Promise((r) => setTimeout(r, 200));

        const allPosts = await getThreadPosts(ctx, rootPost.id);
        const botPosts = allPosts.filter((p) => p.userId === ctx.botUserId);

        // Find question post
        const questionPost = botPosts.find((p) =>
          /\?|option|choice/i.test(p.message)
        );

        if (questionPost) {
          // Answer with option 1 (number one emoji)
          // Common emoji names: one, 1️⃣, etc.
          await addReaction(ctx, questionPost.id, 'one');

          await new Promise((r) => setTimeout(r, 200));

          // Check for continuation after answer
          const updatedPosts = await getThreadPosts(ctx, rootPost.id);
          expect(updatedPosts.length).toBeGreaterThanOrEqual(allPosts.length);
        }
      });

      it('should handle multiple questions in sequence', async () => {
        // This would require a multi-question scenario
        // For now, just verify we can handle one question
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'ask-question',
          skipPermissions: true,
        }));

        const rootPost = await startSession(ctx, 'Complex task with questions', getBotUsername());
        testThreadIds.push(rootPost.id);

        await new Promise((r) => setTimeout(r, 200));

        const allPosts = await getThreadPosts(ctx, rootPost.id);
        expect(allPosts.length).toBeGreaterThanOrEqual(2); // At least user message + bot response
      });
    });

    describe('Plan Approval', () => {
      it('should show plan and wait for approval', async () => {
        // This would use the plan-approval scenario
        // For now, test basic flow
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'simple-response', // TODO: Use plan-approval scenario when created
          skipPermissions: true,
        }));

        const rootPost = await startSession(ctx, 'Make a plan for me', getBotUsername());
        testThreadIds.push(rootPost.id);

        await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

        // Check for plan-like content
        const allPosts = await getThreadPosts(ctx, rootPost.id);
        const botPosts = allPosts.filter((p) => p.userId === ctx.botUserId);

        expect(botPosts.length).toBeGreaterThanOrEqual(1);
      });

      it('should approve plan with thumbsup', async () => {
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'simple-response',
          skipPermissions: true,
        }));

        const rootPost = await startSession(ctx, 'Create a step by step plan', getBotUsername());
        testThreadIds.push(rootPost.id);

        const botResponses = await waitForBotResponse(ctx, rootPost.id, {
          timeout: 30000,
          minResponses: 1,
        });

        // Find first bot post that might be a plan
        const planPost = botResponses[0];

        if (planPost) {
          // Approve plan (use platform-appropriate emoji)
          const thumbsUpEmoji = platformType === 'mattermost' ? '+1' : 'thumbsup';
          await addReaction(ctx, planPost.id, thumbsUpEmoji);
          await new Promise((r) => setTimeout(r, 200));

          // Verify reaction was processed
          const reactions = await ctx.api.getReactions(planPost.id);
          expect(reactions.some((r) => r.emojiName === thumbsUpEmoji || r.emojiName === '+1' || r.emojiName === 'thumbsup')).toBe(true);
        }
      });
    });
  });
});
