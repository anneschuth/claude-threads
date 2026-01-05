/**
 * Reaction tests for Mattermost
 *
 * Tests emoji reactions, which are critical for the permission system
 * and interactive features like plan approval and question answering.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import { MattermostTestApi } from '../fixtures/mattermost/api-helpers.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

describe.skipIf(SKIP)('Reactions', () => {
  let adminApi: MattermostTestApi;
  let userApi: MattermostTestApi;
  let user2Api: MattermostTestApi;
  let botApi: MattermostTestApi;
  let config: ReturnType<typeof loadConfig>;
  let testPostId: string;

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
    if (config.mattermost.testUsers[1]?.token) {
      user2Api = new MattermostTestApi(config.mattermost.url, config.mattermost.testUsers[1].token);
    }
  });

  beforeEach(async () => {
    if (!config.mattermost.channel.id) {
      throw new Error('Channel ID not found.');
    }

    // Create a test post for reactions
    const post = await botApi.createPost({
      channel_id: config.mattermost.channel.id,
      message: `Reaction test post - ${Date.now()}`,
    });
    testPostId = post.id;
  });

  afterEach(async () => {
    // Cleanup test post
    if (testPostId) {
      try {
        await adminApi.deletePost(testPostId);
      } catch {
        // Ignore errors
      }
    }
  });

  describe('Adding Reactions', () => {
    it('should add thumbs up reaction', async () => {
      if (!config.mattermost.testUsers[0]?.userId) {
        throw new Error('Test user ID not found.');
      }

      const reaction = await userApi.addReaction(
        testPostId,
        '+1',
        config.mattermost.testUsers[0].userId,
      );

      expect(reaction.emoji_name).toBe('+1');
      expect(reaction.user_id).toBe(config.mattermost.testUsers[0].userId);
    });

    it('should add thumbs down reaction', async () => {
      if (!config.mattermost.testUsers[0]?.userId) {
        throw new Error('Test user ID not found.');
      }

      const reaction = await userApi.addReaction(
        testPostId,
        '-1',
        config.mattermost.testUsers[0].userId,
      );

      expect(reaction.emoji_name).toBe('-1');
    });

    it('should add checkmark reaction', async () => {
      if (!config.mattermost.testUsers[0]?.userId) {
        throw new Error('Test user ID not found.');
      }

      const reaction = await userApi.addReaction(
        testPostId,
        'white_check_mark',
        config.mattermost.testUsers[0].userId,
      );

      expect(reaction.emoji_name).toBe('white_check_mark');
    });

    it('should add number emoji reactions', async () => {
      if (!config.mattermost.testUsers[0]?.userId) {
        throw new Error('Test user ID not found.');
      }

      const numberEmojis = ['one', 'two', 'three'];

      for (const emoji of numberEmojis) {
        const reaction = await userApi.addReaction(
          testPostId,
          emoji,
          config.mattermost.testUsers[0].userId,
        );
        expect(reaction.emoji_name).toBe(emoji);
      }
    });

    it('should allow multiple users to react', async () => {
      if (!userApi || !user2Api) {
        console.log('Skipping: multiple test users not configured');
        return;
      }

      const user1Id = config.mattermost.testUsers[0]?.userId;
      const user2Id = config.mattermost.testUsers[1]?.userId;

      if (!user1Id || !user2Id) {
        throw new Error('Test user IDs not found.');
      }

      await userApi.addReaction(testPostId, '+1', user1Id);
      await user2Api.addReaction(testPostId, '+1', user2Id);

      const reactions = await adminApi.getReactions(testPostId);
      const thumbsUp = reactions.filter((r) => r.emoji_name === '+1');

      expect(thumbsUp.length).toBe(2);
    });
  });

  describe('Removing Reactions', () => {
    it('should remove reaction', async () => {
      if (!config.mattermost.testUsers[0]?.userId) {
        throw new Error('Test user ID not found.');
      }

      // Add reaction first
      await userApi.addReaction(testPostId, '+1', config.mattermost.testUsers[0].userId);

      // Verify it exists
      let reactions = await adminApi.getReactions(testPostId);
      expect(reactions.some((r) => r.emoji_name === '+1')).toBe(true);

      // Remove reaction
      await userApi.removeReaction(testPostId, '+1', config.mattermost.testUsers[0].userId);

      // Verify it's gone
      reactions = await adminApi.getReactions(testPostId);
      const userReaction = reactions.find(
        (r) => r.emoji_name === '+1' && r.user_id === config.mattermost.testUsers[0].userId,
      );
      expect(userReaction).toBeUndefined();
    });

    it('should allow removing one reaction while keeping others', async () => {
      if (!config.mattermost.testUsers[0]?.userId) {
        throw new Error('Test user ID not found.');
      }

      const userId = config.mattermost.testUsers[0].userId;

      // Add multiple reactions
      await userApi.addReaction(testPostId, '+1', userId);
      await userApi.addReaction(testPostId, 'heart', userId);

      // Remove only thumbs up
      await userApi.removeReaction(testPostId, '+1', userId);

      // Verify heart is still there
      const reactions = await adminApi.getReactions(testPostId);
      expect(reactions.some((r) => r.emoji_name === 'heart')).toBe(true);
      expect(reactions.some((r) => r.emoji_name === '+1' && r.user_id === userId)).toBe(false);
    });
  });

  describe('Bot Reactions', () => {
    it('should allow bot to add reactions', async () => {
      if (!config.mattermost.bot.userId) {
        throw new Error('Bot user ID not found.');
      }

      // Create a user post
      const userPost = await userApi.createPost({
        channel_id: config.mattermost.channel.id!,
        message: `User post for bot reaction - ${Date.now()}`,
      });

      try {
        const reaction = await botApi.addReaction(
          userPost.id,
          '+1',
          config.mattermost.bot.userId,
        );

        expect(reaction.emoji_name).toBe('+1');
        expect(reaction.user_id).toBe(config.mattermost.bot.userId);
      } finally {
        await adminApi.deletePost(userPost.id);
      }
    });

    it('should allow bot to set up reaction options', async () => {
      if (!config.mattermost.bot.userId) {
        throw new Error('Bot user ID not found.');
      }

      // Bot adds reaction options (like the permission system does)
      const botUserId = config.mattermost.bot.userId;
      await botApi.addReaction(testPostId, '+1', botUserId);
      await botApi.addReaction(testPostId, 'white_check_mark', botUserId);
      await botApi.addReaction(testPostId, '-1', botUserId);

      const reactions = await adminApi.getReactions(testPostId);
      const botReactions = reactions.filter((r) => r.user_id === botUserId);

      expect(botReactions.length).toBe(3);
    });
  });

  describe('Reaction Retrieval', () => {
    it('should get all reactions on a post', async () => {
      if (!config.mattermost.testUsers[0]?.userId) {
        throw new Error('Test user ID not found.');
      }

      const userId = config.mattermost.testUsers[0].userId;

      // Add various reactions
      await userApi.addReaction(testPostId, '+1', userId);
      await userApi.addReaction(testPostId, 'heart', userId);
      await userApi.addReaction(testPostId, 'smile', userId);

      const reactions = await adminApi.getReactions(testPostId);

      expect(reactions.length).toBeGreaterThanOrEqual(3);
      expect(reactions.some((r) => r.emoji_name === '+1')).toBe(true);
      expect(reactions.some((r) => r.emoji_name === 'heart')).toBe(true);
      expect(reactions.some((r) => r.emoji_name === 'smile')).toBe(true);
    });

    it('should include user info in reactions', async () => {
      if (!config.mattermost.testUsers[0]?.userId) {
        throw new Error('Test user ID not found.');
      }

      const userId = config.mattermost.testUsers[0].userId;
      await userApi.addReaction(testPostId, '+1', userId);

      const reactions = await adminApi.getReactions(testPostId);
      const userReaction = reactions.find((r) => r.user_id === userId);

      expect(userReaction).toBeDefined();
      expect(userReaction?.user_id).toBe(userId);
      expect(userReaction?.post_id).toBe(testPostId);
    });
  });

  describe('Permission Emoji Flow', () => {
    it('should simulate permission approval flow', async () => {
      if (!config.mattermost.bot.userId || !config.mattermost.testUsers[0]?.userId) {
        throw new Error('Bot or user ID not found.');
      }

      const botUserId = config.mattermost.bot.userId;
      const userId = config.mattermost.testUsers[0].userId;

      // Bot sets up reaction options
      await botApi.addReaction(testPostId, '+1', botUserId);
      await botApi.addReaction(testPostId, 'white_check_mark', botUserId);
      await botApi.addReaction(testPostId, '-1', botUserId);

      // User approves
      await userApi.addReaction(testPostId, '+1', userId);

      // Verify user's approval reaction
      const reactions = await adminApi.getReactions(testPostId);
      const userApproval = reactions.find(
        (r) => r.emoji_name === '+1' && r.user_id === userId,
      );

      expect(userApproval).toBeDefined();
    });

    it('should distinguish bot reactions from user reactions', async () => {
      if (!config.mattermost.bot.userId || !config.mattermost.testUsers[0]?.userId) {
        throw new Error('Bot or user ID not found.');
      }

      const botUserId = config.mattermost.bot.userId;
      const userId = config.mattermost.testUsers[0].userId;

      // Both bot and user add same reaction
      await botApi.addReaction(testPostId, '+1', botUserId);
      await userApi.addReaction(testPostId, '+1', userId);

      const reactions = await adminApi.getReactions(testPostId);
      const thumbsUp = reactions.filter((r) => r.emoji_name === '+1');

      // Should have two separate reactions
      expect(thumbsUp.length).toBe(2);

      // Can identify which is from bot vs user
      const botReaction = thumbsUp.find((r) => r.user_id === botUserId);
      const userReaction = thumbsUp.find((r) => r.user_id === userId);

      expect(botReaction).toBeDefined();
      expect(userReaction).toBeDefined();
    });
  });
});
