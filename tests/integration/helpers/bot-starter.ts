/**
 * Headless bot starter for integration tests
 *
 * Creates a claude-threads bot without the Ink UI, allowing us to test
 * the full session lifecycle in a non-TTY environment.
 *
 * IMPORTANT: This uses the actual message handler from src/message-handler.ts
 * to ensure tests exercise the real bot logic, not a duplicate.
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { MattermostClient } from '../../../src/platform/mattermost/client.js';
import { SessionManager } from '../../../src/session/index.js';
import { SessionStore } from '../../../src/persistence/session-store.js';
import type { PlatformPost, PlatformUser } from '../../../src/platform/types.js';
import { loadConfig } from '../setup/config.js';
import { handleMessage } from '../../../src/message-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Generate a unique sessions path for test isolation
 * Each test bot instance gets its own sessions.json file
 */
function generateTestSessionsPath(): string {
  const testRunId = randomBytes(4).toString('hex');
  const sessionsDir = join(tmpdir(), 'claude-threads-test');
  mkdirSync(sessionsDir, { recursive: true });
  return join(sessionsDir, `sessions-${testRunId}.json`);
}

export interface TestBot {
  sessionManager: SessionManager;
  mattermostClient: MattermostClient;
  platformId: string;
  /** Stop the bot and unpersist all sessions (normal cleanup) */
  stop(): Promise<void>;
  /** Stop the bot but preserve persisted sessions (for restart testing) */
  stopAndPreserveSessions(): Promise<void>;
}

export interface StartBotOptions {
  /** Mock Claude CLI scenario to use (default: 'simple-response') */
  scenario?: string;
  /** Skip permission prompts (default: true for tests) */
  skipPermissions?: boolean;
  /** Working directory for Claude sessions */
  workingDir?: string;
  /** Additional allowed users beyond config */
  extraAllowedUsers?: string[];
  /** Enable debug logging */
  debug?: boolean;
  /** Clear persisted sessions before starting (default: true for tests) */
  clearPersistedSessions?: boolean;
  /** Override allowed users completely (ignores testUsers from config) */
  allowedUsersOverride?: string[];
}

/**
 * Start a headless test bot
 *
 * This creates a fully functional claude-threads bot without the Ink UI,
 * using the mock Claude CLI for deterministic testing.
 */
