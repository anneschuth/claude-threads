/**
 * Session Resume Integration Tests
 *
 * Tests session persistence and resume functionality:
 * - Sessions are persisted for recovery
 * - Bot restart resumes persisted sessions
 * - Resume via emoji reaction on timeout posts
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import { MattermostTestApi } from '../fixtures/mattermost/api-helpers.js';
import {
  initTestContext,
  startSession,
  waitForBotResponse,
  waitForPostMatching,
  addReaction,
  waitForSessionActive,
  waitForSessionPersisted,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, stopSharedBot, type TestBot } from '../helpers/bot-starter.js';
import { SessionStore } from '../../../src/persistence/session-store.js';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

describe.skipIf(SKIP)('Session Resume', () => {
  let config: ReturnType<typeof loadConfig>;
  let ctx: TestSessionContext;
  let adminApi: MattermostTestApi;
  let sessionStore: SessionStore;
  const testThreadIds: string[] = [];

  beforeAll(async () => {
    config = loadConfig();
    adminApi = new MattermostTestApi(config.mattermost.url, config.mattermost.admin.token!);
    ctx = initTestContext();
    sessionStore = new SessionStore();
  });

  afterAll(async () => {
    // Stop any shared bot
    await stopSharedBot();

    // Clean up test threads
    for (const threadId of testThreadIds) {
      try {
        await adminApi.deletePost(threadId);
      } catch {
        // Ignore cleanup errors
      }
    }

    // Clear the session store
    sessionStore.clear();
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });

  describe('Session Persistence', () => {
    let bot: TestBot;

    afterEach(async () => {
      if (bot) {
        await bot.stop();
      }
    });

    it('should persist session after Claude responds', async () => {
      // Start bot with persistent-session (no result event, stays alive)
      // simple-response scenario ends immediately and unpersists
      bot = await startTestBot({
        scenario: 'persistent-session',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
        clearPersistedSessions: true, // Start fresh
      });

      // Start a session
      const rootPost = await startSession(ctx, 'Help me test persistence', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // Wait for session to be active
      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

      // Wait for Claude's response (this is when persistence happens)
      await waitForBotResponse(ctx, rootPost.id, {
        timeout: 30000,
        minResponses: 1,
      });

      // Wait for session to be persisted
      await waitForSessionPersisted(rootPost.id);

      // Check that session was persisted
      const persisted = sessionStore.load();
      let foundSession = false;
      for (const session of persisted.values()) {
        if (session.threadId === rootPost.id) {
          foundSession = true;
          expect(session.startedBy).toBeDefined();
          expect(session.workingDir).toBeDefined();
          expect(session.claudeSessionId).toBeDefined();
          break;
        }
      }

      expect(foundSession).toBe(true);
    });

    it('should preserve session state in persistence', async () => {
      bot = await startTestBot({
        scenario: 'persistent-session',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
        clearPersistedSessions: true,
      });

      // Start a session
      const rootPost = await startSession(ctx, 'Test state persistence', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // Wait for session and response
      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });
      await waitForBotResponse(ctx, rootPost.id, {
        timeout: 15000,
        minResponses: 1,
      });

      // Wait for session to be persisted
      await waitForSessionPersisted(rootPost.id);

      // Verify persisted state
      const persisted = sessionStore.load();
      let foundSession = false;
      for (const session of persisted.values()) {
        if (session.threadId === rootPost.id) {
          foundSession = true;
          expect(session.platformId).toBe('test-mattermost');
          expect(session.threadId).toBe(rootPost.id);
          expect(session.startedAt).toBeDefined();
          expect(session.lastActivityAt).toBeDefined();
          break;
        }
      }

      expect(foundSession).toBe(true);
    });
  });

  describe('Bot Restart Resume', () => {
    it('should resume sessions on bot restart', async () => {
      // Start first bot and create a session
      let bot = await startTestBot({
        scenario: 'persistent-session',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
        clearPersistedSessions: true,
      });

      // Start a session
      const rootPost = await startSession(ctx, 'Session to resume after restart', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // Wait for session to be active
      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });
      await waitForBotResponse(ctx, rootPost.id, {
        timeout: 15000,
        minResponses: 1,
      });

      // Wait for session to be persisted
      await waitForSessionPersisted(rootPost.id);

      // Verify session is persisted
      const persisted = sessionStore.load();
      let hasSession = false;
      for (const session of persisted.values()) {
        if (session.threadId === rootPost.id) {
          hasSession = true;
          break;
        }
      }
      expect(hasSession).toBe(true);

      // Stop the first bot while preserving persisted sessions (simulating restart)
      await bot.stopAndPreserveSessions();

      // Small delay to ensure cleanup
      await new Promise((r) => setTimeout(r, 200));

      // Start a new bot (should resume the session)
      bot = await startTestBot({
        scenario: 'persistent-session',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
        clearPersistedSessions: false, // Don't clear - we want to resume
      });

      // Wait for session to be resumed
      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 15000 });

      // Verify session was resumed
      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);

      // Check for resume message
      const resumePost = await waitForPostMatching(ctx, rootPost.id, /resumed|restart/i, { timeout: 10000 });
      expect(resumePost).toBeDefined();

      // Cleanup
      await bot.stop();
    });
  });

  describe('Resume via Reaction', () => {
    it('should resume session when user reacts with 🔄 on timeout post', async () => {
      // This test simulates timeout and resume via reaction
      // We need a session that gets timed out and persisted

      const bot = await startTestBot({
        scenario: 'persistent-session',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
        clearPersistedSessions: true,
      });

      // Start a session
      const rootPost = await startSession(ctx, 'Session for reaction resume', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // Wait for session and response
      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });
      await waitForBotResponse(ctx, rootPost.id, {
        timeout: 15000,
        minResponses: 1,
      });

      // Get the session header post (sessionStartPostId)
      // This is the post we can react to for resume
      const sessions = sessionStore.load();
      let sessionStartPostId: string | null = null;
      for (const session of sessions.values()) {
        if (session.threadId === rootPost.id) {
          sessionStartPostId = session.sessionStartPostId;
          break;
        }
      }

      expect(sessionStartPostId).toBeDefined();

      // Kill the session but keep persistence (simulate timeout)
      await bot.sessionManager.killAllSessions();
      await new Promise((r) => setTimeout(r, 200));

      // Verify session is no longer active
      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(false);

      // Now react with 🔄 on the session header post
      if (sessionStartPostId) {
        await addReaction(ctx, sessionStartPostId, 'arrows_counterclockwise');

        // Wait for session to be resumed
        await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

        // Verify session was resumed
        expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);
      }

      await bot.stop();
    });
  });
});
