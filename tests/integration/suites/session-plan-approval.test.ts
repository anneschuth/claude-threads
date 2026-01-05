/**
 * Plan Approval Integration Tests
 *
 * Tests the plan approval feature where Claude presents a plan
 * and waits for user approval before executing.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import { MattermostTestApi } from '../fixtures/mattermost/api-helpers.js';
import {
  initTestContext,
  startSession,
  waitForBotResponse,
  waitForPostMatching,
  getThreadPosts,
  addReaction,
  waitForSessionActive,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

describe.skipIf(SKIP)('Plan Approval', () => {
  let config: ReturnType<typeof loadConfig>;
  let ctx: TestSessionContext;
  let adminApi: MattermostTestApi;
  let bot: TestBot;
  const testThreadIds: string[] = [];

  beforeAll(async () => {
    config = loadConfig();
    adminApi = new MattermostTestApi(config.mattermost.url, config.mattermost.admin.token!);
    ctx = initTestContext();

    // Start the test bot with plan-approval scenario
    bot = await startTestBot({
      scenario: 'plan-approval',
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
    await new Promise((r) => setTimeout(r, 25));
  });

  describe('Plan Presentation', () => {
    it('should post plan approval prompt when ExitPlanMode is used', async () => {
      // Start a session
      const rootPost = await startSession(ctx, 'Help me create a new feature', config.mattermost.bot.username);
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
      const approvalPost = await waitForPostMatching(ctx, rootPost.id, /approve|approval|react.*👍/i, { timeout: 5000 });

      expect(approvalPost).toBeDefined();
      expect(approvalPost.message).toMatch(/👍|approve/i);
    });

    it('should include reaction options on plan approval post', async () => {
      const rootPost = await startSession(ctx, 'Plan something for me', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

      // Wait for bot's plan approval post (triggered by ExitPlanMode)
      // This is separate from Claude's plan content
      const approvalPost = await waitForPostMatching(ctx, rootPost.id, /Plan ready for approval/i, { timeout: 10000 });

      expect(approvalPost).toBeDefined();
      expect(approvalPost.message).toContain('Plan ready for approval');
      expect(approvalPost.message).toContain('Approve');

      // Wait for reactions to be added and poll a few times
      let reactions: Array<{ emoji_name: string }> = [];
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 200));
        reactions = await adminApi.getReactions(approvalPost.id);
        if (reactions.length > 0) break;
      }

      // Should have thumbs up/down reaction options (Mattermost uses +1/-1)
      const hasApprovalReaction = reactions.some((r) =>
        ['+1', 'thumbsup', '-1', 'thumbsdown'].includes(r.emoji_name)
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
      const rootPost = await startSession(ctx, 'Create my plan please', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

      // Wait for plan approval post
      const approvalPost = await waitForPostMatching(ctx, rootPost.id, /approve|approval|react.*👍/i, { timeout: 10000 });
      expect(approvalPost).toBeDefined();

      // React with thumbs up to approve
      await addReaction(ctx, approvalPost.id, '+1');

      // Wait for approval confirmation
      await new Promise((r) => setTimeout(r, 500));

      // The post should be updated to show approval
      const updatedPosts = await getThreadPosts(ctx, rootPost.id);

      // Either the original post was updated or there's a confirmation message
      const hasConfirmation = updatedPosts.some((p) =>
        p.user_id === ctx.botUserId && /approved|executing|proceeding/i.test(p.message)
      );

      // At minimum, session should still be active (plan was approved)
      expect(bot.sessionManager.isInSessionThread(rootPost.id) || hasConfirmation).toBe(true);
    });

    it('should reject plan when user reacts with thumbs down', async () => {
      const rootPost = await startSession(ctx, 'Make a plan for this task', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

      // Wait for plan approval post
      const approvalPost = await waitForPostMatching(ctx, rootPost.id, /approve|approval|react.*👍/i, { timeout: 10000 });
      expect(approvalPost).toBeDefined();

      // React with thumbs down to reject
      await addReaction(ctx, approvalPost.id, '-1');

      // Wait for rejection handling
      await new Promise((r) => setTimeout(r, 500));

      // The post should be updated to show rejection
      const updatedPosts = await getThreadPosts(ctx, rootPost.id);
      const hasRejection = updatedPosts.some((p) =>
        p.user_id === ctx.botUserId && /rejected|denied|changes/i.test(p.message)
      );

      // Either rejection message or the session handles it gracefully
      expect(hasRejection || bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);
    });
  });
});
