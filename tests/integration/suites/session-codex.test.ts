/**
 * Codex agent backend integration tests
 *
 * Verifies that sessions started with `!agent codex` drive the mock Codex CLI
 * (app-server JSON-RPC protocol) end-to-end: session start, streaming response,
 * interactive command approvals, and resume after bot restart.
 *
 * The mock codex fixture lives at tests/integration/fixtures/mock-codex/ and is
 * injected via the CODEX_PATH environment variable (see bot-starter.ts).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import {
  initIsolatedTestContext,
  startSession,
  sendFollowUp,
  waitForBotResponse,
  waitForSessionActive,
  waitForPostMatching,
  addReaction,
  getPlatformBotOptions,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { MattermostTestApi } from '../fixtures/platform-test-api.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';
import { loadConfig } from '../setup/config.js';
import type { PlatformType } from '../fixtures/platform-test-api.js';

const TEST_PLATFORMS = (process.env.TEST_PLATFORMS || 'mattermost').split(',') as PlatformType[];
const SKIP = !process.env.INTEGRATION_TEST;

describe.skipIf(SKIP)('Codex Agent Backend', () => {
  describe.each(TEST_PLATFORMS)('%s platform', (platformType) => {
    let config: ReturnType<typeof loadConfig>;
    let ctx: TestSessionContext;
    let cleanupContext: (() => Promise<void>) | null = null;
    let bot: TestBot;
    const testThreadIds: string[] = [];
    let adminApi: MattermostTestApi | null = null;

    beforeAll(async () => {
      config = loadConfig();
      ({ ctx, cleanup: cleanupContext } = await initIsolatedTestContext(platformType));

      if (platformType === 'mattermost') {
        adminApi = new MattermostTestApi(config.mattermost.url, config.mattermost.admin.token!);
      }
    });

    afterAll(async () => {
      if (adminApi) {
        for (const threadId of testThreadIds) {
          try {
            await adminApi.deletePost(threadId);
          } catch {
            // Ignore cleanup errors
          }
        }
      }
      await cleanupContext?.();
    });

    afterEach(async () => {
      if (bot) {
        await bot.sessionManager.killAllSessions();
        await new Promise((r) => setTimeout(r, process.env.CI ? 500 : 200));
        await bot.stop();
      }
    });

    function getBotUsername(): string {
      // Each startTestBot leases a bot from the pool - mention THAT bot
      return bot?.botUsername ?? config.mattermost.bot.username;
    }

    function getTestUsername(): string {
      return config.mattermost.testUsers[0].username;
    }

    /**
     * React to an approval post, with a manual fallback when the WebSocket
     * reaction event doesn't arrive (mirrors waitForReactionProcessed - WS
     * delivery is unreliable in CI).
     */
    async function reactToApprovalPost(postId: string, emoji: string): Promise<void> {
      await addReaction(ctx, postId, emoji);

      // Processed = the approval post was updated away from the prompt text
      const processed = async () => {
        const posts = await ctx.api.getThreadPosts(postId).catch(() => null);
        const post = posts?.find((p) => p.id === postId);
        return post ? !/Action requires approval/.test(post.message) : false;
      };

      const start = Date.now();
      while (Date.now() - start < 4000) {
        if (await processed()) return;
        await new Promise((r) => setTimeout(r, 250));
      }

      // Fallback: trigger the reaction handler directly
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (bot.sessionManager as any).handleReaction(bot.platformId, postId, emoji, getTestUsername(), 'added');
    }

    describe('Session with !agent codex', () => {
      it('starts a codex session and streams the response', async () => {
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'codex-simple',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
        }, ctx));

        const rootPost = await startSession(ctx, '!agent codex Hello codex', getBotUsername());
        testThreadIds.push(rootPost.id);

        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 15000 });

        // The mock codex response should arrive in the thread
        await waitForBotResponse(ctx, rootPost.id, {
          timeout: 30000,
          pattern: /Hello from mock Codex/,
        });

        // The session header should show the Codex agent
        await waitForPostMatching(ctx, rootPost.id, /Codex/, { timeout: 15000 });
      });

      it('handles multiple turns in one codex session', async () => {
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'codex-simple',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
        }, ctx));

        const rootPost = await startSession(ctx, '!agent codex first message', getBotUsername());
        testThreadIds.push(rootPost.id);

        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 15000 });
        await waitForBotResponse(ctx, rootPost.id, {
          timeout: 30000,
          pattern: /Hello from mock Codex/,
        });

        // Follow-up message starts a second turn on the same thread
        await sendFollowUp(ctx, rootPost.id, 'second message');
        await waitForBotResponse(ctx, rootPost.id, {
          timeout: 30000,
          pattern: /Hello from mock Codex/,
          minResponses: 2,
        });
      });
    });

    describe('Interactive command approvals', () => {
      it('posts an approval prompt and proceeds after 👍', async () => {
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'codex-approval',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
        }, ctx));

        const rootPost = await startSession(ctx, '!agent codex touch a file', getBotUsername());
        testThreadIds.push(rootPost.id);

        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 15000 });

        // The mock codex requests approval before running the command
        const approvalPost = await waitForPostMatching(ctx, rootPost.id, /Action requires approval/, {
          timeout: 30000,
        });
        expect(approvalPost.message).toContain('touch /tmp/mock-codex-test.txt');
        expect(approvalPost.message).toContain('Approve all for this session');

        // Approve with 👍
        await reactToApprovalPost(approvalPost.id, '+1');

        // The mock continues the turn: command runs and the final message arrives
        await waitForBotResponse(ctx, rootPost.id, {
          timeout: 30000,
          pattern: /Command executed successfully after approval/,
        });
      });

      it('stops the command after 👎', async () => {
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'codex-approval',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
        }, ctx));

        const rootPost = await startSession(ctx, '!agent codex touch a file', getBotUsername());
        testThreadIds.push(rootPost.id);

        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 15000 });

        const approvalPost = await waitForPostMatching(ctx, rootPost.id, /Action requires approval/, {
          timeout: 30000,
        });

        // Deny with 👎
        await reactToApprovalPost(approvalPost.id, '-1');

        await waitForBotResponse(ctx, rootPost.id, {
          timeout: 30000,
          pattern: /Command was denied/,
        });
      });
    });

    describe('Resume after bot restart', () => {
      it('resumes a codex session with its threadId', async () => {
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'codex-persistent',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
        }, ctx));

        const rootPost = await startSession(ctx, '!agent codex remember this session', getBotUsername());
        testThreadIds.push(rootPost.id);

        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 15000 });
        await waitForBotResponse(ctx, rootPost.id, {
          timeout: 30000,
          pattern: /Mock codex response/,
        });

        const savedSessionsPath = bot.sessionsPath;
        await bot.stopAndPreserveSessions();
        await new Promise((r) => setTimeout(r, 200));

        // Restart the bot with the same sessions file
        bot = await startTestBot(getPlatformBotOptions(platformType, {
          scenario: 'codex-persistent',
          skipPermissions: true,
          debug: process.env.DEBUG === '1',
          clearPersistedSessions: false,
          sessionsPath: savedSessionsPath,
        }, ctx));

        await new Promise((r) => setTimeout(r, 1000));

        // The session was persisted with agentType codex and should resume (or be paused for manual resume)
        const isActive = bot.sessionManager.isInSessionThread(rootPost.id);
        const isPaused = bot.sessionManager.hasPausedSession(rootPost.id);
        expect(isActive || isPaused).toBe(true);
      });
    });
  });
});
