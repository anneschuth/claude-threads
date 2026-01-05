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
import { SessionStore } from '../../../src/persistence/session-store.js';

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
 * Get the session header post ID directly from the session manager.
 * This is more reliable than pattern matching because it uses the actual
 * post ID that was registered when the session was created.
 *
 * @param sessionManager - The bot's session manager
 * @param threadId - The thread ID to look up
 * @param options - Timeout options
 * @returns The session header post as a MattermostPost object
 */
export async function waitForSessionHeader(
  ctx: TestSessionContext,
  threadId: string,
  options: { timeout?: number; sessionManager?: SessionManager } = {},
): Promise<MattermostPost> {
  const { timeout = 30000, sessionManager } = options;

  // If we have access to sessionManager, use the authoritative post ID
  if (sessionManager) {
    return waitFor(
      async () => {
        const postId = sessionManager.getSessionStartPostId(threadId);
        if (!postId) {
          if (process.env.CI) {
            console.log(`[waitForSessionHeader] no sessionStartPostId yet for thread ${threadId.substring(0, 8)}...`);
          }
          return null;
        }
        // Fetch the actual post from Mattermost
        try {
          const post = await ctx.api.getPost(postId);
          if (process.env.CI) {
            console.log(`[waitForSessionHeader] got post ${postId.substring(0, 8)}... from sessionManager`);
          }
          return post;
        } catch {
          if (process.env.CI) {
            console.log(`[waitForSessionHeader] failed to fetch post ${postId.substring(0, 8)}...`);
          }
          return null;
        }
      },
      {
        timeout,
        interval: 500,
        description: `session header post via sessionManager for thread ${threadId.substring(0, 8)}...`,
      },
    );
  }

  // Fallback: pattern matching (less reliable due to API race conditions)
  // Session header contains the logo pattern or "claude-threads v" version text
  // Logo format: ✴ ▄█▀ ███ ✴   claude-threads v0.33.8
  const sessionHeaderPattern = /claude-threads v\d+\.\d+\.\d+|✴ ▄█▀|Starting session/;

  return waitFor(
    async () => {
      const { posts } = await ctx.api.getThreadPosts(threadId);
      const threadPosts = Object.values(posts).sort((a, b) => a.create_at - b.create_at);

      // Filter to bot posts only
      const botPosts = threadPosts.filter((p) => p.user_id === ctx.botUserId);

      // Debug: log thread structure in CI
      if (process.env.CI) {
        const shortThreadId = threadId.substring(0, 8);
        console.log(`[waitForSessionHeader] thread=${shortThreadId}... total=${threadPosts.length} botPosts=${botPosts.length} (pattern matching fallback)`);
        for (const p of botPosts) {
          const shortId = p.id.substring(0, 8);
          const shortRootId = p.root_id?.substring(0, 8) || 'none';
          const matches = sessionHeaderPattern.test(p.message);
          const preview = p.message.substring(0, 60).replace(/\n/g, '\\n');
          console.log(`[waitForSessionHeader]   post ${shortId}... root=${shortRootId} matches=${matches} preview="${preview}"`);
        }
      }

      // Find the session header post
      const headerPost = botPosts.find((p) => sessionHeaderPattern.test(p.message));
      if (process.env.CI && headerPost) {
        console.log(`[waitForSessionHeader] SELECTED: ${headerPost.id.substring(0, 8)}...`);
      }
      return headerPost || null;
    },
    {
      timeout,
      interval: 500,
      description: `session header post in thread ${threadId.substring(0, 8)}...`,
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
 * Wait for thread to have at least N posts
 */
export async function waitForPostCount(
  ctx: TestSessionContext,
  threadId: string,
  minCount: number,
  options: { timeout?: number } = {},
): Promise<MattermostPost[]> {
  const { timeout = 5000 } = options;

  let posts: MattermostPost[] = [];
  await waitFor(
    async () => {
      posts = await getThreadPosts(ctx, threadId);
      return posts.length >= minCount;
    },
    {
      timeout,
      interval: 200,
      description: `thread ${threadId} to have at least ${minCount} posts`,
    },
  );
  return posts;
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
 * Wait for a reaction to be processed by the bot.
 *
 * This is a more robust version of waitForReaction that handles CI environments
 * where WebSocket events can be delayed or missed. It:
 * 1. Waits for the reaction to be recorded in Mattermost
 * 2. Waits for the bot to process it (session state changes)
 * 3. If the state doesn't change, manually triggers the reaction handler as fallback
 *
 * @param ctx - Test context
 * @param sessionManager - The bot's session manager
 * @param platformId - Platform ID for the bot
 * @param postId - Post ID where reaction was added
 * @param threadId - Thread ID (root post ID) for session lookup
 * @param emojiName - Emoji name to wait for
 * @param username - Username who added the reaction
 * @param expectedSessionState - What state the session should be in after processing
 *                               'ended' = session should no longer be active
 *                               'active' = session should still be active (e.g., for resume)
 * @param options - Timeout options
 */
export async function waitForReactionProcessed(
  ctx: TestSessionContext,
  sessionManager: SessionManager,
  platformId: string,
  postId: string,
  threadId: string,
  emojiName: string,
  username: string,
  expectedSessionState: 'ended' | 'active',
  options: { timeout?: number } = {},
): Promise<void> {
  const { timeout = 15000 } = options;
  const startTime = Date.now();

  // First, wait for the reaction to be recorded in Mattermost
  await waitForReaction(ctx, postId, emojiName, { timeout: 5000 });

  // Check initial session state
  const checkState = () => {
    const isActive = sessionManager.isInSessionThread(threadId);
    return expectedSessionState === 'ended' ? !isActive : isActive;
  };

  // Wait for WebSocket event to process the reaction
  const webSocketTimeout = 3000; // Give WebSocket 3 seconds
  const webSocketStart = Date.now();
  while (Date.now() - webSocketStart < webSocketTimeout) {
    if (checkState()) {
      return; // WebSocket delivered and processed!
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // WebSocket event didn't arrive - manually trigger the reaction handler
  // This is a fallback for CI environments where WebSocket events are unreliable
  await sessionManager.triggerReactionHandler(platformId, postId, emojiName, username);

  // Wait for the session state to change after manual trigger
  const remainingTime = timeout - (Date.now() - startTime);
  await waitFor(
    async () => checkState(),
    {
      timeout: Math.max(remainingTime, 1000),
      interval: 200,
      description: `session to be ${expectedSessionState} after ${emojiName} reaction (fallback)`,
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

/**
 * Wait for a session to end (no longer active in session manager)
 */
export async function waitForSessionEnded(
  sessionManager: SessionManager,
  threadId: string,
  options: { timeout?: number } = {},
): Promise<void> {
  const { timeout = 5000 } = options;

  await waitFor(
    async () => !sessionManager.isInSessionThread(threadId),
    {
      timeout,
      interval: 100,
      description: `session to end for thread ${threadId}`,
    },
  );
}

/**
 * Wait for bot post count to stabilize (no new posts for a period)
 * Useful for ensuring all buffered content has been flushed
 */
export async function waitForStableBotPostCount(
  ctx: TestSessionContext,
  threadId: string,
  options: { timeout?: number; stableFor?: number } = {},
): Promise<number> {
  const { timeout = 5000, stableFor = 500 } = options;
  const startTime = Date.now();
  let lastCount = -1;
  let stableSince = Date.now();

  while (Date.now() - startTime < timeout) {
    const posts = await getThreadPosts(ctx, threadId);
    const botPostCount = posts.filter((p) => p.user_id === ctx.botUserId).length;

    if (botPostCount !== lastCount) {
      lastCount = botPostCount;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= stableFor) {
      // Count has been stable for the required period
      return lastCount;
    }

    await new Promise((r) => setTimeout(r, 100));
  }

  // Return last count even if not fully stable (timeout reached)
  return lastCount;
}

/**
 * Create a thread with pre-existing user messages (for testing mid-thread session starts)
 *
 * @param ctx - Test session context
 * @param messages - Array of messages to post (creates thread from first message)
 * @returns The root post ID
 */
export async function createThreadWithMessages(
  ctx: TestSessionContext,
  messages: string[],
): Promise<{ rootId: string; messageIds: string[] }> {
  if (messages.length === 0) {
    throw new Error('Need at least one message to create a thread');
  }

  // Create the root post
  const rootPost = await ctx.api.createPost({
    channel_id: ctx.channelId,
    message: messages[0],
  });

  const messageIds = [rootPost.id];

  // Add follow-up messages
  for (let i = 1; i < messages.length; i++) {
    const reply = await ctx.api.createPost({
      channel_id: ctx.channelId,
      message: messages[i],
      root_id: rootPost.id,
    });
    messageIds.push(reply.id);
    // Small delay to ensure ordering
    await new Promise((r) => setTimeout(r, 50));
  }

  return { rootId: rootPost.id, messageIds };
}

/**
 * Start a session mid-thread by @mentioning the bot in an existing thread
 */
export async function startSessionMidThread(
  ctx: TestSessionContext,
  threadId: string,
  message: string,
  botUsername: string = 'claude-test-bot',
): Promise<MattermostPost> {
  const fullMessage = `@${botUsername} ${message}`;

  return ctx.api.createPost({
    channel_id: ctx.channelId,
    message: fullMessage,
    root_id: threadId,
  });
}

/**
 * Wait for a session to be persisted to disk
 *
 * @param threadId - The thread ID to wait for
 * @param options - Timeout options and sessionsPath for test isolation
 */
export async function waitForSessionPersisted(
  threadId: string,
  options: { timeout?: number; sessionsPath?: string } = {},
): Promise<void> {
  const { timeout = 5000, sessionsPath } = options;
  const sessionStore = new SessionStore(sessionsPath);

  await waitFor(
    async () => {
      const persisted = sessionStore.load();
      for (const session of persisted.values()) {
        if (session.threadId === threadId) {
          return true;
        }
      }
      return false;
    },
    {
      timeout,
      interval: 100,
      description: `session to be persisted for thread ${threadId}`,
    },
  );
}
