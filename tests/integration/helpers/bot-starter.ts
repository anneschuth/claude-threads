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
import { SlackClient } from '../../../src/platform/slack/client.js';
import { SessionManager } from '../../../src/session/index.js';
import { SessionStore } from '../../../src/persistence/session-store.js';
import type { PlatformClient } from '../../../src/platform/client.js';
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

/**
 * Round-robin cursor into the Mattermost bot pool. Each call to
 * startTestBot picks the next bot. Avoids two test bots sharing the same
 * Mattermost user token (which would cause WebSocket events to be
 * delivered to both — the cross-test interference that broke MAX_SESSIONS).
 */
let mattermostBotPoolCursor = 0;
function nextMattermostBot(testConfig: ReturnType<typeof loadConfig>): {
  bot: { username: string; displayName: string; token?: string; userId?: string };
  index: number;
} {
  const pool = testConfig.mattermost.bots;
  if (!pool || pool.length === 0) {
    return { bot: testConfig.mattermost.bot, index: 0 };
  }
  const idx = mattermostBotPoolCursor % pool.length;
  mattermostBotPoolCursor++;
  return { bot: pool[idx], index: idx };
}

export interface TestBot {
  sessionManager: SessionManager;
  /** @deprecated Use `platformClient` instead for platform-agnostic access */
  mattermostClient: MattermostClient;
  /** The platform client (MattermostClient or SlackClient) */
  platformClient: PlatformClient;
  platformId: string;
  /** The isolated sessions file path for this test bot */
  sessionsPath: string;
  /**
   * The bot's mention name. For Mattermost this is the unique pool bot
   * username (e.g. "claude-test-bot-3"); for Slack it's the configured
   * mock bot name. Use this to construct `@mention` strings — the config
   * default may belong to a different test's bot.
   */
  botUsername: string;
  /** The bot's user ID — match this when filtering bot posts. */
  botUserId: string;
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
  /** Explicit sessions file path (for restart scenarios, to reuse the same file) */
  sessionsPath?: string;
  /** Git worktree mode: 'off' (default for tests), 'prompt', or 'require' */
  worktreeMode?: 'off' | 'prompt' | 'require';
  /** Platform type to use (default: 'mattermost') */
  platform?: 'mattermost' | 'slack';
  /** Port for Slack mock server (required when platform is 'slack') */
  slackMockPort?: number;
  /** Slack bot token for testing (required when platform is 'slack') */
  slackBotToken?: string;
  /** Slack app token for testing (required when platform is 'slack') */
  slackAppToken?: string;
  /** Slack channel ID for testing (required when platform is 'slack') */
  slackChannelId?: string;
  /** Slack bot name for testing (default: 'claude-test-bot') */
  slackBotName?: string;
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
    sessionsPath: explicitSessionsPath,
    worktreeMode = 'off',
    platform = 'mattermost',
    slackMockPort,
    slackBotToken,
    slackAppToken,
    slackChannelId,
    slackBotName = 'claude-test-bot',
  } = options;

  // Load test config
  const testConfig = loadConfig();

  // Ensure working directory exists (spawn fails with ENOENT if cwd doesn't exist)
  mkdirSync(workingDir, { recursive: true });

  // Set up isolated session storage for this test bot instance
  // This prevents session state from leaking between test files
  // Priority: explicit path > generate new path
  const sessionsPath = explicitSessionsPath ?? generateTestSessionsPath();
  process.env.CLAUDE_THREADS_SESSIONS_PATH = sessionsPath;

  // Clear persisted sessions to avoid "Thread deleted, skipping resume" noise
  if (clearPersistedSessions) {
    const store = new SessionStore(sessionsPath); // Use explicit path for isolation
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

  // Create platform client based on platform type
  let platformClient: PlatformClient;
  let platformId: string;
  let botUsername: string;
  let botUserId: string;

  if (platform === 'slack') {
    // Validate required Slack options
    if (!slackMockPort) {
      throw new Error('slackMockPort is required when platform is "slack"');
    }
    if (!slackBotToken) {
      throw new Error('slackBotToken is required when platform is "slack"');
    }
    if (!slackAppToken) {
      throw new Error('slackAppToken is required when platform is "slack"');
    }
    if (!slackChannelId) {
      throw new Error('slackChannelId is required when platform is "slack"');
    }

    platformId = 'test-slack';
    const allowedUsers = allowedUsersOverride ?? extraAllowedUsers;

    const slackConfig = {
      id: platformId,
      type: 'slack' as const,
      displayName: 'Test Slack',
      botToken: slackBotToken,
      appToken: slackAppToken,
      channelId: slackChannelId,
      botName: slackBotName,
      allowedUsers,
      skipPermissions,
      apiUrl: `http://localhost:${slackMockPort}/api`,
    };

    platformClient = new SlackClient(slackConfig);
    botUsername = slackBotName;
    botUserId = 'U_BOT_USER';
  } else {
    // Default: Mattermost — pick the next bot from the pool so each test
    // has its own user token (no cross-test event interference). Use a
    // unique platformId per pool slot so module-level state in
    // src/operations/sticky-message/handler.ts doesn't conflate bots
    // (its stickyPostIds Map is keyed by platformId).
    const { bot: poolBot, index: poolIndex } = nextMattermostBot(testConfig);
    platformId = `test-mattermost-${poolIndex}`;
    const allowedUsers = allowedUsersOverride ?? [
      ...testConfig.mattermost.testUsers.map(u => u.username),
      ...extraAllowedUsers,
    ];

    const platformConfig = {
      id: platformId,
      type: 'mattermost' as const,
      displayName: 'Test Mattermost',
      url: testConfig.mattermost.url,
      token: poolBot.token!,
      channelId: testConfig.mattermost.channel.id!,
      botName: poolBot.username,
      allowedUsers,
      skipPermissions,
    };

    platformClient = new MattermostClient(platformConfig);
    botUsername = poolBot.username;
    botUserId = poolBot.userId!;
  }

  // Create the session manager (no UI, no chrome for tests)
  // Pass explicit sessionsPath for test isolation
  const sessionManager = new SessionManager(
    workingDir,
    skipPermissions,
    false, // chrome disabled
    worktreeMode,
    sessionsPath, // isolated session storage
  );

  // Register platform (this wires up reaction handlers)
  sessionManager.addPlatform(platformId, platformClient);

  // Wire up message handler - uses the actual bot logic from src/message-handler.ts
  platformClient.on('message', async (post: PlatformPost, user: PlatformUser | null) => {
    await handleMessage(platformClient, sessionManager, post, user, {
      platformId,
      logger: debug ? {
        error: (msg) => console.error('[test-bot]', msg),
      } : undefined,
      onKill: async () => {
        // In tests, just disconnect without exiting the process
        await sessionManager.killAllSessions();
        await platformClient.disconnect();
        // Note: Don't delete CLAUDE_PATH/CLAUDE_SCENARIO here - can cause race conditions
      },
    });
  });

  // Connect to platform. Wrap to surface the actual error — MattermostClient's
  // connect() rejects with the raw WebSocket error event, which serializes as
  // "[object Event]" in test failure output, making CI flakes impossible to
  // diagnose from logs alone.
  try {
    await platformClient.connect();
  } catch (err) {
    const detail = err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null
        ? JSON.stringify({ type: (err as { type?: string }).type, code: (err as { code?: number }).code, message: (err as { message?: string }).message })
        : String(err);
    throw new Error(`[test-bot] platformClient.connect() failed: ${detail}`, { cause: err });
  }

  // Initialize session manager (loads persisted sessions)
  await sessionManager.initialize();

  if (debug) {
    console.log('[test-bot] Started with scenario:', scenario, 'platform:', platform);
  }

  // For backward compatibility, cast to MattermostClient when platform is mattermost
  const mattermostClient = platform === 'mattermost'
    ? platformClient as MattermostClient
    : platformClient as unknown as MattermostClient; // Type assertion for deprecated field

  return {
    sessionManager,
    mattermostClient, // Deprecated but kept for backward compatibility
    platformClient,
    platformId,
    sessionsPath,
    botUsername,
    botUserId,
    async stop() {
      if (debug) {
        console.log('[test-bot] Stopping...');
      }
      // Kill all sessions, then await full WebSocket close before returning.
      // disconnect() now resolves when the close handshake completes (or
      // hits its 1s safety timeout) AND removes EventEmitter listeners.
      await sessionManager.killAllSessions();
      await platformClient.disconnect();
      // Server-side propagation delay: even after our socket closes, the
      // Mattermost server can take ~hundreds of ms to process the close
      // and stop sending events to that connection. Without this wait,
      // back-to-back tests see two bot tokens with TWO active server-
      // side connections during the transition window — visible in CI
      // as duplicate session starts (two pids per @mention). 500ms is
      // empirically sufficient.
      await new Promise((r) => setTimeout(r, 500));
      // Note: Don't delete CLAUDE_PATH/CLAUDE_SCENARIO here - the next test will
      // set them anyway, and deleting them can cause race conditions with async
      // operations that are still running.
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
      await platformClient.disconnect();
      await new Promise((r) => setTimeout(r, 500));
      // Note: Keep all env vars - CLAUDE_PATH/CLAUDE_SCENARIO will be set by next test,
      // and CLAUDE_THREADS_SESSIONS_PATH needs to persist for session resume testing
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
