/**
 * Example parameterized test that can run against multiple platforms
 *
 * This demonstrates how to write platform-agnostic integration tests
 * that work with both Mattermost and Slack.
 *
 * Usage:
 *   TEST_PLATFORMS=mattermost bun test platform-example.test.ts
 *   TEST_PLATFORMS=slack bun test platform-example.test.ts
 *   TEST_PLATFORMS=mattermost,slack bun test platform-example.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import {
  createPlatformTestApi,
  type PlatformTestApi,
  type PlatformType,
  type PlatformTestReaction,
} from '../fixtures/platform-test-api.js';
import { loadConfig } from '../setup/config.js';

// Determine which platforms to test based on environment
const TEST_PLATFORMS = (process.env.TEST_PLATFORMS || 'mattermost').split(',') as PlatformType[];
const INTEGRATION_TEST = process.env.INTEGRATION_TEST === '1';

// Skip if not running integration tests
const SKIP = !INTEGRATION_TEST;

describe.skipIf(SKIP)('Platform API', () => {
  // Run tests for each configured platform
  describe.each(TEST_PLATFORMS)('%s platform', (platformType) => {
    let api: PlatformTestApi;
    let channelId: string;
    let testUserId: string;

    beforeAll(() => {
      const config = loadConfig();

      if (platformType === 'mattermost') {
        if (!config.mattermost?.testUsers?.[0]?.token) {
          throw new Error('Mattermost test user credentials not found');
        }
        api = createPlatformTestApi('mattermost', {
          baseUrl: config.mattermost.url,
          token: config.mattermost.testUsers[0].token,
          channelId: config.mattermost.channel.id,
        });
        channelId = config.mattermost.channel.id || '';
        testUserId = config.mattermost.testUsers[0].userId || '';
      } else if (platformType === 'slack') {
        if (!config.slack?.botToken) {
          throw new Error('Slack bot token not found');
        }
        api = createPlatformTestApi('slack', {
          baseUrl: process.env.SLACK_MOCK_URL || 'http://localhost:3457/api',
          token: config.slack.botToken,
          channelId: config.slack.channelId,
        });
        channelId = config.slack.channelId;
        testUserId = config.slack.testUsers[0]?.userId || 'U_TEST_USER';
      } else {
        throw new Error(`Unknown platform: ${platformType}`);
      }
    });

    afterAll(async () => {
      // Cleanup is handled per-test
    });

    describe('Messages', () => {
      it('can create a post', async () => {
        const post = await api.createPost({
          channelId,
          message: `Test message from ${platformType} at ${Date.now()}`,
        });

        expect(post.id).toBeTruthy();
        expect(post.channelId).toBe(channelId);
        expect(post.message).toContain('Test message');

        // Cleanup
        await api.deletePost(post.id);
      });

      it('can update a post', async () => {
        const post = await api.createPost({
          channelId,
          message: 'Original message',
        });

        const updated = await api.updatePost(post.id, 'Updated message');

        expect(updated.id).toBe(post.id);
        expect(updated.message).toBe('Updated message');

        // Cleanup
        await api.deletePost(post.id);
      });

      it('can create threaded replies', async () => {
        // Create root post
        const root = await api.createPost({
          channelId,
          message: 'Thread root',
        });

        // Create reply
        const reply = await api.createPost({
          channelId,
          message: 'Thread reply',
          rootId: root.id,
        });

        expect(reply.rootId).toBe(root.id);

        // Verify thread posts
        const threadPosts = await api.getThreadPosts(root.id);
        expect(threadPosts.length).toBeGreaterThanOrEqual(2);

        // Cleanup
        await api.deletePost(reply.id);
        await api.deletePost(root.id);
      });
    });

    describe('Reactions', () => {
      it('can add a reaction', async () => {
        const post = await api.createPost({
          channelId,
          message: 'Reaction test post',
        });

        await api.addReaction(post.id, 'thumbsup', testUserId);

        const reactions = await api.getReactions(post.id);
        expect(reactions.some((r: PlatformTestReaction) => r.emojiName === 'thumbsup')).toBe(true);

        // Cleanup
        await api.removeReaction(post.id, 'thumbsup', testUserId);
        await api.deletePost(post.id);
      });

      it('can remove a reaction', async () => {
        const post = await api.createPost({
          channelId,
          message: 'Reaction removal test',
        });

        // Add then remove
        await api.addReaction(post.id, 'thumbsup', testUserId);
        await api.removeReaction(post.id, 'thumbsup', testUserId);

        const reactions = await api.getReactions(post.id);
        const hasThumbsup = reactions.some(
          (r: PlatformTestReaction) => r.emojiName === 'thumbsup' && r.userId === testUserId
        );
        expect(hasThumbsup).toBe(false);

        // Cleanup
        await api.deletePost(post.id);
      });
    });
  });
});
