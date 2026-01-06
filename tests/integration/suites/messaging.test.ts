/**
 * Messaging tests for platform REST APIs
 *
 * Tests post creation, updates, threading, and channel operations.
 * Parameterized to run against both Mattermost and Slack platforms.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import {
  initTestContext,
  initAdminApi,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import {
  createPlatformTestApi,
  type PlatformType,
  type PlatformTestPost,
  MattermostTestApi,
} from '../fixtures/platform-test-api.js';
import { loadConfig } from '../setup/config.js';

// Determine which platforms to test based on environment
const TEST_PLATFORMS = (process.env.TEST_PLATFORMS || 'mattermost').split(',') as PlatformType[];

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

describe.skipIf(SKIP)('Messaging', () => {
  // Run tests for each configured platform
  describe.each(TEST_PLATFORMS)('%s platform', (platformType) => {
    let ctx: TestSessionContext;
    let adminApi: MattermostTestApi | null = null;
    let botCtx: TestSessionContext | null = null;
    let config: ReturnType<typeof loadConfig>;
    let testPostIds: string[] = [];

    beforeAll(() => {
      config = loadConfig();
      ctx = initTestContext(platformType);

      // For Mattermost, we also need admin and bot APIs for some tests
      if (platformType === 'mattermost') {
        adminApi = initAdminApi();

        // Create a bot context for bot-specific tests
        if (config.mattermost.bot.token) {
          const botApi = createPlatformTestApi('mattermost', {
            baseUrl: config.mattermost.url,
            token: config.mattermost.bot.token,
          });
          botCtx = {
            api: botApi,
            platformType: 'mattermost',
            botUserId: config.mattermost.bot.userId!,
            channelId: config.mattermost.channel.id!,
            testUserId: config.mattermost.bot.userId!,
            testUserToken: config.mattermost.bot.token,
          };
        }
      }
    });

    afterEach(async () => {
      // Cleanup test posts
      for (const postId of testPostIds) {
        try {
          // Use admin API for Mattermost, regular API for Slack
          if (adminApi) {
            await adminApi.deletePost(postId);
          } else {
            await ctx.api.deletePost(postId);
          }
        } catch {
          // Ignore errors
        }
      }
      testPostIds = [];
    });

    describe('Post Creation', () => {
      it('should create a post as user', async () => {
        const message = `User post - ${Date.now()}`;
        const post = await ctx.api.createPost({
          channelId: ctx.channelId,
          message,
          userId: ctx.testUserId,
        });

        expect(post.message).toBe(message);
        expect(post.userId).toBe(ctx.testUserId);
        testPostIds.push(post.id);
      });

      it('should create a post as bot', async () => {
        // Skip for Slack as we don't have separate bot context in mock
        if (platformType === 'slack') {
          return;
        }

        if (!botCtx) {
          throw new Error('Bot context not available');
        }

        const message = `Bot post - ${Date.now()}`;
        const post = await botCtx.api.createPost({
          channelId: ctx.channelId,
          message,
          userId: ctx.botUserId,
        });

        expect(post.message).toBe(message);
        expect(post.userId).toBe(ctx.botUserId);
        testPostIds.push(post.id);
      });

      it('should create posts with markdown', async () => {
        const message = `**Bold** and _italic_ and \`code\`\n\n\`\`\`javascript\nconst x = 1;\n\`\`\``;
        const post = await ctx.api.createPost({
          channelId: ctx.channelId,
          message,
          userId: ctx.testUserId,
        });

        expect(post.message).toBe(message);
        testPostIds.push(post.id);
      });
    });

    describe('Threading', () => {
      let rootPost: PlatformTestPost;

      beforeEach(async () => {
        rootPost = await ctx.api.createPost({
          channelId: ctx.channelId,
          message: `Thread root - ${Date.now()}`,
          userId: ctx.testUserId,
        });
        testPostIds.push(rootPost.id);
      });

      it('should create reply in thread', async () => {
        const reply = await ctx.api.createPost({
          channelId: ctx.channelId,
          message: `Reply - ${Date.now()}`,
          rootId: rootPost.id,
          userId: ctx.testUserId,
        });

        expect(reply.rootId).toBe(rootPost.id);
        testPostIds.push(reply.id);
      });

      it('should get all posts in thread', async () => {
        // Create multiple replies
        for (let i = 0; i < 3; i++) {
          const reply = await ctx.api.createPost({
            channelId: ctx.channelId,
            message: `Reply ${i + 1} - ${Date.now()}`,
            rootId: rootPost.id,
            userId: ctx.testUserId,
          });
          testPostIds.push(reply.id);
        }

        const threadPosts = await ctx.api.getThreadPosts(rootPost.id);

        expect(threadPosts.length).toBeGreaterThanOrEqual(4); // root + 3 replies
        expect(threadPosts.some((p) => p.id === rootPost.id)).toBe(true);
      });

      it('should allow bot to reply in user-started thread', async () => {
        // Skip for Slack as we don't have separate bot context in mock
        if (platformType === 'slack') {
          return;
        }

        if (!botCtx) {
          throw new Error('Bot context not available');
        }

        const botReply = await botCtx.api.createPost({
          channelId: ctx.channelId,
          message: `Bot reply - ${Date.now()}`,
          rootId: rootPost.id,
          userId: ctx.botUserId,
        });

        expect(botReply.rootId).toBe(rootPost.id);
        expect(botReply.userId).toBe(ctx.botUserId);
        testPostIds.push(botReply.id);
      });
    });

    describe('Post Updates', () => {
      let testPost: PlatformTestPost;

      beforeEach(async () => {
        testPost = await ctx.api.createPost({
          channelId: ctx.channelId,
          message: `Original message - ${Date.now()}`,
          userId: ctx.testUserId,
        });
        testPostIds.push(testPost.id);
      });

      it('should update post content', async () => {
        const newMessage = `Updated message - ${Date.now()}`;
        const updated = await ctx.api.updatePost(testPost.id, newMessage);

        expect(updated.message).toBe(newMessage);
      });

      it('should preserve post ID after update', async () => {
        const newMessage = `Updated again - ${Date.now()}`;
        const updated = await ctx.api.updatePost(testPost.id, newMessage);

        expect(updated.id).toBe(testPost.id);
      });

      it('bot should update its own posts', async () => {
        // Skip for Slack as we don't have separate bot context in mock
        if (platformType === 'slack') {
          return;
        }

        if (!botCtx) {
          throw new Error('Bot context not available');
        }

        const botPost = await botCtx.api.createPost({
          channelId: ctx.channelId,
          message: `Bot original - ${Date.now()}`,
          userId: ctx.botUserId,
        });
        testPostIds.push(botPost.id);

        const newMessage = `Bot updated - ${Date.now()}`;
        const updated = await botCtx.api.updatePost(botPost.id, newMessage);

        expect(updated.message).toBe(newMessage);
      });
    });

    describe('Mention Detection', () => {
      it('should include mention in post', async () => {
        const botUsername =
          platformType === 'mattermost'
            ? config.mattermost.bot.username
            : 'claude-test-bot';

        const message = `@${botUsername} please help`;
        const post = await ctx.api.createPost({
          channelId: ctx.channelId,
          message,
          userId: ctx.testUserId,
        });

        expect(post.message).toContain(`@${botUsername}`);
        testPostIds.push(post.id);
      });
    });

    describe('Long Messages', () => {
      it('should handle messages near 16K limit', async () => {
        // Create a long message (but under the 16K limit)
        const longContent = 'x'.repeat(10000);
        const message = `Long message start\n${longContent}\nLong message end`;

        const post = await ctx.api.createPost({
          channelId: ctx.channelId,
          message,
          userId: ctx.testUserId,
        });

        expect(post.message.length).toBeGreaterThan(10000);
        testPostIds.push(post.id);
      });
    });
  });
});
