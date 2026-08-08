/**
 * Compaction Display Integration Tests
 *
 * Long-lived bot sessions auto-compact in production. These verify the
 * thread shows the compaction lifecycle: an in-progress post that resolves
 * to success (with token counts) or failure (with the error) — a failed
 * compact emits NO compact_boundary, which previously left the
 * "Compacting context..." post stale forever.
 *
 * Event shapes come from real-cli-captures/compact.jsonl and
 * compact-failed.jsonl (CLI 2.1.226).
 * Parameterized to run against both Mattermost and Slack platforms.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import {
  initIsolatedTestContext,
  startSession,
  waitForPostMatching,
  getPlatformBotOptions,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';
import { type PlatformType } from '../fixtures/platform-test-api.js';

const SKIP = !process.env.INTEGRATION_TEST;
const TEST_PLATFORMS = (process.env.TEST_PLATFORMS || 'mattermost').split(',') as PlatformType[];

describe.skipIf(SKIP)('Compaction Display', () => {
  describe.each(TEST_PLATFORMS)('%s platform', (platformType) => {
    let config: ReturnType<typeof loadConfig>;
    let ctx: TestSessionContext;
    let cleanupContext: () => Promise<void> = async () => {};
    let bot: TestBot;

    beforeAll(async () => {
      config = loadConfig();
      ({ ctx, cleanup: cleanupContext } = await initIsolatedTestContext(platformType));
    });

    afterAll(async () => {
      await cleanupContext();
    });

    afterEach(async () => {
      if (bot) {
        await bot.stop();
      }
    });

    const getBotUsername = () =>
      platformType === 'mattermost'
        ? (bot?.botUsername ?? config.mattermost.bot.username)
        : 'claude-test-bot';

    it('shows the compaction post resolving to success with token counts', async () => {
      bot = await startTestBot(getPlatformBotOptions(platformType, {
        scenario: 'compaction',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
      }, ctx));

      const rootPost = await startSession(ctx, 'Do some long work', getBotUsername());

      const completed = await waitForPostMatching(
        ctx, rootPost.id, /Context compacted/i, { timeout: 20000 }
      );
      expect(completed).toBeDefined();
      // Real capture values: 31103 → 2777 tokens renders as "31k → 3k"
      expect(completed.message).toMatch(/31k.*→.*3k/);
      expect(completed.message).toMatch(/manual/);
    });

    it('resolves the compaction post to a failure message (no boundary event)', async () => {
      bot = await startTestBot(getPlatformBotOptions(platformType, {
        scenario: 'compaction-failed',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
      }, ctx));

      const rootPost = await startSession(ctx, 'Try compacting', getBotUsername());

      const failed = await waitForPostMatching(
        ctx, rootPost.id, /Compaction failed/i, { timeout: 20000 }
      );
      expect(failed).toBeDefined();
      expect(failed.message).toContain('Not enough messages to compact.');
    });
  });
});
