/**
 * Connection tests for platform WebSocket and REST API
 *
 * Tests basic connectivity without requiring the full claude-threads bot.
 * Uses direct API access to verify platforms are properly configured.
 *
 * Parameterized to run against both Mattermost and Slack platforms.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import {
  createPlatformTestApi,
  type PlatformTestApi,
  type PlatformType,
  type PlatformTestReaction,
  MattermostTestApi,
} from '../fixtures/platform-test-api.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

// Determine which platforms to test based on environment
const TEST_PLATFORMS = (process.env.TEST_PLATFORMS || 'mattermost').split(',') as PlatformType[];

describe.skipIf(SKIP)('Platform Connection', () => {
  // Run tests for each configured platform
  describe.each(TEST_PLATFORMS)('%s platform', (platformType) => {
    let api: PlatformTestApi;
    let channelId: string;
    let testUserId: string;
    let config: ReturnType<typeof loadConfig>;

    // Mattermost-specific: admin API for privileged operations
    let adminApi: MattermostTestApi | null = null;

    beforeAll(() => {
      config = loadConfig();

      if (platformType === 'mattermost') {
        if (!config.mattermost.admin.token) {
          throw new Error('Admin token not found. Run setup-mattermost.ts first.');
        }

        // Set up admin API for Mattermost-specific tests
        adminApi = new MattermostTestApi(config.mattermost.url, config.mattermost.admin.token);

        // Set up test user API
        if (config.mattermost.testUsers[0]?.token) {
          api = createPlatformTestApi('mattermost', {
            baseUrl: config.mattermost.url,
            token: config.mattermost.testUsers[0].token,
            channelId: config.mattermost.channel.id,
          });
          testUserId = config.mattermost.testUsers[0].userId || '';
        } else {
          // Fall back to admin API
          api = createPlatformTestApi('mattermost', {
            baseUrl: config.mattermost.url,
            token: config.mattermost.admin.token,
            channelId: config.mattermost.channel.id,
          });
          testUserId = config.mattermost.admin.userId || '';
        }

        channelId = config.mattermost.channel.id || '';
      } else if (platformType === 'slack') {
        if (!config.slack?.botToken) {
          throw new Error('Slack bot token not found');
        }

        api = createPlatformTestApi('slack', {
          baseUrl: process.env.SLACK_MOCK_URL || `http://localhost:${config.slack.mockServerPort}/api`,
          token: config.slack.botToken,
          channelId: config.slack.channelId,
        });
        channelId = config.slack.channelId;
        testUserId = config.slack.testUsers[0]?.userId || 'U_TEST_USER1';
      } else {
        throw new Error(`Unknown platform: ${platformType}`);
      }
    });

    // =========================================================================
    // Platform-Agnostic Tests
    // =========================================================================

    describe('Health Check', () => {
      it('should respond to health endpoint', async () => {
        if (platformType === 'mattermost') {
          const response = await fetch(`${config.mattermost.url}/api/v4/system/ping`);
          expect(response.ok).toBe(true);
        } else if (platformType === 'slack') {
          // For Slack mock server, just verify we can make an API call
          // The api.test endpoint is a standard Slack API test endpoint
          const baseUrl = process.env.SLACK_MOCK_URL || `http://localhost:${config.slack?.mockServerPort}/api`;
          const response = await fetch(`${baseUrl}/api.test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });
          expect(response.ok).toBe(true);
        }
      });
    });

    describe('Post Operations', () => {
      let testPostId: string | null = null;

      afterAll(async () => {
        // Cleanup: delete test post
        if (testPostId) {
          try {
            await api.deletePost(testPostId);
          } catch {
            // Ignore cleanup errors
          }
        }
      });

      it('should create a post', async () => {
        const post = await api.createPost({
          channelId,
          message: `Integration test post - ${Date.now()}`,
          userId: testUserId,
        });

        expect(post.id).toBeDefined();
        expect(post.message).toContain('Integration test');
        testPostId = post.id;
      });

      it('should read a post', async () => {
        if (!testPostId) {
          throw new Error('Test post not created.');
        }

        const post = await api.getPost(testPostId);
        expect(post.id).toBe(testPostId);
      });

      it('should update a post', async () => {
        if (!testPostId) {
          throw new Error('Test post not created.');
        }

        const updatedMessage = `Updated integration test - ${Date.now()}`;
        const post = await api.updatePost(testPostId, updatedMessage);
        expect(post.message).toBe(updatedMessage);
      });

      it('should create a reply (thread)', async () => {
        if (!testPostId) {
          throw new Error('Test post not available.');
        }

        const reply = await api.createPost({
          channelId,
          message: `Reply to test - ${Date.now()}`,
          rootId: testPostId,
          userId: testUserId,
        });

        expect(reply.rootId).toBe(testPostId);

        // Cleanup
        await api.deletePost(reply.id);
      });
    });

    describe('Reaction Operations', () => {
      let testPostId: string | null = null;

      beforeAll(async () => {
        // Create a test post for reactions
        const post = await api.createPost({
          channelId,
          message: `Reaction test post - ${Date.now()}`,
          userId: testUserId,
        });
        testPostId = post.id;
      });

      afterAll(async () => {
        if (testPostId) {
          try {
            await api.deletePost(testPostId);
          } catch {
            // Ignore cleanup errors
          }
        }
      });

      it('should add a reaction', async () => {
        if (!testPostId) {
          throw new Error('Test post not available.');
        }

        // Use platform-agnostic emoji name
        const emojiName = platformType === 'mattermost' ? '+1' : 'thumbsup';
        const reaction = await api.addReaction(testPostId, emojiName, testUserId);
        expect(reaction.emojiName).toBe(emojiName);
      });

      it('should list reactions on a post', async () => {
        if (!testPostId) {
          throw new Error('Test post not available.');
        }

        const reactions = await api.getReactions(testPostId);
        expect(reactions.length).toBeGreaterThanOrEqual(1);
        // Check for either emoji name since platforms differ
        const hasReaction = reactions.some(
          (r: PlatformTestReaction) => r.emojiName === '+1' || r.emojiName === 'thumbsup'
        );
        expect(hasReaction).toBe(true);
      });

      it('should remove a reaction', async () => {
        if (!testPostId) {
          throw new Error('Test post not available.');
        }

        const emojiName = platformType === 'mattermost' ? '+1' : 'thumbsup';
        await api.removeReaction(testPostId, emojiName, testUserId);

        const reactions = await api.getReactions(testPostId);
        const hasReaction = reactions.some(
          (r: PlatformTestReaction) =>
            (r.emojiName === '+1' || r.emojiName === 'thumbsup') && r.userId === testUserId
        );
        expect(hasReaction).toBe(false);
      });
    });

    // =========================================================================
    // Mattermost-Specific Tests
    // =========================================================================

    if (platformType === 'mattermost') {
      describe('Mattermost Authentication', () => {
        it('should authenticate admin user', async () => {
          if (!adminApi) {
            throw new Error('Admin API not available');
          }

          const me = await adminApi.getMe();
          expect(me.username).toBe(config.mattermost.admin.username);
        });

        it('should authenticate test user', async () => {
          if (!config.mattermost.testUsers[0]?.token) {
            console.log('Skipping: test user not configured');
            return;
          }

          const userApi = new MattermostTestApi(
            config.mattermost.url,
            config.mattermost.testUsers[0].token
          );
          const me = await userApi.getMe();
          expect(me.username).toBe(config.mattermost.testUsers[0].username);
        });
      });

      describe('Mattermost Team and Channel Access', () => {
        it('should access test team', async () => {
          if (!adminApi || !config.mattermost.team.id) {
            throw new Error('Admin API or Team ID not found. Run setup-mattermost.ts first.');
          }

          const team = await adminApi.getTeamByName(config.mattermost.team.name);
          expect(team.id).toBe(config.mattermost.team.id);
        });

        it('should access test channel', async () => {
          if (!adminApi || !config.mattermost.channel.id || !config.mattermost.team.id) {
            throw new Error('Channel or Team ID not found. Run setup-mattermost.ts first.');
          }

          const channel = await adminApi.getChannelByName(
            config.mattermost.team.id,
            config.mattermost.channel.name
          );
          expect(channel.id).toBe(config.mattermost.channel.id);
        });
      });

      describe('Mattermost Bot Account', () => {
        it('should have bot account configured', async () => {
          if (!adminApi || !config.mattermost.bot.userId) {
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
    }

    // =========================================================================
    // Slack-Specific Tests
    // =========================================================================

    if (platformType === 'slack') {
      describe('Slack Configuration', () => {
        it('should have bot token configured', () => {
          expect(config.slack?.botToken).toBeDefined();
          expect(config.slack?.botToken.length).toBeGreaterThan(5);
        });

        it('should have channel ID configured', () => {
          expect(config.slack?.channelId).toBeDefined();
          expect(config.slack?.channelId.length).toBeGreaterThan(0);
        });

        it('should have test users configured', () => {
          expect(config.slack?.testUsers).toBeDefined();
          expect(config.slack?.testUsers.length).toBeGreaterThan(0);
          expect(config.slack?.testUsers[0].userId).toBeDefined();
        });
      });
    }
  });
});
