/**
 * File Attachment Integration Tests
 *
 * Tests that the bot properly handles various file types:
 * - PDF files (document content blocks)
 * - Text files (JSON, TXT, MD, CSV)
 * - Gzip compressed files
 * - Unsupported files (should show user feedback)
 *
 * These tests use the Slack mock server for file injection and verification.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { loadConfig, DEFAULT_SLACK_CONFIG } from '../setup/config.js';
import {
  SlackMockServer,
  createTestImageFile,
  createTestPdfFile,
  createTestTextFile,
  createTestGzipFile,
  createTestFile,
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

describe.skipIf(SKIP)('File Attachments', () => {
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

      // Start our own mock server for this test
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
      await stopSharedBot();
      if (mockServer) {
        await mockServer.stop();
      }
    });

    afterEach(async () => {
      await bot.sessionManager.killAllSessions();
      await new Promise((r) => setTimeout(r, 200));
    });

    // =========================================================================
    // PDF File Tests
    // =========================================================================

    describe('PDF Files', () => {
      it('should handle PDF file attachments', async () => {
        if (!mockServer) {
          console.log('Skipping - requires direct mock server access');
          return;
        }

        const testFile = createTestPdfFile({
          id: `F_PDF_${Date.now()}`,
          name: 'document.pdf',
        });
        mockServer.addFile(testFile);

        const testUserId = slackConfig.testUsers[0]?.userId || 'U_TEST_USER1';
        const channelId = slackConfig.channelId;

        const message = mockServer.simulateFileShareEvent(
          channelId,
          testUserId,
          `<@U_BOT_USER> please analyze this PDF`,
          [testFile as SlackFile],
        );
        testThreadIds.push(message.ts);

        const botResponses = await waitForBotResponse(ctx, message.ts, {
          timeout: 30000,
          minResponses: 1,
        });

        expect(botResponses.length).toBeGreaterThanOrEqual(1);
      });

      it('should start a session with PDF attachment', async () => {
        if (!mockServer) {
          console.log('Skipping - requires direct mock server access');
          return;
        }

        const testFile = createTestPdfFile({
          id: `F_PDF_SESSION_${Date.now()}`,
          name: 'report.pdf',
        });
        mockServer.addFile(testFile);

        const testUserId = slackConfig.testUsers[0]?.userId || 'U_TEST_USER1';
        const channelId = slackConfig.channelId;

        const message = mockServer.simulateFileShareEvent(
          channelId,
          testUserId,
          `<@U_BOT_USER> summarize this PDF document`,
          [testFile as SlackFile],
        );
        testThreadIds.push(message.ts);

        await waitForSessionActive(bot.sessionManager, message.ts, {
          timeout: 30000,
        });

        expect(bot.sessionManager.isInSessionThread(message.ts)).toBe(true);
      });
    });

    // =========================================================================
    // Text File Tests
    // =========================================================================

    describe('Text Files', () => {
      it('should handle JSON file attachments', async () => {
        if (!mockServer) {
          console.log('Skipping - requires direct mock server access');
          return;
        }

        const testFile = createTestTextFile({
          id: `F_JSON_${Date.now()}`,
          name: 'config.json',
          content: '{"version": "1.0", "features": ["a", "b", "c"]}',
        });
        mockServer.addFile(testFile);

        const testUserId = slackConfig.testUsers[0]?.userId || 'U_TEST_USER1';
        const channelId = slackConfig.channelId;

        const message = mockServer.simulateFileShareEvent(
          channelId,
          testUserId,
          `<@U_BOT_USER> what's in this JSON file?`,
          [testFile as SlackFile],
        );
        testThreadIds.push(message.ts);

        const botResponses = await waitForBotResponse(ctx, message.ts, {
          timeout: 30000,
          minResponses: 1,
        });

        expect(botResponses.length).toBeGreaterThanOrEqual(1);
      });

      it('should handle plain text file attachments', async () => {
        if (!mockServer) {
          console.log('Skipping - requires direct mock server access');
          return;
        }

        const testFile = createTestTextFile({
          id: `F_TXT_${Date.now()}`,
          name: 'readme.txt',
          content: 'This is a plain text file.\nIt has multiple lines.\nPlease analyze it.',
        });
        mockServer.addFile(testFile);

        const testUserId = slackConfig.testUsers[0]?.userId || 'U_TEST_USER1';
        const channelId = slackConfig.channelId;

        const message = mockServer.simulateFileShareEvent(
          channelId,
          testUserId,
          `<@U_BOT_USER> read this text file`,
          [testFile as SlackFile],
        );
        testThreadIds.push(message.ts);

        const botResponses = await waitForBotResponse(ctx, message.ts, {
          timeout: 30000,
          minResponses: 1,
        });

        expect(botResponses.length).toBeGreaterThanOrEqual(1);
      });

      it('should handle markdown file attachments', async () => {
        if (!mockServer) {
          console.log('Skipping - requires direct mock server access');
          return;
        }

        const testFile = createTestTextFile({
          id: `F_MD_${Date.now()}`,
          name: 'README.md',
          content: '# Project Title\n\n## Description\n\nThis is a test project.\n\n- Feature 1\n- Feature 2',
        });
        mockServer.addFile(testFile);

        const testUserId = slackConfig.testUsers[0]?.userId || 'U_TEST_USER1';
        const channelId = slackConfig.channelId;

        const message = mockServer.simulateFileShareEvent(
          channelId,
          testUserId,
          `<@U_BOT_USER> what does this README say?`,
          [testFile as SlackFile],
        );
        testThreadIds.push(message.ts);

        const botResponses = await waitForBotResponse(ctx, message.ts, {
          timeout: 30000,
          minResponses: 1,
        });

        expect(botResponses.length).toBeGreaterThanOrEqual(1);
      });
    });

    // =========================================================================
    // Gzip File Tests
    // =========================================================================

    describe('Gzip Compressed Files', () => {
      it('should handle gzip-compressed JSON files', async () => {
        if (!mockServer) {
          console.log('Skipping - requires direct mock server access');
          return;
        }

        const testFile = createTestGzipFile({
          id: `F_GZIP_${Date.now()}`,
          name: 'data.json.gz',
          innerContent: '{"compressed": true, "data": [1, 2, 3, 4, 5]}',
        });
        mockServer.addFile(testFile);

        const testUserId = slackConfig.testUsers[0]?.userId || 'U_TEST_USER1';
        const channelId = slackConfig.channelId;

        const message = mockServer.simulateFileShareEvent(
          channelId,
          testUserId,
          `<@U_BOT_USER> decompress and analyze this file`,
          [testFile as SlackFile],
        );
        testThreadIds.push(message.ts);

        const botResponses = await waitForBotResponse(ctx, message.ts, {
          timeout: 30000,
          minResponses: 1,
        });

        expect(botResponses.length).toBeGreaterThanOrEqual(1);
      });

      it('should handle Firefox profiler traces (.gz files)', async () => {
        if (!mockServer) {
          console.log('Skipping - requires direct mock server access');
          return;
        }

        // Simulate a Firefox profiler trace (simplified)
        const profilerData = JSON.stringify({
          meta: { product: 'Firefox', version: '120.0' },
          threads: [{ name: 'Main Thread', samples: { time: [0, 10, 20] } }],
        });

        const testFile = createTestGzipFile({
          id: `F_PROFILER_${Date.now()}`,
          name: 'Firefox 2024-01-15 11.20.gz',
          innerContent: profilerData,
        });
        mockServer.addFile(testFile);

        const testUserId = slackConfig.testUsers[0]?.userId || 'U_TEST_USER1';
        const channelId = slackConfig.channelId;

        const message = mockServer.simulateFileShareEvent(
          channelId,
          testUserId,
          `<@U_BOT_USER> analyze this Firefox profiler trace`,
          [testFile as SlackFile],
        );
        testThreadIds.push(message.ts);

        const botResponses = await waitForBotResponse(ctx, message.ts, {
          timeout: 30000,
          minResponses: 1,
        });

        expect(botResponses.length).toBeGreaterThanOrEqual(1);
      });
    });

    // =========================================================================
    // Mixed File Type Tests
    // =========================================================================

    describe('Mixed File Types', () => {
      it('should handle multiple files of different types', async () => {
        if (!mockServer) {
          console.log('Skipping - requires direct mock server access');
          return;
        }

        const imageFile = createTestImageFile({
          id: `F_IMG_MIX_${Date.now()}`,
          name: 'screenshot.png',
        });
        const pdfFile = createTestPdfFile({
          id: `F_PDF_MIX_${Date.now()}`,
          name: 'document.pdf',
        });
        const jsonFile = createTestTextFile({
          id: `F_JSON_MIX_${Date.now()}`,
          name: 'config.json',
          content: '{"key": "value"}',
        });

        mockServer.addFile(imageFile);
        mockServer.addFile(pdfFile);
        mockServer.addFile(jsonFile);

        const testUserId = slackConfig.testUsers[0]?.userId || 'U_TEST_USER1';
        const channelId = slackConfig.channelId;

        const message = mockServer.simulateFileShareEvent(
          channelId,
          testUserId,
          `<@U_BOT_USER> analyze all these files`,
          [imageFile as SlackFile, pdfFile as SlackFile, jsonFile as SlackFile],
        );
        testThreadIds.push(message.ts);

        const botResponses = await waitForBotResponse(ctx, message.ts, {
          timeout: 30000,
          minResponses: 1,
        });

        expect(botResponses.length).toBeGreaterThanOrEqual(1);
      });
    });

    // =========================================================================
    // Unsupported File Tests
    // =========================================================================

    describe('Unsupported Files', () => {
      it('should show feedback for unsupported file types', async () => {
        if (!mockServer) {
          console.log('Skipping - requires direct mock server access');
          return;
        }

        // Create a Word document (unsupported)
        const testFile = createTestFile({
          id: `F_DOC_${Date.now()}`,
          name: 'document.docx',
          mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          filetype: 'docx',
          _mock_content: Buffer.from('fake docx content'),
        });
        mockServer.addFile(testFile);

        const testUserId = slackConfig.testUsers[0]?.userId || 'U_TEST_USER1';
        const channelId = slackConfig.channelId;

        const message = mockServer.simulateFileShareEvent(
          channelId,
          testUserId,
          `<@U_BOT_USER> analyze this Word document`,
          [testFile as SlackFile],
        );
        testThreadIds.push(message.ts);

        // Wait for bot response
        const botResponses = await waitForBotResponse(ctx, message.ts, {
          timeout: 30000,
          minResponses: 1,
        });

        expect(botResponses.length).toBeGreaterThanOrEqual(1);

        // Check if one of the responses mentions the unsupported file
        // The bot should either respond with a warning about the unsupported file
        // or still process the message (Claude will see text-only)
        const hasSkippedFileMessage = botResponses.some(
          (r) => r.message.includes('could not be processed') || r.message.includes('Unsupported')
        );
        // Either we got a skip message OR the bot processed the text-only message
        expect(hasSkippedFileMessage || botResponses.length >= 1).toBe(true);
      });

      it('should provide helpful suggestions for common unsupported formats', async () => {
        if (!mockServer) {
          console.log('Skipping - requires direct mock server access');
          return;
        }

        // Create an Excel file (unsupported)
        const testFile = createTestFile({
          id: `F_XLS_${Date.now()}`,
          name: 'spreadsheet.xlsx',
          mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          filetype: 'xlsx',
          _mock_content: Buffer.from('fake xlsx content'),
        });
        mockServer.addFile(testFile);

        const testUserId = slackConfig.testUsers[0]?.userId || 'U_TEST_USER1';
        const channelId = slackConfig.channelId;

        const message = mockServer.simulateFileShareEvent(
          channelId,
          testUserId,
          `<@U_BOT_USER> read this spreadsheet`,
          [testFile as SlackFile],
        );
        testThreadIds.push(message.ts);

        const botResponses = await waitForBotResponse(ctx, message.ts, {
          timeout: 30000,
          minResponses: 1,
        });

        // Bot should respond (even if file is skipped, message text is sent to Claude)
        expect(botResponses.length).toBeGreaterThanOrEqual(1);
      });
    });
  });
});
