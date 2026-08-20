/**
 * DM Auto-Discovery Integration Tests (Mattermost only)
 *
 * A cold direct message from an allowed user spawns a derived direct-channel-
 * mode instance for the DM channel; replies land in the DM at channel root;
 * follow-ups reach the same session. Exercises the production runtime
 * (src/platform/dm-discovery-runtime.ts) end-to-end against real Mattermost.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import {
  initIsolatedTestContext,
  getPlatformBotOptions,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';
import { waitFor } from '../helpers/wait-for.js';

const SKIP = !process.env.INTEGRATION_TEST || (process.env.TEST_PLATFORMS || 'mattermost') === 'slack';

describe.skipIf(SKIP)('DM Auto-Discovery', () => {
  let ctx: TestSessionContext;
  let bot: TestBot;
  let config: ReturnType<typeof loadConfig>;
  let dmChannelId: string;
  let userToken: string;
  let cleanupContext: () => Promise<void> = async () => {};

  const mmApi = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${config.mattermost.url}/api/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
    return res.json();
  };

  /** Bot posts in the DM channel after `sinceMs`, oldest first. */
  const botDmPosts = async (sinceMs: number) => {
    const data = await mmApi('GET', `/channels/${dmChannelId}/posts?per_page=60`) as {
      order: string[]; posts: Record<string, { id: string; user_id: string; root_id: string; message: string; create_at: number }>;
    };
    return data.order
      .map((id) => data.posts[id])
      .filter((p) => p.user_id === bot.botUserId && p.create_at > sinceMs)
      .sort((a, b) => a.create_at - b.create_at);
  };

  const dmDcmThreadId = () => `dcm:${bot.platformId}--dm-${dmChannelId}`;

  beforeAll(async () => {
    config = loadConfig();
    userToken = config.mattermost.testUsers[0].token!;
    ({ ctx, cleanup: cleanupContext } = await initIsolatedTestContext('mattermost'));
    bot = await startTestBot(
      getPlatformBotOptions('mattermost', {
        scenario: 'persistent-session',
        skipPermissions: true,
        directMessages: true,
      }, ctx),
    );
    // Create (or fetch) the DM channel between testuser1 and the bot.
    const dm = await mmApi('POST', '/channels/direct', [config.mattermost.testUsers[0].userId, bot.botUserId]) as { id: string };
    dmChannelId = dm.id;
  });

  afterAll(async () => {
    await bot.stop();
    await cleanupContext();
  });

  it('a cold DM spawns a derived instance and the bot replies in the DM at channel root', async () => {
    const since = Date.now() - 1000;
    await mmApi('POST', '/posts', { channel_id: dmChannelId, message: 'cold start, no config entry for me' });

    const reply = await waitFor(
      async () => (await botDmPosts(since))[0] ?? null,
      { timeout: 30000, interval: 500, description: 'bot reply in DM channel' },
    );

    expect(reply.root_id).toBe('');

    // The session runs on the derived platform instance, DCM-keyed.
    const session = await waitFor(
      async () => bot.sessionManager.registry.findByThreadId(dmDcmThreadId()) ?? null,
      { timeout: 15000, interval: 250, description: 'derived DM session' },
    );
    expect(session).toBeDefined();
  });

  it('a follow-up DM reaches the same session', async () => {
    const before = bot.sessionManager.registry.getActiveThreadIds().length;
    const since = Date.now() - 1000;

    await mmApi('POST', '/posts', { channel_id: dmChannelId, message: 'still me, same conversation' });

    await waitFor(
      async () => (await botDmPosts(since))[0] ?? null,
      { timeout: 30000, interval: 500, description: 'bot reply to follow-up' },
    );
    expect(bot.sessionManager.registry.getActiveThreadIds().length).toBe(before);
  });

  it('the channel session and the DM session coexist independently', async () => {
    const since = Date.now() - 1000;
    // Start a session in the regular channel too (mention — channel is not DCM here).
    await ctx.api.createPost({
      channelId: ctx.channelId,
      message: `@${bot.botUsername} hello from the channel`,
      userId: ctx.testUserId,
    });

    await waitFor(
      async () => {
        const posts = await ctx.api.getChannelPosts(ctx.channelId);
        return posts.find((p) => ctx.botUserIds.includes(p.userId) && p.createAt > since) ?? null;
      },
      { timeout: 30000, interval: 500, description: 'bot reply in main channel' },
    );

    // Two independent sessions: the DM one and the channel one.
    await waitFor(
      async () => (bot.sessionManager.registry.getActiveThreadIds().length >= 2 ? true : null),
      { timeout: 15000, interval: 250, description: 'two coexisting sessions' },
    );
    expect(bot.sessionManager.registry.findByThreadId(dmDcmThreadId())).toBeDefined();
  });
});
