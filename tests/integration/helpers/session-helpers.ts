/**
 * Session lifecycle helpers for integration tests
 */

import { loadConfig } from '../setup/config.js';
import {
  MattermostTestApi,
  type MattermostPost,
} from '../fixtures/mattermost/api-helpers.js';
import { waitFor } from './wait-for.js';
import type { SessionManager } from '../../../src/session/index.js';

/**
 * Test session context
 */
export interface TestSessionContext {
  api: MattermostTestApi;
  botUserId: string;
  channelId: string;
  testUserId: string;
  testUserToken: string;
}

/**
 * Initialize test session context from config
 */
export function initTestContext(): TestSessionContext {
  const config = loadConfig();

  if (!config.mattermost.bot.token || !config.mattermost.bot.userId) {
    throw new Error('Bot credentials not found. Run setup-mattermost.ts first.');
  }

  if (!config.mattermost.channel.id) {
    throw new Error('Channel ID not found. Run setup-mattermost.ts first.');
  }

  if (!config.mattermost.testUsers[0]?.token || !config.mattermost.testUsers[0]?.userId) {
    throw new Error('Test user credentials not found. Run setup-mattermost.ts first.');
  }

  // Use test user token for API calls (simulating user actions)
  const api = new MattermostTestApi(config.mattermost.url, config.mattermost.testUsers[0].token);

  return {
    api,
    botUserId: config.mattermost.bot.userId,
    channelId: config.mattermost.channel.id,
    testUserId: config.mattermost.testUsers[0].userId,
    testUserToken: config.mattermost.testUsers[0].token,
  };
}

/**
 * Create API client with admin privileges
 */
export function initAdminApi(): MattermostTestApi {
  const config = loadConfig();

  if (!config.mattermost.admin.token) {
    throw new Error('Admin token not found. Run setup-mattermost.ts first.');
  }

  return new MattermostTestApi(config.mattermost.url, config.mattermost.admin.token);
}

/**
 * Start a session by posting a mention to the bot
 *
 * @returns The root post of the thread
 */
export async function startSession(
  ctx: TestSessionContext,
  message: string,
  botUsername: string = 'claude-test-bot',
): Promise<MattermostPost> {
  const fullMessage = `@${botUsername} ${message}`;

  const post = await ctx.api.createPost({
    channel_id: ctx.channelId,
    message: fullMessage,
  });

  return post;
}

/**
 * Send a follow-up message in a thread
 */
export async function sendFollowUp(
  ctx: TestSessionContext,
  threadId: string,
  message: string,
): Promise<MattermostPost> {
  return ctx.api.createPost({
    channel_id: ctx.channelId,
    message,
    root_id: threadId,
  });
}

/**
 * Wait for a response from the bot in a thread
 */
export async function waitForBotResponse(
  ctx: TestSessionContext,
  threadId: string,
  options: {
    timeout?: number;
    minResponses?: number;
    pattern?: RegExp;
  } = {},
): Promise<MattermostPost[]> {
  const { timeout = 30000, minResponses = 1, pattern } = options;

  return waitFor(
    async () => {
      const { posts } = await ctx.api.getThreadPosts(threadId);
      const threadPosts = Object.values(posts).sort((a, b) => a.create_at - b.create_at);

      // Filter to bot posts only
      const botPosts = threadPosts.filter((p) => p.user_id === ctx.botUserId);

      // Apply pattern filter if provided
      const matchingPosts = pattern
        ? botPosts.filter((p) => pattern.test(p.message))
        : botPosts;

      return matchingPosts.length >= minResponses ? matchingPosts : null;
    },
    {
      timeout,
      interval: 500,
      description: `${minResponses} bot response(s)${pattern ? ` matching ${pattern}` : ''}`,
    },
  );
}

/**
 * Wait for a specific post pattern in a thread
 */
export async function waitForPostMatching(
  ctx: TestSessionContext,
  threadId: string,
  pattern: RegExp,
  options: { timeout?: number } = {},
): Promise<MattermostPost> {
  const { timeout = 30000 } = options;

  return waitFor(
    async () => {
      const { posts } = await ctx.api.getThreadPosts(threadId);
      return Object.values(posts).find((p) => pattern.test(p.message)) || null;
    },
    {
      timeout,
      interval: 500,
      description: `post matching ${pattern}`,
    },
  );
}

