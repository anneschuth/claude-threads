/**
 * Connection tests for Mattermost WebSocket and REST API
 *
 * Tests basic connectivity without requiring the full claude-threads bot.
 * Uses direct API access to verify Mattermost is properly configured.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import { MattermostTestApi } from '../fixtures/mattermost/api-helpers.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

describe.skipIf(SKIP)('Mattermost Connection', () => {
  let adminApi: MattermostTestApi;
  let userApi: MattermostTestApi;
  let config: ReturnType<typeof loadConfig>;

  beforeAll(() => {
    config = loadConfig();

    if (!config.mattermost.admin.token) {
      throw new Error('Admin token not found. Run setup-mattermost.ts first.');
    }

    adminApi = new MattermostTestApi(config.mattermost.url, config.mattermost.admin.token);

    if (config.mattermost.testUsers[0]?.token) {
      userApi = new MattermostTestApi(config.mattermost.url, config.mattermost.testUsers[0].token);
    }
  });

  describe('Health Check', () => {
    it('should respond to ping endpoint', async () => {
      const response = await fetch(`${config.mattermost.url}/api/v4/system/ping`);
      expect(response.ok).toBe(true);
    });
  });

  describe('Authentication', () => {
    it('should authenticate admin user', async () => {
      const me = await adminApi.getMe();
      expect(me.username).toBe(config.mattermost.admin.username);
    });

    it('should authenticate test user', async () => {
      if (!userApi) {
        console.log('Skipping: test user not configured');
        return;
      }

      const me = await userApi.getMe();
      expect(me.username).toBe(config.mattermost.testUsers[0].username);
    });
  });

  describe('Team and Channel Access', () => {
    it('should access test team', async () => {
      if (!config.mattermost.team.id) {
        throw new Error('Team ID not found. Run setup-mattermost.ts first.');
      }

      const team = await adminApi.getTeamByName(config.mattermost.team.name);
      expect(team.id).toBe(config.mattermost.team.id);
    });

    it('should access test channel', async () => {
      if (!config.mattermost.channel.id || !config.mattermost.team.id) {
        throw new Error('Channel or Team ID not found. Run setup-mattermost.ts first.');
      }

      const channel = await adminApi.getChannelByName(
        config.mattermost.team.id,
        config.mattermost.channel.name,
      );
      expect(channel.id).toBe(config.mattermost.channel.id);
    });
  });

  describe('Bot Account', () => {
    it('should have bot account configured', async () => {
      if (!config.mattermost.bot.userId) {
        throw new Error('Bot user ID not found. Run setup-mattermost.ts first.');
      }

      const botUser = await adminApi.getUser(config.mattermost.bot.userId);
      expect(botUser.username).toBe(config.mattermost.bot.username);
    });

    it('should have bot access token', () => {
      expect(config.mattermost.bot.token).toBeDefined();
      expect(config.mattermost.bot.token?.length).toBeGreaterThan(10);
    });
  });

  describe('Post Operations', () => {
    let testPostId: string | null = null;

    afterAll(async () => {
      // Cleanup: delete test post
      if (testPostId) {
        try {
          await adminApi.deletePost(testPostId);
        } catch {
          // Ignore cleanup errors
        }
      }
    });

    it('should create a post', async () => {
      if (!config.mattermost.channel.id) {
        throw new Error('Channel ID not found.');
      }

      const post = await adminApi.createPost({
        channel_id: config.mattermost.channel.id,
        message: `Integration test post - ${Date.now()}`,
      });

      expect(post.id).toBeDefined();
      expect(post.message).toContain('Integration test');
      testPostId = post.id;
    });

    it('should read a post', async () => {
      if (!testPostId) {
        throw new Error('Test post not created.');
      }

      const post = await adminApi.getPost(testPostId);
      expect(post.id).toBe(testPostId);
    });

    it('should update a post', async () => {
      if (!testPostId) {
        throw new Error('Test post not created.');
      }

      const updatedMessage = `Updated integration test - ${Date.now()}`;
      const post = await adminApi.updatePost(testPostId, updatedMessage);
      expect(post.message).toBe(updatedMessage);
    });

    it('should create a reply (thread)', async () => {
      if (!testPostId || !config.mattermost.channel.id) {
        throw new Error('Test post or channel not available.');
      }

      const reply = await adminApi.createPost({
        channel_id: config.mattermost.channel.id,
        message: `Reply to test - ${Date.now()}`,
        root_id: testPostId,
      });

      expect(reply.root_id).toBe(testPostId);

      // Cleanup
      await adminApi.deletePost(reply.id);
    });
  });

  describe('Reaction Operations', () => {
    let testPostId: string | null = null;

    beforeAll(async () => {
      if (!config.mattermost.channel.id) {
        throw new Error('Channel ID not found.');
      }

      // Create a test post for reactions
      const post = await adminApi.createPost({
        channel_id: config.mattermost.channel.id,
        message: `Reaction test post - ${Date.now()}`,
      });
      testPostId = post.id;
    });

    afterAll(async () => {
      if (testPostId) {
        try {
          await adminApi.deletePost(testPostId);
        } catch {
          // Ignore cleanup errors
        }
      }
    });

    it('should add a reaction', async () => {
      if (!testPostId || !config.mattermost.admin.userId) {
        throw new Error('Test post or admin user ID not available.');
      }

      const reaction = await adminApi.addReaction(testPostId, '+1', config.mattermost.admin.userId);
      expect(reaction.emoji_name).toBe('+1');
    });

    it('should list reactions on a post', async () => {
      if (!testPostId) {
        throw new Error('Test post not available.');
      }

      const reactions = await adminApi.getReactions(testPostId);
      expect(reactions.length).toBeGreaterThanOrEqual(1);
      expect(reactions.some((r) => r.emoji_name === '+1')).toBe(true);
    });

    it('should remove a reaction', async () => {
      if (!testPostId || !config.mattermost.admin.userId) {
        throw new Error('Test post or admin user ID not available.');
      }

      await adminApi.removeReaction(testPostId, '+1', config.mattermost.admin.userId);

      const reactions = await adminApi.getReactions(testPostId);
      expect(reactions.some((r) => r.emoji_name === '+1' && r.user_id === config.mattermost.admin.userId)).toBe(false);
    });
  });
});
