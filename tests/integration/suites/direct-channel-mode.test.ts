/**
 * Direct Channel Mode (DCM) Integration Tests
 *
 * The whole channel is one session: no @mention needed, the bot replies with
 * top-level channel posts (root_id empty), messages inside threads route to
 * the same channel session, and respondTo: 'mention' restores the mention
 * gate. Mattermost only — DCM's channel-root posting is platform-agnostic,
 * but the suite exercises the Mattermost path the feature ships for.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import {
  initIsolatedTestContext,
  getPlatformBotOptions,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';
import { waitFor, sleep } from '../helpers/wait-for.js';
import type { PlatformTestPost } from '../fixtures/platform-test-api.js';

const SKIP = !process.env.INTEGRATION_TEST || (process.env.TEST_PLATFORMS || 'mattermost') === 'slack';

describe.skipIf(SKIP)('Direct Channel Mode', () => {
  let ctx: TestSessionContext;
  let bot: TestBot;
  let cleanupContext: () => Promise<void> = async () => {};

  /** Bot posts in the channel created after `sinceMs`, oldest first. */
  const botChannelPosts = async (sinceMs: number): Promise<PlatformTestPost[]> => {
    const posts = await ctx.api.getChannelPosts(ctx.channelId);
    return posts
      .filter((p) => ctx.botUserIds.includes(p.userId) && p.createAt > sinceMs)
      .sort((a, b) => a.createAt - b.createAt);
  };

  /** The session header posts before the session is registered — wait for it. */
  const waitForDcmSession = () =>
    waitFor(
      async () => bot.sessionManager.registry.findByThreadId(`dcm:${bot.platformId}`) ?? null,
      { timeout: 30000, interval: 250, description: 'DCM session registered' },
    );

  const waitForBotChannelPost = (sinceMs: number, pattern?: RegExp) =>
    waitFor(
      async () => {
        const posts = await botChannelPosts(sinceMs);
        const match = pattern ? posts.find((p) => pattern.test(p.message)) : posts[0];
        return match ?? null;
      },
      { timeout: 30000, interval: 500, description: `bot channel post${pattern ? ` matching ${pattern}` : ''}` },
    );

  beforeAll(async () => {
    ({ ctx, cleanup: cleanupContext } = await initIsolatedTestContext('mattermost'));
    bot = await startTestBot(
      getPlatformBotOptions('mattermost', {
        scenario: 'persistent-session',
        skipPermissions: true,
        directChannelMode: true,
      }, ctx),
    );
  });

  afterAll(async () => {
    await bot.stop();
    await cleanupContext();
  });

  it('starts a session from a plain channel message (no @mention) and replies at channel root', async () => {
    const since = Date.now() - 1000;
    await ctx.api.createPost({
      channelId: ctx.channelId,
      message: 'hello without any mention',
      userId: ctx.testUserId,
    });

    const reply = await waitForBotChannelPost(since);

    // The defining DCM behavior: the reply is a top-level channel post, not
    // a thread reply — and definitely not a reply carrying the synthetic id.
    expect(reply.rootId ?? '').toBe('');

    // Exactly one session exists, keyed by the synthetic id (registration
    // happens after the header post, so wait rather than assert directly).
    const session = await waitForDcmSession();
    expect(session).toBeDefined();
  });

  it('routes a follow-up without mention to the same session', async () => {
    await waitForDcmSession();
    const before = bot.sessionManager.registry.getActiveThreadIds().length;
    const since = Date.now() - 1000;

    await ctx.api.createPost({
      channelId: ctx.channelId,
      message: 'and a follow-up, still no mention',
      userId: ctx.testUserId,
    });

    await waitForBotChannelPost(since);
    expect(bot.sessionManager.registry.getActiveThreadIds().length).toBe(before);
  });

  it('routes a message posted inside a thread to the channel session', async () => {
    const since = Date.now() - 1000;
    // Reply to one of the bot's earlier posts — a real thread root.
    const [anyBotPost] = await botChannelPosts(0);
    expect(anyBotPost).toBeDefined();

    await ctx.api.createPost({
      channelId: ctx.channelId,
      message: 'threaded aside, no mention',
      rootId: anyBotPost.id,
      userId: ctx.testUserId,
    });

    // The bot still answers (at channel root) and no second session appears.
    await waitForBotChannelPost(since);
    expect(bot.sessionManager.registry.getActiveThreadIds().length).toBe(1);
  });

  it('!stop ends the channel session without a mention', async () => {
    await ctx.api.createPost({
      channelId: ctx.channelId,
      message: '!stop',
      userId: ctx.testUserId,
    });

    await waitFor(
      async () => (bot.sessionManager.registry.getActiveThreadIds().length === 0 ? true : null),
      { timeout: 30000, interval: 500, description: 'session ended' },
    );
  });
});

describe.skipIf(SKIP)('Direct Channel Mode — respondTo: mention', () => {
  let ctx: TestSessionContext;
  let bot: TestBot;
  let cleanupContext: () => Promise<void> = async () => {};

  beforeAll(async () => {
    ({ ctx, cleanup: cleanupContext } = await initIsolatedTestContext('mattermost'));
    bot = await startTestBot(
      getPlatformBotOptions('mattermost', {
        scenario: 'persistent-session',
        skipPermissions: true,
        directChannelMode: { respondTo: 'mention' },
      }, ctx),
    );
  });

  afterAll(async () => {
    await bot.stop();
    await cleanupContext();
  });

  it('ignores channel messages without a mention', async () => {
    await ctx.api.createPost({
      channelId: ctx.channelId,
      message: 'nobody asked you',
      userId: ctx.testUserId,
    });

    // Deliberate negative check: give the bot time to (not) react.
    await sleep(4000);
    expect(bot.sessionManager.registry.getActiveThreadIds().length).toBe(0);
  });

  it('starts the DCM session when mentioned, still replying at channel root', async () => {
    const since = Date.now() - 1000;
    await ctx.api.createPost({
      channelId: ctx.channelId,
      message: `@${bot.botUsername} now I am talking to you`,
      userId: ctx.testUserId,
    });

    const reply = await waitFor(
      async () => {
        const posts = await ctx.api.getChannelPosts(ctx.channelId);
        const botPosts = posts.filter((p) => ctx.botUserIds.includes(p.userId) && p.createAt > since);
        return botPosts[0] ?? null;
      },
      { timeout: 30000, interval: 500, description: 'bot reply after mention' },
    );

    expect(reply.rootId ?? '').toBe('');
    expect(bot.sessionManager.registry.findByThreadId(`dcm:${bot.platformId}`)).toBeDefined();
  });
});