export async function startTestBot(options: StartBotOptions = {}): Promise<TestBot> {
  const {
    scenario = 'simple-response',
    skipPermissions = true,
    workingDir = '/tmp/claude-threads-test',
    extraAllowedUsers = [],
    debug = process.env.DEBUG === '1',
    clearPersistedSessions = true,
    allowedUsersOverride,
  } = options;

  // Load test config
  const testConfig = loadConfig();

  // Ensure working directory exists (spawn fails with ENOENT if cwd doesn't exist)
  mkdirSync(workingDir, { recursive: true });

  // Set up isolated session storage for this test bot instance
  // This prevents session state from leaking between test files
  // If clearPersistedSessions is false and we already have a path set, reuse it (for resume tests)
  const existingPath = process.env.CLAUDE_THREADS_SESSIONS_PATH;
  const sessionsPath = (!clearPersistedSessions && existingPath)
    ? existingPath
    : generateTestSessionsPath();
  process.env.CLAUDE_THREADS_SESSIONS_PATH = sessionsPath;

  // Clear persisted sessions to avoid "Thread deleted, skipping resume" noise
  if (clearPersistedSessions) {
    const store = new SessionStore(); // Will use CLAUDE_THREADS_SESSIONS_PATH
    store.clear();
  }

  // Set environment variables for mock Claude CLI
  // Use the wrapper script since spawn() can't handle "bun runner.ts" as a single command
  const mockClaudePath = join(__dirname, '../fixtures/mock-claude/mock-claude');

  // Verify the mock exists (helps debug CI issues)
  if (!existsSync(mockClaudePath)) {
    throw new Error(`Mock Claude CLI not found at: ${mockClaudePath}`);
  }

  if (debug) {
    console.log(`[test-bot] Mock Claude CLI path: ${mockClaudePath}`);
  }

  process.env.CLAUDE_PATH = mockClaudePath;
  process.env.CLAUDE_SCENARIO = scenario;
  if (debug) {
    process.env.DEBUG = '1';
  }

  // Build platform config
  const platformId = 'test-mattermost';
  const allowedUsers = allowedUsersOverride ?? [
    ...testConfig.mattermost.testUsers.map(u => u.username),
    ...extraAllowedUsers,
  ];

  const platformConfig = {
    id: platformId,
    type: 'mattermost' as const,
    displayName: 'Test Mattermost',
    url: testConfig.mattermost.url,
    token: testConfig.mattermost.bot.token!,
    channelId: testConfig.mattermost.channel.id!,
    botName: testConfig.mattermost.bot.username,
    allowedUsers,
    skipPermissions,
  };

  // Create the Mattermost client
  const mattermostClient = new MattermostClient(platformConfig);

  // Create the session manager (no UI, no chrome, no worktrees for tests)
  const sessionManager = new SessionManager(
    workingDir,
    skipPermissions,
    false, // chrome disabled
    'off', // worktree mode off
  );

  // Register platform (this wires up reaction handlers)
  sessionManager.addPlatform(platformId, mattermostClient);

  // Wire up message handler - uses the actual bot logic from src/message-handler.ts
  mattermostClient.on('message', async (post: PlatformPost, user: PlatformUser | null) => {
    await handleMessage(mattermostClient, sessionManager, post, user, {
      platformId,
      logger: debug ? {
        error: (msg) => console.error('[test-bot]', msg),
      } : undefined,
      onKill: () => {
        // In tests, just disconnect without exiting the process
        sessionManager.killAllSessionsAndUnpersist();
        mattermostClient.disconnect();
        // Clear environment (same as stop())
        delete process.env.CLAUDE_PATH;
        delete process.env.CLAUDE_SCENARIO;
      },
    });
  });

  // Connect to Mattermost
  await mattermostClient.connect();

  // Initialize session manager (loads persisted sessions)
  await sessionManager.initialize();

  if (debug) {
    console.log('[test-bot] Started with scenario:', scenario);
  }

  return {
    sessionManager,
    mattermostClient,
    platformId,
    async stop() {
      if (debug) {
        console.log('[test-bot] Stopping...');
      }
      // Kill all sessions and unpersist
      sessionManager.killAllSessionsAndUnpersist();
      // Disconnect from Mattermost
      mattermostClient.disconnect();
      // Wait a bit for processes to terminate fully
      await new Promise((r) => setTimeout(r, 100));
      // Clear environment AFTER processes are terminated
      delete process.env.CLAUDE_PATH;
      delete process.env.CLAUDE_SCENARIO;
      delete process.env.CLAUDE_THREADS_SESSIONS_PATH;
      if (debug) {
        console.log('[test-bot] Stopped');
      }
    },
    async stopAndPreserveSessions() {
      if (debug) {
        console.log('[test-bot] Stopping (preserving sessions)...');
      }
      // Set shutting down flag so killAllSessions preserves persistence
      sessionManager.setShuttingDown();
      // Kill sessions but keep persistence (simulates graceful shutdown)
      await sessionManager.killAllSessions();
      // Disconnect from Mattermost
      mattermostClient.disconnect();
      // Wait a bit for processes to terminate fully
      await new Promise((r) => setTimeout(r, 100));
      // Clear environment AFTER processes are terminated
      // NOTE: Keep CLAUDE_THREADS_SESSIONS_PATH so the next bot instance uses the same file
      delete process.env.CLAUDE_PATH;
      delete process.env.CLAUDE_SCENARIO;
      if (debug) {
        console.log('[test-bot] Stopped (sessions preserved)');
      }
    },
  };
}

// Singleton for shared bot instance across tests
let sharedBot: TestBot | null = null;

/**
 * Get or create a shared bot instance
 *
 * Use this when tests can share a bot instance (different threads).
 * The bot is automatically stopped when the process exits.
 */
export async function getSharedBot(options?: StartBotOptions): Promise<TestBot> {
  if (!sharedBot) {
    sharedBot = await startTestBot(options);

    // Clean up on process exit
    process.on('beforeExit', async () => {
      if (sharedBot) {
        await sharedBot.stop();
        sharedBot = null;
      }
    });
  }
  return sharedBot;
}

/**
 * Stop the shared bot instance
 */
export async function stopSharedBot(): Promise<void> {
  if (sharedBot) {
    await sharedBot.stop();
    sharedBot = null;
  }
}

/**
 * Restart the shared bot with a different scenario
 */
export async function restartBotWithScenario(scenario: string): Promise<TestBot> {
  if (sharedBot) {
    await sharedBot.stop();
    sharedBot = null;
  }
  return getSharedBot({ scenario });
}
