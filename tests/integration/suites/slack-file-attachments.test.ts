/**
 * Slack File Attachment Tests
 *
 * Tests that the Slack client properly handles file_share message events
 * (messages with image attachments).
 *
 * This is a Slack-specific test because Mattermost handles file attachments differently.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { loadConfig, DEFAULT_SLACK_CONFIG } from '../setup/config.js';
import {
  SlackMockServer,
  createTestImageFile,
  type SlackFile,
} from '../fixtures/slack/mock-server.js';
import {
  initTestContext,
  waitForBotResponse,
  waitForSessionActive,
  getPlatformBotOptions,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, stopSharedBot, type TestBot } from '../helpers/bot-starter.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

// This test is Slack-specific - we use 'slack' as a tuple for describe.each
describe.skipIf(SKIP)('Slack File Attachments', () => {
  describe('slack platform', () => {
    const platformType = 'slack' as const;
    let config: ReturnType<typeof loadConfig>;
    let ctx: TestSessionContext;
    let bot: TestBot;
    let mockServer: SlackMockServer;
    let slackConfig: typeof DEFAULT_SLACK_CONFIG;
    const testThreadIds: string[] = [];

    beforeAll(async () => {
      config = loadConfig();
      slackConfig = config.slack || DEFAULT_SLACK_CONFIG;

      // Start our own mock server for this test (we need direct access to inject files)
      const mockPort = parseInt(process.env.SLACK_MOCK_PORT || String(slackConfig.mockServerPort), 10);

      // Check if mock server is already running
      let serverAlreadyRunning = false;
      try {
        const response = await fetch(`http://localhost:${mockPort}/api/api.test`, { method: 'POST' });
        const data = await response.json() as { ok: boolean };
        serverAlreadyRunning = data.ok === true;
      } catch {
        serverAlreadyRunning = false;
      }

      if (!serverAlreadyRunning) {
        mockServer = new SlackMockServer({
          port: mockPort,
          debug: process.env.DEBUG === '1',
        });
        await mockServer.start();
      } else {
        // Server is already running (from setup script), we can't inject files directly
        // but we can still test via the API
        console.log('Using existing mock server - some file injection tests may be limited');
      }

      // Initialize test context
      ctx = initTestContext(platformType);

      // Start the test bot
      bot = await startTestBot(getPlatformBotOptions(platformType, {
        scenario: 'simple-response',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
      }));
    });

    afterAll(async () => {
      // Stop the bot
      await stopSharedBot();

      // Stop our mock server if we started it
      if (mockServer) {
        await mockServer.stop();
      }
    });

    afterEach(async () => {
      // Kill all sessions between tests to avoid interference
      await bot.sessionManager.killAllSessions();
      await new Promise((r) => setTimeout(r, 200));
    });

    describe('File Share Message Events', () => {
      it('should receive messages with file_share subtype', async () => {
        // Skip if we don't have direct access to the mock server
        if (!mockServer) {
          console.log('Skipping - requires direct mock server access');
          return;
        }

        // Create a test image file and add it to the mock server
        const testFile = createTestImageFile({
          id: `F_TEST_${Date.now()}`,
          name: 'screenshot.png',
        });
        mockServer.addFile(testFile);

        // Get the test user ID
        const testUserId = slackConfig.testUsers[0]?.userId || 'U_TEST_USER1';
        const channelId = slackConfig.channelId;

        // Simulate a file_share message event with bot mention
        const message = mockServer.simulateFileShareEvent(
          channelId,
          testUserId,
          `<@U_BOT_USER> please analyze this image`,
          [testFile as SlackFile],
        );
        testThreadIds.push(message.ts);

        // Wait for bot to respond - if the file_share subtype fix works,
        // the bot should receive this message and start a session
        const botResponses = await waitForBotResponse(ctx, message.ts, {
          timeout: 30000,
          minResponses: 1,
        });

        // Verify the bot responded (meaning it received the file_share message)
        expect(botResponses.length).toBeGreaterThanOrEqual(1);
      });

      it('should start a session when mentioning bot with an image attachment', async () => {
        // Skip if we don't have direct access to the mock server
        if (!mockServer) {
          console.log('Skipping - requires direct mock server access');
          return;
        }

        // Create a test image file
        const testFile = createTestImageFile({
          id: `F_TEST_SESSION_${Date.now()}`,
          name: 'debug-screenshot.png',
        });
        mockServer.addFile(testFile);

        const testUserId = slackConfig.testUsers[0]?.userId || 'U_TEST_USER1';
        const channelId = slackConfig.channelId;

        // Simulate a file_share message with bot mention
        const message = mockServer.simulateFileShareEvent(
          channelId,
          testUserId,
          `<@U_BOT_USER> what do you see in this image?`,
          [testFile as SlackFile],
        );
        testThreadIds.push(message.ts);

        // Wait for session to become active
        await waitForSessionActive(bot.sessionManager, message.ts, {
          timeout: 30000,
        });

        // Verify session was started
        expect(bot.sessionManager.isInSessionThread(message.ts)).toBe(true);
      });

      it('should include file metadata in the message', async () => {
        // Skip if we don't have direct access to the mock server
        if (!mockServer) {
          console.log('Skipping - requires direct mock server access');
          return;
        }

        // Create a test file with specific metadata
        const testFile = createTestImageFile({
          id: `F_META_${Date.now()}`,
          name: 'test-with-metadata.png',
          size: 12345,
        });
        mockServer.addFile(testFile);

        const testUserId = slackConfig.testUsers[0]?.userId || 'U_TEST_USER1';
        const channelId = slackConfig.channelId;

        // Simulate file_share event
        const message = mockServer.simulateFileShareEvent(
          channelId,
          testUserId,
          `<@U_BOT_USER> check this file`,
          [testFile as SlackFile],
        );
        testThreadIds.push(message.ts);

        // Wait for bot to respond
        await waitForBotResponse(ctx, message.ts, {
          timeout: 30000,
          minResponses: 1,
        });

        // Verify the message was stored with file information
        const storedMessage = mockServer.getMessage(channelId, message.ts);
        expect(storedMessage).toBeDefined();
        expect(storedMessage?.files).toBeDefined();
        expect(storedMessage?.files?.length).toBe(1);
        expect(storedMessage?.files?.[0].id).toBe(testFile.id);
        expect(storedMessage?.files?.[0].name).toBe('test-with-metadata.png');
      });
    });
  });
});
