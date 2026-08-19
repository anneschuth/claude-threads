/**
 * Channel Memory Integration Tests
 *
 * Exercises the !remember / !memory / !memory forget command round-trip
 * through the real bot (command parsing → executor → SessionManager →
 * MemoryStore on disk), on both platform paths.
 *
 * The system-prompt injection and CLI settings wiring are covered by unit
 * tests (system-prompt-generator.test.ts, cli.test.ts); here we verify the
 * user-facing surface plus on-disk persistence under the isolated
 * CLAUDE_THREADS_MEMORY_DIR the bot-starter configures.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
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
import { MemoryStore } from '../../../src/memory/store.js';

const SKIP = !process.env.INTEGRATION_TEST;
const TEST_PLATFORMS = (process.env.TEST_PLATFORMS || 'mattermost').split(',') as PlatformType[];

describe.skipIf(SKIP)('Channel Memory', () => {
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
      await bot.sessionManager.killAllSessions();
      await new Promise((r) => setTimeout(r, process.env.CI ? 500 : 200));
    });

    /** The store the running bot writes to (isolated by bot-starter). */
    const openStore = () => new MemoryStore(process.env.CLAUDE_THREADS_MEMORY_DIR);

    async function startMemorySession(prompt: string) {
      const rootPost = await startSession(ctx, prompt, getBotUsername());
      testThreadIds.push(rootPost.id);
      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });
      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });
      return rootPost;
    }

    it('!remember stores a note, !memory lists it, !memory forget removes it', async () => {
      const rootPost = await startMemorySession('Hello memory bot');

      // Remember a fact
      await sendCommand(ctx, rootPost.id, '!remember Deploys happen on Tuesdays');
      await waitForPostMatching(ctx, rootPost.id, /Remembered/, { timeout: 10000 });

      // The entry landed in the on-disk channel memory (0600 markdown file)
      const store = openStore();
      const platformId = bot.platformId;
      const entries = store.listChannelEntries(platformId);
      expect(entries).toHaveLength(1);
      expect(entries[0].text).toBe('Deploys happen on Tuesdays');
      expect(entries[0].source).toBe('user');
      const file = store.channelMemoryPath(platformId);
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, 'utf-8')).toContain('Deploys happen on Tuesdays');

      // List it
      await sendCommand(ctx, rootPost.id, '!memory');
      await waitForPostMatching(ctx, rootPost.id, /Channel memory \(1 entry\)/, { timeout: 10000 });
      await waitForPostMatching(ctx, rootPost.id, /1\. .*Deploys happen on Tuesdays/, { timeout: 10000 });

      // Forget it by number (sender is the session owner)
      await sendCommand(ctx, rootPost.id, '!memory forget 1');
      await waitForPostMatching(ctx, rootPost.id, /Forgot:/, { timeout: 10000 });
      expect(openStore().listChannelEntries(platformId)).toHaveLength(0);

      // Listing again reports empty
      await sendCommand(ctx, rootPost.id, '!memory');
      await waitForPostMatching(ctx, rootPost.id, /No channel memory yet/, { timeout: 10000 });
    });

    it('!remember dedupes an equivalent note', async () => {
      const rootPost = await startMemorySession('Hello again');

      await sendCommand(ctx, rootPost.id, '!remember The team prefers bun over npm');
      await waitForPostMatching(ctx, rootPost.id, /Remembered/, { timeout: 10000 });
      await sendCommand(ctx, rootPost.id, '!remember the team prefers bun over npm');
      await waitForPostMatching(ctx, rootPost.id, /Already known/, { timeout: 10000 });

      const platformId = bot.platformId;
      expect(openStore().listChannelEntries(platformId)).toHaveLength(1);

      // Clean up channel memory for other tests in this suite
      await sendCommand(ctx, rootPost.id, '!memory forget all');
      await waitForPostMatching(ctx, rootPost.id, /Channel memory cleared/, { timeout: 10000 });
      expect(openStore().listChannelEntries(platformId)).toHaveLength(0);
    });
  });
});
