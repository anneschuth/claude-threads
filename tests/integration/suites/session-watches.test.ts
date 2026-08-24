/**
 * Watches (event triggers) Integration Tests
 *
 * Exercises the full production pipeline through the real bot: a plain
 * channel message → message-handler fall-through → WatchEvaluator (keyword
 * prefilter → mock-CLI haiku confirm) → fireWatch → session anchored on the
 * triggering message's own thread. Plus the !watches management surface.
 *
 * Creation via !watch is not exercised here (it needs the haiku parser);
 * the parse/validate layers are unit-tested and watches are seeded straight
 * into the isolated store the bot-starter configures.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import {
  type PlatformType,
  MattermostTestApi,
} from '../fixtures/platform-test-api.js';
import {
  initIsolatedTestContext,
  initAdminApi,
  startSession,
  waitForBotResponse,
  sendCommand,
  waitForPostMatching,
  waitForSessionActive,
  getPlatformBotOptions,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';
import { waitFor } from '../helpers/wait-for.js';
import { WatchesStore } from '../../../src/persistence/watches-store.js';

const SKIP = !process.env.INTEGRATION_TEST;
const TEST_PLATFORMS = (process.env.TEST_PLATFORMS || 'mattermost').split(',') as PlatformType[];

describe.skipIf(SKIP)('Watches', () => {
  describe.each(TEST_PLATFORMS)('%s platform', (platformType) => {
    let config: ReturnType<typeof loadConfig>;
    let ctx: TestSessionContext;
    let bot: TestBot;
    const testThreadIds: string[] = [];
    let adminApi: MattermostTestApi | null = null;
    let cleanupContext: () => Promise<void> = async () => {};

    const getBotUsername = () => {
      if (platformType === 'mattermost') {
        return bot?.botUsername ?? config.mattermost.bot.username;
      }
      return 'claude-test-bot';
    };

    beforeAll(async () => {
      config = loadConfig();
      if (platformType === 'mattermost') {
        adminApi = initAdminApi();
      }
      ({ ctx, cleanup: cleanupContext } = await initIsolatedTestContext(platformType));
      bot = await startTestBot(getPlatformBotOptions(platformType, {
        scenario: 'persistent-session',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
      }, ctx));
    });

    afterAll(async () => {
      await bot.stop();
      if (adminApi) {
        for (const threadId of testThreadIds) {
          try {
            await adminApi.deletePost(threadId);
          } catch {
            // Ignore cleanup errors
          }
        }
      }
      await cleanupContext();
    });

    afterEach(async () => {
      // Reset the store between tests and kill fired sessions.
      const store = openStore();
      for (const w of store.list(bot.platformId)) {
        await store.remove(bot.platformId, w.id);
      }
      await bot.sessionManager.killAllSessions();
      await new Promise((r) => setTimeout(r, process.env.CI ? 500 : 200));
    });

    /** The store the running bot reads (isolated by bot-starter). */
    const openStore = () => new WatchesStore(process.env.CLAUDE_THREADS_WATCHES_PATH);

    async function seedWatch(overrides: { name?: string; keywords?: string[]; createdBy?: string } = {}) {
      const result = await openStore().add(bot.platformId, {
        name: overrides.name ?? 'Incident triage',
        condition: 'someone reports a production incident',
        prompt: 'triage the incident and post a summary',
        keywords: overrides.keywords ?? ['incident', 'outage'],
        createdBy: overrides.createdBy ?? 'testuser1',
      });
      if (!result.ok) throw new Error(result.error);
      return result.watch;
    }

    /** Post a plain channel message (no bot mention, new thread root). */
    async function postChannelMessage(message: string) {
      const post = await ctx.api.createPost({
        channelId: ctx.channelId,
        message,
        userId: ctx.testUserId,
      });
      testThreadIds.push(post.id);
      return post;
    }

    it('a matching channel message fires a session in its own thread', async () => {
      const watch = await seedWatch();
      const sessionsBefore = bot.sessionManager.registry.size;

      const trigger = await postChannelMessage('Heads up: we have a production incident on the API');

      // The session anchors on the triggering message's thread.
      await waitFor(() => bot.sessionManager.registry.size === sessionsBefore + 1, {
        timeout: 30000,
        description: 'watch-fired session to start',
      });
      await waitForSessionActive(bot.sessionManager, trigger.id, { timeout: 15000 });

      // Bookkeeping: fire recorded, cooldown anchored, daily counter at 1.
      await waitFor(() => openStore().get(bot.platformId, watch.id)?.lastFireStatus === 'ok', {
        timeout: 10000,
        description: 'watch fire bookkeeping',
      });
      const fired = openStore().get(bot.platformId, watch.id)!;
      expect(fired.lastFiredAt).toBeDefined();
      expect(fired.firesToday?.count).toBe(1);
    });

    it('cooldown blocks an immediate second fire; non-matching messages never fire', async () => {
      await seedWatch();

      const first = await postChannelMessage('another incident just started');
      await waitFor(() => bot.sessionManager.registry.size >= 1, {
        timeout: 30000,
        description: 'first watch fire',
      });
      await waitForSessionActive(bot.sessionManager, first.id, { timeout: 15000 });
      const sessionsAfterFirst = bot.sessionManager.registry.size;

      // Same keywords, still cooling: must not fire again.
      await postChannelMessage('sorry, the incident chatter continues');
      // Non-matching message: prefilter miss.
      await postChannelMessage('completely unrelated lunch plans');

      // Give the evaluator time to (not) act, then assert nothing new started.
      await new Promise((r) => setTimeout(r, 3000));
      expect(bot.sessionManager.registry.size).toBe(sessionsAfterFirst);
    });

    it('!watches lists, pauses, resumes, and deletes seeded watches', async () => {
      const rootPost = await startSession(ctx, 'Hello watches bot', getBotUsername());
      testThreadIds.push(rootPost.id);
      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });
      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });

      const watch = await seedWatch({ name: 'Managed watch' });

      await sendCommand(ctx, rootPost.id, '!watches');
      await waitForPostMatching(ctx, rootPost.id, /Watches \(1\)/, { timeout: 10000 });
      await waitForPostMatching(ctx, rootPost.id, /1\. .*Managed watch/, { timeout: 10000 });

      await sendCommand(ctx, rootPost.id, '!watches pause 1');
      await waitForPostMatching(ctx, rootPost.id, /paused/, { timeout: 10000 });
      expect(openStore().get(bot.platformId, watch.id)?.enabled).toBe(false);

      await sendCommand(ctx, rootPost.id, '!watches resume 1');
      await waitForPostMatching(ctx, rootPost.id, /resumed/, { timeout: 10000 });
      expect(openStore().get(bot.platformId, watch.id)?.enabled).toBe(true);

      await sendCommand(ctx, rootPost.id, '!watches delete 1');
      await waitForPostMatching(ctx, rootPost.id, /deleted/, { timeout: 10000 });
      expect(openStore().list(bot.platformId)).toHaveLength(0);
    });
  });
});
