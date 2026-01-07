/**
 * Session Update Reaction Integration Tests
 *
 * Tests that reactions on update messages properly trigger updates.
 * This specifically tests the fix for the bug where postUpdateAskMessage()
 * wasn't setting pendingUpdatePrompt, causing reactions to be ignored.
 *
 * Parameterized to run against both Mattermost and Slack platforms.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import type { PlatformType } from '../fixtures/platform-test-api.js';
import {
  initTestContext,
  startSession,
  waitForSessionHeader,
  waitForPostMatching,
  addReaction,
  waitForSessionActive,
  getPlatformBotOptions,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';
import { waitFor } from '../helpers/wait-for.js';
import type { AutoUpdateManagerInterface } from '../../../src/session/commands.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

// Determine which platforms to test based on environment
const TEST_PLATFORMS = (process.env.TEST_PLATFORMS || 'mattermost').split(',') as PlatformType[];

/**
 * Create a mock AutoUpdateManager for testing update reactions.
 * Tracks calls to forceUpdate and deferUpdate.
 */
function createMockAutoUpdateManager(): AutoUpdateManagerInterface & {
  forceUpdateCalled: boolean;
  deferUpdateCalled: boolean;
  deferMinutes: number;
} {
  const mock = {
    forceUpdateCalled: false,
    deferUpdateCalled: false,
    deferMinutes: 0,
    isEnabled: () => true,
    hasUpdate: () => true,
    getUpdateInfo: () => ({
      available: true,
      currentVersion: '0.1.0',
      latestVersion: '99.99.99',
      detectedAt: new Date(),
    }),
    getScheduledRestartAt: () => null,
    checkNow: async () => ({
      available: true,
      currentVersion: '0.1.0',
      latestVersion: '99.99.99',
      detectedAt: new Date(),
    }),
    forceUpdate: async () => {
      mock.forceUpdateCalled = true;
    },
    deferUpdate: (minutes?: number) => {
      mock.deferUpdateCalled = true;
      mock.deferMinutes = minutes ?? 60;
    },
    getConfig: () => ({ autoRestartMode: 'ask' }),
  };
  return mock;
}

describe.skipIf(SKIP)('Session Update Reaction', () => {
  // Run tests for each configured platform
  describe.each(TEST_PLATFORMS)('%s platform', (platformType) => {
    let config: ReturnType<typeof loadConfig>;
    let ctx: TestSessionContext;
    let bot: TestBot;
    const testThreadIds: string[] = [];

    // Helper to get bot username based on platform
    const getBotUsername = () => {
      if (platformType === 'mattermost') {
        return config.mattermost.bot.username;
      }
      return 'claude-test-bot';
    };

    beforeAll(async () => {
      config = loadConfig();
      ctx = initTestContext(platformType);

      // Start bot with simple response scenario
      bot = await startTestBot(getPlatformBotOptions(platformType, {
        scenario: 'simple-response',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
      }));
    });

    afterAll(async () => {
      if (bot) {
        await bot.stop();
      }
    });

    afterEach(async () => {
      // Kill sessions between tests
      await bot.sessionManager.killAllSessions();
      await new Promise((r) => setTimeout(r, 200));
    });

    describe('postUpdateAskMessage', () => {
      it('should post update message and handle thumbs up reaction to trigger update', async () => {
        // Start a session first
        const rootPost = await startSession(ctx, 'hello for update test', getBotUsername());
        testThreadIds.push(rootPost.id);

        // Wait for session to be active
        await waitForSessionHeader(ctx, rootPost.id, {
          timeout: 30000,
          sessionManager: bot.sessionManager,
        });
        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

        // Create and set a mock auto update manager that tracks calls
        const mockAutoUpdateManager = createMockAutoUpdateManager();
        bot.sessionManager.setAutoUpdateManager(mockAutoUpdateManager);

        // Call postUpdateAskMessage - this is the method being tested
        await bot.sessionManager.postUpdateAskMessage([rootPost.id], '99.99.99');

        // Verify the update message was posted
        const updatePost = await waitForPostMatching(
          ctx,
          rootPost.id,
          /Update available.*99\.99\.99/,
          { timeout: 5000 }
        );
        expect(updatePost).toBeDefined();

        // Add a thumbs up reaction (simulating user approval)
        await addReaction(ctx, updatePost.id, '+1');

        // Wait for the reaction to be processed and update to be triggered
        // This is the critical test - if pendingUpdatePrompt wasn't set, this would fail
        await waitFor(
          async () => mockAutoUpdateManager.forceUpdateCalled,
          {
            timeout: 10000,
            interval: 200,
            description: 'update to be triggered via reaction',
          }
        );

        expect(mockAutoUpdateManager.forceUpdateCalled).toBe(true);

        // Verify the post was updated to show "Forcing update"
        const forcingPost = await waitForPostMatching(
          ctx,
          rootPost.id,
          /Forcing update/,
          { timeout: 5000 }
        );
        expect(forcingPost).toBeDefined();
      });

      it('should handle thumbs down reaction to defer update', async () => {
        // Start a session first
        const rootPost = await startSession(ctx, 'hello for defer test', getBotUsername());
        testThreadIds.push(rootPost.id);

        // Wait for session to be active
        await waitForSessionHeader(ctx, rootPost.id, {
          timeout: 30000,
          sessionManager: bot.sessionManager,
        });
        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

        // Create and set a mock auto update manager
        const mockAutoUpdateManager = createMockAutoUpdateManager();
        bot.sessionManager.setAutoUpdateManager(mockAutoUpdateManager);

        // Call postUpdateAskMessage
        await bot.sessionManager.postUpdateAskMessage([rootPost.id], '99.99.99');

        // Verify the update message was posted
        const updatePost = await waitForPostMatching(
          ctx,
          rootPost.id,
          /Update available.*99\.99\.99/,
          { timeout: 5000 }
        );
        expect(updatePost).toBeDefined();

        // Add a thumbs down reaction (simulating user deferral)
        await addReaction(ctx, updatePost.id, '-1');

        // Wait for the reaction to be processed
        await waitFor(
          async () => mockAutoUpdateManager.deferUpdateCalled,
          {
            timeout: 10000,
            interval: 200,
            description: 'defer to be triggered via reaction',
          }
        );

        expect(mockAutoUpdateManager.deferUpdateCalled).toBe(true);
        expect(mockAutoUpdateManager.deferMinutes).toBe(60); // Default defer is 60 minutes

        // Verify the post was updated to show deferral
        const deferredPost = await waitForPostMatching(
          ctx,
          rootPost.id,
          /Update deferred/,
          { timeout: 5000 }
        );
        expect(deferredPost).toBeDefined();
      });
    });
  });
});
