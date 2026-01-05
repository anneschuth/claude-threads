/**
 * Messaging tests for Mattermost REST API
 *
 * Tests post creation, updates, threading, and channel operations.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import { MattermostTestApi } from '../fixtures/mattermost/api-helpers.js';

describe('Messaging', () => {
  let adminApi: MattermostTestApi;
  let userApi: MattermostTestApi;
  let botApi: MattermostTestApi;
  let config: ReturnType<typeof loadConfig>;
  let testPostIds: string[] = [];

  beforeAll(() => {
    config = loadConfig();

    if (!config.mattermost.admin.token) {
      throw new Error('Admin token not found. Run setup-mattermost.ts first.');
    }
    if (!config.mattermost.bot.token) {
      throw new Error('Bot token not found. Run setup-mattermost.ts first.');
    }

    adminApi = new MattermostTestApi(config.mattermost.url, config.mattermost.admin.token);
    botApi = new MattermostTestApi(config.mattermost.url, config.mattermost.bot.token);

    if (config.mattermost.testUsers[0]?.token) {
      userApi = new MattermostTestApi(config.mattermost.url, config.mattermost.testUsers[0].token);
    }
  });

  afterEach(async () => {
    // Cleanup test posts
    for (const postId of testPostIds) {
      try {
        await adminApi.deletePost(postId);
      } catch {
        // Ignore errors
      }
    }
    testPostIds = [];
  });

  describe('Post Creation', () => {
    it('should create a post as user', async () => {
      if (!config.mattermost.channel.id) {
        throw new Error('Channel ID not found.');
      }

      const message = `User post - ${Date.now()}`;
      const post = await userApi.createPost({
        channel_id: config.mattermost.channel.id,
        message,
      });

      expect(post.message).toBe(message);
      expect(post.user_id).toBe(config.mattermost.testUsers[0].userId);
      testPostIds.push(post.id);
    });

    it('should create a post as bot', async () => {
      if (!config.mattermost.channel.id || !config.mattermost.bot.userId) {
        throw new Error('Channel or Bot ID not found.');
      }

      const message = `Bot post - ${Date.now()}`;
      const post = await botApi.createPost({
        channel_id: config.mattermost.channel.id,
        message,
      });

      expect(post.message).toBe(message);
      expect(post.user_id).toBe(config.mattermost.bot.userId);
      testPostIds.push(post.id);
    });

    it('should create posts with markdown', async () => {
      if (!config.mattermost.channel.id) {
        throw new Error('Channel ID not found.');
      }

      const message = `**Bold** and _italic_ and \`code\`\n\n\`\`\`javascript\nconst x = 1;\n\`\`\``;
      const post = await adminApi.createPost({
        channel_id: config.mattermost.channel.id,
        message,
      });

      expect(post.message).toBe(message);
      testPostIds.push(post.id);
    });
  });

  describe('Threading', () => {
    let rootPostId: string;

    beforeEach(async () => {
      if (!config.mattermost.channel.id) {
        throw new Error('Channel ID not found.');
      }

      const rootPost = await userApi.createPost({
        channel_id: config.mattermost.channel.id,
        message: `Thread root - ${Date.now()}`,
      });
      rootPostId = rootPost.id;
      testPostIds.push(rootPostId);
    });

    it('should create reply in thread', async () => {
      if (!config.mattermost.channel.id) {
        throw new Error('Channel ID not found.');
      }

      const reply = await userApi.createPost({
        channel_id: config.mattermost.channel.id,
        message: `Reply - ${Date.now()}`,
        root_id: rootPostId,
      });

      expect(reply.root_id).toBe(rootPostId);
      testPostIds.push(reply.id);
    });

    it('should get all posts in thread', async () => {
      if (!config.mattermost.channel.id) {
        throw new Error('Channel ID not found.');
      }

      // Create multiple replies
      for (let i = 0; i < 3; i++) {
        const reply = await userApi.createPost({
          channel_id: config.mattermost.channel.id,
          message: `Reply ${i + 1} - ${Date.now()}`,
          root_id: rootPostId,
        });
        testPostIds.push(reply.id);
      }

      const { posts, order } = await userApi.getThreadPosts(rootPostId);

      expect(Object.keys(posts).length).toBeGreaterThanOrEqual(4); // root + 3 replies
      expect(order).toContain(rootPostId);
    });

    it('should allow bot to reply in user-started thread', async () => {
      if (!config.mattermost.channel.id) {
        throw new Error('Channel ID not found.');
      }

      const botReply = await botApi.createPost({
        channel_id: config.mattermost.channel.id,
        message: `Bot reply - ${Date.now()}`,
        root_id: rootPostId,
      });

      expect(botReply.root_id).toBe(rootPostId);
      expect(botReply.user_id).toBe(config.mattermost.bot.userId);
      testPostIds.push(botReply.id);
    });
  });

  describe('Post Updates', () => {
    let testPostId: string;

    beforeEach(async () => {
      if (!config.mattermost.channel.id) {
        throw new Error('Channel ID not found.');
      }

      const post = await userApi.createPost({
        channel_id: config.mattermost.channel.id,
        message: `Original message - ${Date.now()}`,
      });
      testPostId = post.id;
      testPostIds.push(testPostId);
    });

    it('should update post content', async () => {
      const newMessage = `Updated message - ${Date.now()}`;
      const updated = await userApi.updatePost(testPostId, newMessage);

      expect(updated.message).toBe(newMessage);
    });

    it('should preserve post ID after update', async () => {
      const newMessage = `Updated again - ${Date.now()}`;
      const updated = await userApi.updatePost(testPostId, newMessage);

      expect(updated.id).toBe(testPostId);
    });

    it('bot should update its own posts', async () => {
      if (!config.mattermost.channel.id) {
        throw new Error('Channel ID not found.');
      }

      const botPost = await botApi.createPost({
        channel_id: config.mattermost.channel.id,
        message: `Bot original - ${Date.now()}`,
      });
      testPostIds.push(botPost.id);

      const newMessage = `Bot updated - ${Date.now()}`;
      const updated = await botApi.updatePost(botPost.id, newMessage);

      expect(updated.message).toBe(newMessage);
    });
  });

  describe('Mention Detection', () => {
    it('should include mention in post', async () => {
      if (!config.mattermost.channel.id) {
        throw new Error('Channel ID not found.');
      }

      const botUsername = config.mattermost.bot.username;
      const message = `@${botUsername} please help`;
      const post = await userApi.createPost({
        channel_id: config.mattermost.channel.id,
        message,
      });

      expect(post.message).toContain(`@${botUsername}`);
      testPostIds.push(post.id);
    });
  });

  describe('Long Messages', () => {
    it('should handle messages near 16K limit', async () => {
      if (!config.mattermost.channel.id) {
        throw new Error('Channel ID not found.');
      }

      // Create a long message (but under the 16K limit)
      const longContent = 'x'.repeat(10000);
      const message = `Long message start\n${longContent}\nLong message end`;

      const post = await adminApi.createPost({
        channel_id: config.mattermost.channel.id,
        message,
      });

      expect(post.message.length).toBeGreaterThan(10000);
      testPostIds.push(post.id);
    });
  });
});
