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
  initIsolatedTestContext,
  initAdminApi,
  startSession,
  waitForBotResponse,
  waitForPostMatching,
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
    let cleanupContext: () => Promise<void> = async () => {};
    let bot: TestBot;
    const testThreadIds: string[] = [];

    beforeAll(async () => {
      config = loadConfig();
      // Isolated channel per suite so concurrent suites don't cross-talk
      // (sticky storms / thread write races) in the shared config channel.
      ({ ctx, cleanup: cleanupContext } = await initIsolatedTestContext(platformType));

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
      // Remove the isolated channel.
      await cleanupContext();
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
        return bot?.botUsername ?? (bot?.botUsername ?? config.mattermost.bot.username);
      }
      // Slack uses a different format
      return config.slack?.botUsername || 'claude-test-bot';
    };

    describe('Multiple Choice Questions', () => {
      // Interactive permissions: on modern CLIs AskUserQuestion blocks on the
      // MCP permission prompt (bypass mode doesn't even expose the tool), so
      // the mock routes it through the real MCP server + decision bridge and
      // the user's option reaction answers it via updatedInput — the same
      // path production takes.
      it('should display question with option labels', async () => {
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'ask-question',
          skipPermissions: false,
          debug: process.env.DEBUG === '1',
        }, ctx));

        const rootPost = await startSession(ctx, 'I need to make a choice', getBotUsername());
        testThreadIds.push(rootPost.id);

        // The bot renders the question from the AskUserQuestion tool_use
        const questionPost = await waitForPostMatching(
          ctx, rootPost.id, /Which approach would you prefer/i, { timeout: 20000 }
        );
        expect(questionPost).toBeDefined();
        expect(questionPost.message).toContain('Option A');
        expect(questionPost.message).toContain('Option B');
      });

      it('should deliver the answer through the decision bridge on option reaction', async () => {
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'ask-question',
          skipPermissions: false,
          debug: process.env.DEBUG === '1',
        }, ctx));

        const rootPost = await startSession(ctx, 'Help me choose', getBotUsername());
        testThreadIds.push(rootPost.id);

        const questionPost = await waitForPostMatching(
          ctx, rootPost.id, /Which approach would you prefer/i, { timeout: 20000 }
        );

        // Answer with option 1: resolves the pending MCP permission call via
        // the bridge; the mock only continues once updatedInput.answers
        // arrives — so this post proves the full round trip.
        await addReaction(ctx, questionPost.id, 'one');

        const continuation = await waitForPostMatching(
          ctx, rootPost.id, /proceeding with your choice/i, { timeout: 20000 }
        );
        expect(continuation).toBeDefined();
      });

      it('does not post a competing generic permission prompt for AskUserQuestion', async () => {
        // Regression guard for the duplicate-prompt bug: no generic
        // "Permission requested: AskUserQuestion" post next to the question UI.
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'ask-question',
          skipPermissions: false,
        }, ctx));

        const rootPost = await startSession(ctx, 'Complex task with questions', getBotUsername());
        testThreadIds.push(rootPost.id);

        await waitForPostMatching(ctx, rootPost.id, /Which approach would you prefer/i, { timeout: 20000 });
        await new Promise((r) => setTimeout(r, 1500));

        const allPosts = await getThreadPosts(ctx, rootPost.id);
        const genericPrompt = allPosts.find((p) =>
          /Permission requested:.*AskUserQuestion/i.test(p.message)
        );
        expect(genericPrompt).toBeUndefined();
      });
    });

    describe('Plan Approval', () => {
      it('should show plan and wait for approval', async () => {
        // This would use the plan-approval scenario
        // For now, test basic flow
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'simple-response', // TODO: Use plan-approval scenario when created
          skipPermissions: true,
        }, ctx));

        const rootPost = await startSession(ctx, 'Make a plan for me', getBotUsername());
        testThreadIds.push(rootPost.id);

        await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

        // Check for plan-like content
        const allPosts = await getThreadPosts(ctx, rootPost.id);
        const botPosts = allPosts.filter((p) => ctx.botUserIds.includes(p.userId));

        expect(botPosts.length).toBeGreaterThanOrEqual(1);
      });

      it('should approve plan with thumbsup', async () => {
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'simple-response',
          skipPermissions: true,
        }, ctx));

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