/**
 * Get all posts in a thread sorted by time
 */
export async function getThreadPosts(
  ctx: TestSessionContext,
  threadId: string,
): Promise<MattermostPost[]> {
  const { posts } = await ctx.api.getThreadPosts(threadId);
  return Object.values(posts).sort((a, b) => a.create_at - b.create_at);
}

/**
 * Add a reaction to a post
 */
export async function addReaction(
  ctx: TestSessionContext,
  postId: string,
  emojiName: string,
): Promise<void> {
  await ctx.api.addReaction(postId, emojiName, ctx.testUserId);
}

/**
 * Remove a reaction from a post
 */
export async function removeReaction(
  ctx: TestSessionContext,
  postId: string,
  emojiName: string,
): Promise<void> {
  await ctx.api.removeReaction(postId, emojiName, ctx.testUserId);
}

/**
 * Wait for a post to have a specific reaction
 */
export async function waitForReaction(
  ctx: TestSessionContext,
  postId: string,
  emojiName: string,
  options: { timeout?: number } = {},
): Promise<void> {
  const { timeout = 10000 } = options;

  await waitFor(
    async () => {
      const reactions = await ctx.api.getReactions(postId);
      return reactions.some((r) => r.emoji_name === emojiName);
    },
    {
      timeout,
      interval: 200,
      description: `reaction "${emojiName}" on post`,
    },
  );
}

/**
 * Send a command (like !stop, !escape, etc.)
 */
export async function sendCommand(
  ctx: TestSessionContext,
  threadId: string,
  command: string,
): Promise<MattermostPost> {
  return sendFollowUp(ctx, threadId, command);
}

/**
 * Clean up a thread by deleting all posts
 */
export async function cleanupThread(
  adminApi: MattermostTestApi,
  threadId: string,
): Promise<number> {
  const { posts } = await adminApi.getThreadPosts(threadId);
  let count = 0;

  for (const postId of Object.keys(posts)) {
    try {
      await adminApi.deletePost(postId);
      count++;
    } catch {
      // Ignore errors
    }
  }

  return count;
}

/**
 * Create a unique channel for test isolation
 */
export async function createIsolatedChannel(
  adminApi: MattermostTestApi,
  teamId: string,
  prefix: string = 'test',
): Promise<string> {
  const config = loadConfig();
  const uniqueName = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const channel = await adminApi.createChannel({
    team_id: teamId,
    name: uniqueName,
    display_name: `Test ${uniqueName}`,
    type: 'O',
  });

  // Add bot to channel
  if (config.mattermost.bot.userId) {
    await adminApi.addUserToChannel(channel.id, config.mattermost.bot.userId);
  }

  // Add test users to channel
  for (const user of config.mattermost.testUsers) {
    if (user.userId) {
      await adminApi.addUserToChannel(channel.id, user.userId);
    }
  }

  return channel.id;
}

/**
 * Simulate bot being mentioned and starting a session
 * Returns when the session appears to have started (bot posts in thread)
 */
export async function startSessionAndWait(
  ctx: TestSessionContext,
  message: string,
  botUsername: string = 'claude-test-bot',
): Promise<{
  rootPost: MattermostPost;
  botResponses: MattermostPost[];
}> {
  const rootPost = await startSession(ctx, message, botUsername);

  // Wait for bot to respond
  const botResponses = await waitForBotResponse(ctx, rootPost.id, {
    timeout: 60000, // Sessions can take a while to start
    minResponses: 1,
  });

  return { rootPost, botResponses };
}

/**
 * Wait for a session to be registered in the session manager
 */
export async function waitForSessionActive(
  sessionManager: SessionManager,
  threadId: string,
  options: { timeout?: number } = {},
): Promise<void> {
  const { timeout = 10000 } = options;

  await waitFor(
    async () => sessionManager.isInSessionThread(threadId),
    {
      timeout,
      interval: 200,
      description: `session to be active for thread ${threadId}`,
    },
  );
}
