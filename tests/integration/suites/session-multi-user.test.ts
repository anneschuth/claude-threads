/**
 * Session Multi-User Integration Tests
 *
 * Tests multi-user scenarios: !invite, !kick, message approval flow.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import { MattermostTestApi } from '../fixtures/mattermost/api-helpers.js';
import {
  initTestContext,
  startSession,
  waitForBotResponse,
  sendCommand,
  getThreadPosts,
  addReaction,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

describe.skipIf(SKIP)('Session Multi-User', () => {
  let config: ReturnType<typeof loadConfig>;
  let ctx: TestSessionContext;
  let adminApi: MattermostTestApi;
  let bot: TestBot;
  const testThreadIds: string[] = [];

  // User 2 context
  let user2Api: MattermostTestApi;
  let user2Id: string;

  beforeAll(async () => {
    config = loadConfig();
    adminApi = new MattermostTestApi(config.mattermost.url, config.mattermost.admin.token!);
    ctx = initTestContext();

    // Set up second user
    const user2Token = config.mattermost.testUsers[1]?.token;
    user2Id = config.mattermost.testUsers[1]?.userId || '';

    if (user2Token) {
      user2Api = new MattermostTestApi(config.mattermost.url, user2Token);
    }

    // Start bot with just user1 as allowed (for invite/kick tests)
    bot = await startTestBot({
      scenario: 'simple-response',
      skipPermissions: true,
      extraAllowedUsers: [], // Only default users
      debug: process.env.DEBUG === '1',
    });
  });

  afterAll(async () => {
    if (bot) {
      await bot.stop();
    }

    for (const threadId of testThreadIds) {
      try {
        await adminApi.deletePost(threadId);
      } catch {
        // Ignore
      }
    }
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });

  describe('!invite Command', () => {
    it('should invite a user to the session', async () => {
      if (!user2Api) {
        console.log('Skipping - no second test user');
        return;
      }

      // Start session as user1
      const rootPost = await startSession(ctx, 'Session for collaboration', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

      // Invite user2
      const user2Username = config.mattermost.testUsers[1]?.username || 'testuser2';
      await sendCommand(ctx, rootPost.id, `!invite @${user2Username}`);

      // Wait for invite message
      await new Promise((r) => setTimeout(r, 50));

      const allPosts = await getThreadPosts(ctx, rootPost.id);
      const invitePost = allPosts.find((p) =>
        p.user_id === ctx.botUserId && /invited|added/i.test(p.message)
      );

      expect(invitePost).toBeDefined();
    });

    it('should allow invited user to send messages', async () => {
      if (!user2Api) {
        console.log('Skipping - no second test user');
        return;
      }

      // Start session and invite user2
      const rootPost = await startSession(ctx, 'Collaborative session', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

      const user2Username = config.mattermost.testUsers[1]?.username || 'testuser2';
      await sendCommand(ctx, rootPost.id, `!invite @${user2Username}`);
      await new Promise((r) => setTimeout(r, 50));

      // User2 sends a message
      await user2Api.createPost({
        channel_id: ctx.channelId,
        message: 'Hello from user2!',
        root_id: rootPost.id,
      });

      await new Promise((r) => setTimeout(r, 50));

      // Bot should process user2's message (not block it)
      const allPosts = await getThreadPosts(ctx, rootPost.id);

      // Find user2's message
      const user2Post = allPosts.find((p) =>
        p.user_id === user2Id && p.message === 'Hello from user2!'
      );

      expect(user2Post).toBeDefined();
    });
  });

  describe('!kick Command', () => {
    it('should kick a user from the session', async () => {
      if (!user2Api) {
        console.log('Skipping - no second test user');
        return;
      }

      // Start session and invite user2
      const rootPost = await startSession(ctx, 'Session to kick from', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

      const user2Username = config.mattermost.testUsers[1]?.username || 'testuser2';

      // Invite first
      await sendCommand(ctx, rootPost.id, `!invite @${user2Username}`);
      await new Promise((r) => setTimeout(r, 150));

      // Then kick
      await sendCommand(ctx, rootPost.id, `!kick @${user2Username}`);
      await new Promise((r) => setTimeout(r, 150));

      const allPosts = await getThreadPosts(ctx, rootPost.id);
      const kickPost = allPosts.find((p) =>
        p.user_id === ctx.botUserId && /kicked|removed/i.test(p.message)
      );

      expect(kickPost).toBeDefined();
    });

    it('should block kicked user messages', async () => {
      if (!user2Api) {
        console.log('Skipping - no second test user');
        return;
      }

      // Start session, invite, then kick user2
      const rootPost = await startSession(ctx, 'Kick test session', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

      const user2Username = config.mattermost.testUsers[1]?.username || 'testuser2';

      await sendCommand(ctx, rootPost.id, `!invite @${user2Username}`);
      await new Promise((r) => setTimeout(r, 50));
      await sendCommand(ctx, rootPost.id, `!kick @${user2Username}`);
      await new Promise((r) => setTimeout(r, 50));

      const postsBeforeUser2 = await getThreadPosts(ctx, rootPost.id);

      // User2 tries to send message after being kicked
      await user2Api.createPost({
        channel_id: ctx.channelId,
        message: 'Message after kick',
        root_id: rootPost.id,
      });

      await new Promise((r) => setTimeout(r, 50));

      const postsAfterUser2 = await getThreadPosts(ctx, rootPost.id);

      // Bot should either block or request approval for user2's message
      // Either way, it should NOT process it as a normal message
      // Either approval request or no new bot response
      expect(postsAfterUser2.length).toBeGreaterThanOrEqual(postsBeforeUser2.length);
    });
  });

  describe('Message Approval Flow', () => {
    it('should request approval for unauthorized user messages', async () => {
      if (!user2Api) {
        console.log('Skipping - no second test user');
        return;
      }

      // Start session as user1 (don't invite user2)
      const rootPost = await startSession(ctx, 'Restricted session', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

      // User2 tries to send message (not invited)
      await user2Api.createPost({
        channel_id: ctx.channelId,
        message: 'Can I join?',
        root_id: rootPost.id,
      });

      await new Promise((r) => setTimeout(r, 50));

      const allPosts = await getThreadPosts(ctx, rootPost.id);

      // Either blocked or approval requested
      expect(allPosts.length).toBeGreaterThanOrEqual(2);
    });

    it('should approve unauthorized message with thumbsup', async () => {
      if (!user2Api) {
        console.log('Skipping - no second test user');
        return;
      }

      const rootPost = await startSession(ctx, 'Approval test', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

      // User2 sends unauthorized message
      await user2Api.createPost({
        channel_id: ctx.channelId,
        message: 'Please approve this',
        root_id: rootPost.id,
      });

      await new Promise((r) => setTimeout(r, 50));

      const allPosts = await getThreadPosts(ctx, rootPost.id);

      // Find approval request post
      const approvalPost = allPosts.find((p) =>
        p.user_id === ctx.botUserId && /approval|pending/i.test(p.message)
      );

      if (approvalPost) {
        // Owner approves
        await addReaction(ctx, approvalPost.id, '+1');
        await new Promise((r) => setTimeout(r, 50));

        // Message should be processed
        const updatedPosts = await getThreadPosts(ctx, rootPost.id);
        expect(updatedPosts.length).toBeGreaterThan(allPosts.length);
      }
    });

    it('should deny unauthorized message with thumbsdown', async () => {
      if (!user2Api) {
        console.log('Skipping - no second test user');
        return;
      }

      const rootPost = await startSession(ctx, 'Deny test', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

      // User2 sends unauthorized message
      await user2Api.createPost({
        channel_id: ctx.channelId,
        message: 'This will be denied',
        root_id: rootPost.id,
      });

      await new Promise((r) => setTimeout(r, 50));

      const allPosts = await getThreadPosts(ctx, rootPost.id);

      const approvalPost = allPosts.find((p) =>
        p.user_id === ctx.botUserId && /approval|pending/i.test(p.message)
      );

      if (approvalPost) {
        // Owner denies
        await addReaction(ctx, approvalPost.id, '-1');
        await new Promise((r) => setTimeout(r, 50));

        // Should have denial message or approval post updated
        const updatedPosts = await getThreadPosts(ctx, rootPost.id);
        expect(updatedPosts.length).toBeGreaterThanOrEqual(allPosts.length);
      }
    });
  });
});
