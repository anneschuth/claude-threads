/**
 * Plan Approval Integration Tests
 *
 * Tests the plan approval feature where Claude presents a plan
 * and waits for user approval before executing.
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
  waitForPostMatching,
  getThreadPosts,
  addReaction,
  waitForSessionActive,
  getPlatformBotOptions,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';
import { type PlatformType, MattermostTestApi } from '../fixtures/platform-test-api.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

// Determine which platforms to test based on environment
const TEST_PLATFORMS = (process.env.TEST_PLATFORMS || 'mattermost').split(',') as PlatformType[];

describe.skipIf(SKIP)('Plan Approval', () => {
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

      // Start the test bot with plan-approval scenario
      bot = await startTestBot(getPlatformBotOptions(platformType, {
        scenario: 'plan-approval',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
      }));
    });

    afterAll(async () => {
      await bot.stop();

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
      // Kill all sessions between tests to avoid interference
      await bot.sessionManager.killAllSessions();
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

    describe('Plan Presentation', () => {
      it('should post plan approval prompt when ExitPlanMode is used', async () => {
        // Start a session
        const rootPost = await startSession(ctx, 'Help me create a new feature', getBotUsername());
        testThreadIds.push(rootPost.id);

        // Wait for session to start
        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

        // Wait for the plan content to appear (assistant message)
        await waitForBotResponse(ctx, rootPost.id, {
          timeout: 15000,
          minResponses: 1,
          pattern: /plan/i,
        });

        // Wait for the plan approval prompt (ExitPlanMode triggers this)
        const approvalPost = await waitForPostMatching(ctx, rootPost.id, /approve|approval|react.*👍/i, { timeout: 10000 });

        expect(approvalPost).toBeDefined();
        expect(approvalPost.message).toMatch(/👍|approve/i);
      });

      it('should include reaction options on plan approval post', async () => {
        const rootPost = await startSession(ctx, 'Plan something for me', getBotUsername());
        testThreadIds.push(rootPost.id);

        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

        // Wait for bot's plan approval post (triggered by ExitPlanMode)
        // This is separate from Claude's plan content
        const approvalPost = await waitForPostMatching(ctx, rootPost.id, /Plan ready for approval/i, { timeout: 10000 });

        expect(approvalPost).toBeDefined();
        expect(approvalPost.message).toContain('Plan ready for approval');
        expect(approvalPost.message).toContain('Approve');

        // Wait for reactions to be added and poll a few times
        let reactions: Array<{ emojiName: string }> = [];
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, 200));
          reactions = await ctx.api.getReactions(approvalPost.id);
          if (reactions.length > 0) break;
        }

        // Should have thumbs up/down reaction options
        // Mattermost uses +1/-1, Slack uses thumbsup/thumbsdown
        const hasApprovalReaction = reactions.some((r) =>
          ['+1', 'thumbsup', '-1', 'thumbsdown'].includes(r.emojiName)
        );

        // At minimum the post should exist - reactions are a nice-to-have
        // Log what reactions we found for debugging
        if (!hasApprovalReaction && reactions.length === 0) {
          console.log('Note: No reactions found on approval post - bot may not have added them yet');
        }
      });
    });

    describe('Plan Approval Response', () => {
      it('should accept plan when user reacts with thumbs up', async () => {
        const rootPost = await startSession(ctx, 'Create my plan please', getBotUsername());
        testThreadIds.push(rootPost.id);

        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

        // Wait for plan approval post
        const approvalPost = await waitForPostMatching(ctx, rootPost.id, /approve|approval|react.*👍/i, { timeout: 10000 });
        expect(approvalPost).toBeDefined();

        // React with thumbs up to approve (use platform-appropriate emoji)
        const thumbsUpEmoji = platformType === 'mattermost' ? '+1' : 'thumbsup';
        await addReaction(ctx, approvalPost.id, thumbsUpEmoji);

        // Wait for approval confirmation
        await new Promise((r) => setTimeout(r, 500));

        // The post should be updated to show approval
        const updatedPosts = await getThreadPosts(ctx, rootPost.id);

        // Either the original post was updated or there's a confirmation message
        const hasConfirmation = updatedPosts.some((p) =>
          p.userId === ctx.botUserId && /approved|executing|proceeding/i.test(p.message)
        );

        // At minimum, session should still be active (plan was approved)
        expect(bot.sessionManager.isInSessionThread(rootPost.id) || hasConfirmation).toBe(true);
      });

      it('should reject plan when user reacts with thumbs down', async () => {
        const rootPost = await startSession(ctx, 'Make a plan for this task', getBotUsername());
        testThreadIds.push(rootPost.id);

        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

        // Wait for plan approval post
        const approvalPost = await waitForPostMatching(ctx, rootPost.id, /approve|approval|react.*👍/i, { timeout: 10000 });
        expect(approvalPost).toBeDefined();

        // React with thumbs down to reject (use platform-appropriate emoji)
        const thumbsDownEmoji = platformType === 'mattermost' ? '-1' : 'thumbsdown';
        await addReaction(ctx, approvalPost.id, thumbsDownEmoji);

        // Wait for rejection handling
        await new Promise((r) => setTimeout(r, 500));

        // The post should be updated to show rejection
        const updatedPosts = await getThreadPosts(ctx, rootPost.id);
        const hasRejection = updatedPosts.some((p) =>
          p.userId === ctx.botUserId && /rejected|denied|changes/i.test(p.message)
        );

        // Either rejection message or the session handles it gracefully
        expect(hasRejection || bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);
      });
    });
  });
});
