/**
 * Reaction tests for multiple platforms
 *
 * Tests emoji reactions, which are critical for the permission system
 * and interactive features like plan approval and question answering.
 *
 * Parameterized to run against both Mattermost and Slack platforms.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import {
  createPlatformTestApi,
  type PlatformTestApi,
  type PlatformType,
  type PlatformTestReaction,
} from '../fixtures/platform-test-api.js';
import { loadConfig, DEFAULT_SLACK_CONFIG } from '../setup/config.js';

// Determine which platforms to test based on environment
const TEST_PLATFORMS = (process.env.TEST_PLATFORMS || 'mattermost').split(',') as PlatformType[];
const INTEGRATION_TEST = process.env.INTEGRATION_TEST === '1';

// Skip if not running integration tests
const SKIP = !INTEGRATION_TEST;

describe.skipIf(SKIP)('Reactions', () => {
  // Run tests for each configured platform
  describe.each(TEST_PLATFORMS)('%s platform', (platformType) => {
    let adminApi: PlatformTestApi;
    let userApi: PlatformTestApi;
    let user2Api: PlatformTestApi | null = null;
    let botApi: PlatformTestApi;
    let channelId: string;
    let botUserId: string;
    let testUserId: string;
    let testUser2Id: string | null = null;
    let testPostId: string;

    beforeAll(() => {
      const config = loadConfig();

      if (platformType === 'mattermost') {
        if (!config.mattermost.admin.token) {
          throw new Error('Admin token not found. Run setup-mattermost.ts first.');
        }
        if (!config.mattermost.bot.token) {
          throw new Error('Bot token not found. Run setup-mattermost.ts first.');
        }
        if (!config.mattermost.channel.id) {
          throw new Error('Channel ID not found. Run setup-mattermost.ts first.');
        }

        adminApi = createPlatformTestApi('mattermost', {
          baseUrl: config.mattermost.url,
          token: config.mattermost.admin.token,
          channelId: config.mattermost.channel.id,
        });
        botApi = createPlatformTestApi('mattermost', {
          baseUrl: config.mattermost.url,
          token: config.mattermost.bot.token,
          channelId: config.mattermost.channel.id,
        });

        channelId = config.mattermost.channel.id;
        botUserId = config.mattermost.bot.userId || '';

        if (config.mattermost.testUsers[0]?.token) {
          userApi = createPlatformTestApi('mattermost', {
            baseUrl: config.mattermost.url,
            token: config.mattermost.testUsers[0].token,
            channelId: config.mattermost.channel.id,
          });
          testUserId = config.mattermost.testUsers[0].userId || '';
        }
        if (config.mattermost.testUsers[1]?.token) {
          user2Api = createPlatformTestApi('mattermost', {
            baseUrl: config.mattermost.url,
            token: config.mattermost.testUsers[1].token,
            channelId: config.mattermost.channel.id,
          });
          testUser2Id = config.mattermost.testUsers[1].userId || null;
        }
      } else if (platformType === 'slack') {
        const slackConfig = config.slack || DEFAULT_SLACK_CONFIG;
        const baseUrl = process.env.SLACK_MOCK_URL || `http://localhost:${slackConfig.mockServerPort}/api`;

        // For Slack, all APIs use the bot token (mock server handles user context)
        adminApi = createPlatformTestApi('slack', {
          baseUrl,
          token: slackConfig.botToken,
          channelId: slackConfig.channelId,
        });
        botApi = createPlatformTestApi('slack', {
          baseUrl,
          token: slackConfig.botToken,
          channelId: slackConfig.channelId,
        });
        userApi = createPlatformTestApi('slack', {
          baseUrl,
          token: slackConfig.botToken,
          channelId: slackConfig.channelId,
        });

        channelId = slackConfig.channelId;
        botUserId = 'U_BOT_USER';
        testUserId = slackConfig.testUsers[0]?.userId || 'U_TEST_USER1';

        if (slackConfig.testUsers[1]) {
          user2Api = createPlatformTestApi('slack', {
            baseUrl,
            token: slackConfig.botToken,
            channelId: slackConfig.channelId,
          });
          testUser2Id = slackConfig.testUsers[1].userId || 'U_TEST_USER2';
        }
      } else {
        throw new Error(`Unknown platform: ${platformType}`);
      }
    });

    beforeEach(async () => {
      // Create a test post for reactions
      const post = await botApi.createPost({
        channelId,
        message: `Reaction test post - ${Date.now()}`,
        userId: botUserId,
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
        if (!testUserId) {
          throw new Error('Test user ID not found.');
        }

        const reaction = await userApi.addReaction(testPostId, '+1', testUserId);

        expect(reaction.emojiName).toBe('+1');
        expect(reaction.userId).toBe(testUserId);
      });

      it('should add thumbs down reaction', async () => {
        if (!testUserId) {
          throw new Error('Test user ID not found.');
        }

        const reaction = await userApi.addReaction(testPostId, '-1', testUserId);

        expect(reaction.emojiName).toBe('-1');
      });

      it('should add checkmark reaction', async () => {
        if (!testUserId) {
          throw new Error('Test user ID not found.');
        }

        const reaction = await userApi.addReaction(testPostId, 'white_check_mark', testUserId);

        expect(reaction.emojiName).toBe('white_check_mark');
      });

      it('should add number emoji reactions', async () => {
        if (!testUserId) {
          throw new Error('Test user ID not found.');
        }

        const numberEmojis = ['one', 'two', 'three'];

        for (const emoji of numberEmojis) {
          const reaction = await userApi.addReaction(testPostId, emoji, testUserId);
          expect(reaction.emojiName).toBe(emoji);
        }
      });

      it('should allow multiple users to react', async () => {
        if (!userApi || !user2Api) {
          console.log('Skipping: multiple test users not configured');
          return;
        }

        if (!testUserId || !testUser2Id) {
          throw new Error('Test user IDs not found.');
        }

        await userApi.addReaction(testPostId, '+1', testUserId);
        await user2Api.addReaction(testPostId, '+1', testUser2Id);

        const reactions = await adminApi.getReactions(testPostId);
        const thumbsUp = reactions.filter((r: PlatformTestReaction) => r.emojiName === '+1');

        expect(thumbsUp.length).toBe(2);
      });
    });

    describe('Removing Reactions', () => {
      it('should remove reaction', async () => {
        if (!testUserId) {
          throw new Error('Test user ID not found.');
        }

        // Add reaction first
        await userApi.addReaction(testPostId, '+1', testUserId);

        // Verify it exists
        let reactions = await adminApi.getReactions(testPostId);
        expect(reactions.some((r: PlatformTestReaction) => r.emojiName === '+1')).toBe(true);

        // Remove reaction
        await userApi.removeReaction(testPostId, '+1', testUserId);

        // Verify it's gone
        reactions = await adminApi.getReactions(testPostId);
        const userReaction = reactions.find(
          (r: PlatformTestReaction) => r.emojiName === '+1' && r.userId === testUserId,
        );
        expect(userReaction).toBeUndefined();
      });

      it('should allow removing one reaction while keeping others', async () => {
        if (!testUserId) {
          throw new Error('Test user ID not found.');
        }

        // Add multiple reactions
        await userApi.addReaction(testPostId, '+1', testUserId);
        await userApi.addReaction(testPostId, 'heart', testUserId);

        // Remove only thumbs up
        await userApi.removeReaction(testPostId, '+1', testUserId);

        // Verify heart is still there
        const reactions = await adminApi.getReactions(testPostId);
        expect(reactions.some((r: PlatformTestReaction) => r.emojiName === 'heart')).toBe(true);
        expect(reactions.some((r: PlatformTestReaction) => r.emojiName === '+1' && r.userId === testUserId)).toBe(false);
      });
    });

    describe('Bot Reactions', () => {
      it('should allow bot to add reactions', async () => {
        if (!botUserId) {
          throw new Error('Bot user ID not found.');
        }

        // Create a user post
        const userPost = await userApi.createPost({
          channelId,
          message: `User post for bot reaction - ${Date.now()}`,
          userId: testUserId,
        });

        try {
          const reaction = await botApi.addReaction(userPost.id, '+1', botUserId);

          expect(reaction.emojiName).toBe('+1');
          expect(reaction.userId).toBe(botUserId);
        } finally {
          await adminApi.deletePost(userPost.id);
        }
      });

      it('should allow bot to set up reaction options', async () => {
        if (!botUserId) {
          throw new Error('Bot user ID not found.');
        }

        // Bot adds reaction options (like the permission system does)
        await botApi.addReaction(testPostId, '+1', botUserId);
        await botApi.addReaction(testPostId, 'white_check_mark', botUserId);
        await botApi.addReaction(testPostId, '-1', botUserId);

        const reactions = await adminApi.getReactions(testPostId);
        const botReactions = reactions.filter((r: PlatformTestReaction) => r.userId === botUserId);

        expect(botReactions.length).toBe(3);
      });
    });

    describe('Reaction Retrieval', () => {
      it('should get all reactions on a post', async () => {
        if (!testUserId) {
          throw new Error('Test user ID not found.');
        }

        // Add various reactions
        await userApi.addReaction(testPostId, '+1', testUserId);
        await userApi.addReaction(testPostId, 'heart', testUserId);
        await userApi.addReaction(testPostId, 'smile', testUserId);

        const reactions = await adminApi.getReactions(testPostId);

        expect(reactions.length).toBeGreaterThanOrEqual(3);
        expect(reactions.some((r: PlatformTestReaction) => r.emojiName === '+1')).toBe(true);
        expect(reactions.some((r: PlatformTestReaction) => r.emojiName === 'heart')).toBe(true);
        expect(reactions.some((r: PlatformTestReaction) => r.emojiName === 'smile')).toBe(true);
      });

      it('should include user info in reactions', async () => {
        if (!testUserId) {
          throw new Error('Test user ID not found.');
        }

        await userApi.addReaction(testPostId, '+1', testUserId);

        const reactions = await adminApi.getReactions(testPostId);
        const userReaction = reactions.find((r: PlatformTestReaction) => r.userId === testUserId);

        expect(userReaction).toBeDefined();
        expect(userReaction?.userId).toBe(testUserId);
        expect(userReaction?.postId).toBe(testPostId);
      });
    });

    describe('Permission Emoji Flow', () => {
      it('should simulate permission approval flow', async () => {
        if (!botUserId || !testUserId) {
          throw new Error('Bot or user ID not found.');
        }

        // Bot sets up reaction options
        await botApi.addReaction(testPostId, '+1', botUserId);
        await botApi.addReaction(testPostId, 'white_check_mark', botUserId);
        await botApi.addReaction(testPostId, '-1', botUserId);

        // User approves
        await userApi.addReaction(testPostId, '+1', testUserId);

        // Verify user's approval reaction
        const reactions = await adminApi.getReactions(testPostId);
        const userApproval = reactions.find(
          (r: PlatformTestReaction) => r.emojiName === '+1' && r.userId === testUserId,
        );

        expect(userApproval).toBeDefined();
      });

      it('should distinguish bot reactions from user reactions', async () => {
        if (!botUserId || !testUserId) {
          throw new Error('Bot or user ID not found.');
        }

        // Both bot and user add same reaction
        await botApi.addReaction(testPostId, '+1', botUserId);
        await userApi.addReaction(testPostId, '+1', testUserId);

        const reactions = await adminApi.getReactions(testPostId);
        const thumbsUp = reactions.filter((r: PlatformTestReaction) => r.emojiName === '+1');

        // Should have two separate reactions
        expect(thumbsUp.length).toBe(2);

        // Can identify which is from bot vs user
        const botReaction = thumbsUp.find((r: PlatformTestReaction) => r.userId === botUserId);
        const userReaction = thumbsUp.find((r: PlatformTestReaction) => r.userId === testUserId);

        expect(botReaction).toBeDefined();
        expect(userReaction).toBeDefined();
      });
    });
  });
});
