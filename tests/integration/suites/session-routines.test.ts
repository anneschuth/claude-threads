/**
 * Routines Integration Tests
 *
 * Exercises the !routines management surface and a manual fire through the
 * real bot: command parsing → executor → SessionManager → RoutinesStore on
 * disk → RoutineScheduler.fire → bot-initiated session thread.
 *
 * Creation via !routine is not exercised here (it needs the haiku parser);
 * the parse/validate layers are unit-tested and routines are seeded straight
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
import { RoutinesStore } from '../../../src/persistence/routines-store.js';

const SKIP = !process.env.INTEGRATION_TEST;
const TEST_PLATFORMS = (process.env.TEST_PLATFORMS || 'mattermost').split(',') as PlatformType[];

describe.skipIf(SKIP)('Routines', () => {
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

    /** The store the running bot reads (isolated by bot-starter). */
    const openStore = () => new RoutinesStore(process.env.CLAUDE_THREADS_ROUTINES_PATH);

    async function seedRoutine(name: string, createdBy: string) {
      const result = await openStore().add(bot.platformId, {
        name,
        prompt: 'post a one-line status update',
        schedule: { preset: 'daily', time: '09:00', timezone: 'Europe/Amsterdam' },
        createdBy,
      });
      if (!result.ok) throw new Error(result.error);
      return result.routine;
    }

    async function startCommandSession(prompt: string) {
      const rootPost = await startSession(ctx, prompt, getBotUsername());
      testThreadIds.push(rootPost.id);
      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });
      await waitForBotResponse(ctx, rootPost.id, { timeout: 30000, minResponses: 1 });
      return rootPost;
    }

    it('!routines lists, pauses, resumes, and deletes seeded routines', async () => {
      const rootPost = await startCommandSession('Hello routines bot');
      const routine = await seedRoutine('Daily status', 'testuser1');

      await sendCommand(ctx, rootPost.id, '!routines');
      await waitForPostMatching(ctx, rootPost.id, /Routines \(1\)/, { timeout: 10000 });
      await waitForPostMatching(ctx, rootPost.id, /1\. .*Daily status/, { timeout: 10000 });

      await sendCommand(ctx, rootPost.id, '!routines pause 1');
      await waitForPostMatching(ctx, rootPost.id, /paused/, { timeout: 10000 });
      expect(openStore().get(bot.platformId, routine.id)?.enabled).toBe(false);

      await sendCommand(ctx, rootPost.id, '!routines resume 1');
      await waitForPostMatching(ctx, rootPost.id, /resumed/, { timeout: 10000 });
      expect(openStore().get(bot.platformId, routine.id)?.enabled).toBe(true);

      await sendCommand(ctx, rootPost.id, '!routines delete 1');
      await waitForPostMatching(ctx, rootPost.id, /deleted/, { timeout: 10000 });
      expect(openStore().list(bot.platformId)).toHaveLength(0);
    });

    it('!routines run fires a bot-initiated session thread and records the run', async () => {
      const rootPost = await startCommandSession('Fire a routine for me');
      // Creator is the command session's owner (a platform-allowed user).
      const routine = await seedRoutine('Manual run test', 'testuser1');

      const sessionsBefore = bot.sessionManager.registry.size;
      await sendCommand(ctx, rootPost.id, '!routines run 1');
      await waitForPostMatching(ctx, rootPost.id, /Running .*Manual run test/, { timeout: 10000 });

      // A NEW session appears in a different thread (the routine's own root post).
      await waitFor(() => bot.sessionManager.registry.size === sessionsBefore + 1, {
        timeout: 20000,
        description: 'routine session to start in a new thread',
      });

      // The run is recorded but the scheduled period is NOT consumed.
      await waitFor(() => openStore().get(bot.platformId, routine.id)?.lastRunStatus === 'ok', {
        timeout: 10000,
        description: 'routine run bookkeeping',
      });
      expect(openStore().get(bot.platformId, routine.id)?.lastRunAt).toBeUndefined();

      await sendCommand(ctx, rootPost.id, '!routines delete 1');
      await waitForPostMatching(ctx, rootPost.id, /deleted/, { timeout: 10000 });
    });
  });
});
