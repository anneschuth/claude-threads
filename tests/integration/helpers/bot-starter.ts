/**
 * Headless bot starter for integration tests
 *
 * Creates a claude-threads bot without the Ink UI, allowing us to test
 * the full session lifecycle in a non-TTY environment.
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { MattermostClient } from '../../../src/platform/mattermost/client.js';
import { SessionManager } from '../../../src/session/index.js';
import type { PlatformPost, PlatformUser } from '../../../src/platform/types.js';
import { loadConfig } from '../setup/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface TestBot {
  sessionManager: SessionManager;
  mattermostClient: MattermostClient;
  platformId: string;
  stop(): Promise<void>;
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
  } = options;

  // Load test config
  const testConfig = loadConfig();

  // Ensure working directory exists (spawn fails with ENOENT if cwd doesn't exist)
  mkdirSync(workingDir, { recursive: true });

  // Set environment variables for mock Claude CLI
  // Use the wrapper script since spawn() can't handle "bun runner.ts" as a single command
  const mockClaudePath = join(__dirname, '../fixtures/mock-claude/mock-claude');
  process.env.CLAUDE_PATH = mockClaudePath;
  process.env.CLAUDE_SCENARIO = scenario;
  if (debug) {
    process.env.DEBUG = '1';
  }

  // Build platform config
  const platformId = 'test-mattermost';
  const allowedUsers = [
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

  // Wire up message handler (simplified version of index.ts logic)
  mattermostClient.on('message', async (post: PlatformPost, user: PlatformUser | null) => {
    try {
      await handleTestBotMessage(mattermostClient, sessionManager, platformId, post, user);
    } catch (err) {
      if (debug) {
        console.error('[test-bot] Error handling message:', err);
      }
      // Try to notify user if possible
      try {
        const threadRoot = post.rootId || post.id;
        await mattermostClient.createPost(`⚠️ Test bot error: ${err}`, threadRoot);
      } catch {
        // Ignore if we can't post the error
      }
    }
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
      // Kill all sessions
      sessionManager.killAllSessionsAndUnpersist();
      // Disconnect from Mattermost
      mattermostClient.disconnect();
      // Clear environment
      delete process.env.CLAUDE_PATH;
      delete process.env.CLAUDE_SCENARIO;
    },
  };
}

/**
 * Simplified message handler for test bot
 *
 * Handles the core message flows without all the edge cases from index.ts.
 * This is sufficient for integration testing the main session lifecycle.
 */
async function handleTestBotMessage(
  client: MattermostClient,
  session: SessionManager,
  platformId: string,
  post: PlatformPost,
  user: PlatformUser | null,
): Promise<void> {
  const debug = process.env.DEBUG === '1';
  const username = user?.username || 'unknown';
  const message = post.message;
  const threadRoot = post.rootId || post.id;

  if (debug) {
    console.log(`[test-bot] handleMessage: user=${username}, message="${message.substring(0, 50)}...", threadRoot=${threadRoot}, isInSession=${session.isInSessionThread(threadRoot)}, hasPaused=${session.hasPausedSession(threadRoot)}, botMentioned=${client.isBotMentioned(message)}`);
  }

  // Check for !kill command (emergency shutdown)
  const lowerMessage = message.trim().toLowerCase();
  if (lowerMessage === '!kill') {
    if (!client.isUserAllowed(username)) {
      await client.createPost('⛔ Only authorized users can use `!kill`', threadRoot);
      return;
    }
    session.killAllSessionsAndUnpersist();
    client.disconnect();
    return;
  }

  // Follow-up in active thread
  if (session.isInSessionThread(threadRoot)) {
    // If message starts with @mention to someone else, ignore it
    const mentionMatch = message.trim().match(/^@([\w.-]+)/);
    if (mentionMatch && mentionMatch[1].toLowerCase() !== client.getBotName().toLowerCase()) {
      if (debug) {
        console.log(`[test-bot] Ignoring side conversation: @${mentionMatch[1]}`);
      }
      return; // Side conversation
    }

    const content = client.isBotMentioned(message)
      ? client.extractPrompt(message)
      : message.trim();
    const lowerContent = content.toLowerCase();

    // Handle commands
    if (lowerContent === '!stop' || lowerContent === '!cancel') {
      if (session.isUserAllowedInSession(threadRoot, username)) {
        await session.cancelSession(threadRoot, username);
      }
      return;
    }

    if (lowerContent === '!escape' || lowerContent === '!interrupt') {
      if (session.isUserAllowedInSession(threadRoot, username)) {
        await session.interruptSession(threadRoot, username);
      }
      return;
    }

    if (lowerContent === '!help') {
      await client.createPost(
        `**Test Bot Commands:**\n` +
        `- \`!stop\` - Stop session\n` +
        `- \`!escape\` - Interrupt session\n` +
        `- \`!invite @user\` - Invite user\n` +
        `- \`!kick @user\` - Kick user\n` +
        `- \`!kill\` - Emergency shutdown`,
        threadRoot,
      );
      return;
    }

    // Handle !invite
    const inviteMatch = content.match(/^!invite\s+@?([\w.-]+)/i);
    if (inviteMatch) {
      await session.inviteUser(threadRoot, inviteMatch[1], username);
      return;
    }

    // Handle !kick
    const kickMatch = content.match(/^!kick\s+@?([\w.-]+)/i);
    if (kickMatch) {
      await session.kickUser(threadRoot, kickMatch[1], username);
      return;
    }

    // Check if user is allowed
    if (!session.isUserAllowedInSession(threadRoot, username)) {
      if (content) {
        await session.requestMessageApproval(threadRoot, username, content);
      }
      return;
    }

    // Send follow-up to Claude
    const files = post.metadata?.files;
    if (content || files?.length) {
      await session.sendFollowUp(threadRoot, content, files);
    }
    return;
  }

  // Check for paused session
  if (session.hasPausedSession(threadRoot)) {
    const mentionMatch = message.trim().match(/^@([\w.-]+)/);
    if (mentionMatch && mentionMatch[1].toLowerCase() !== client.getBotName().toLowerCase()) {
      return; // Side conversation
    }

    const content = client.isBotMentioned(message)
      ? client.extractPrompt(message)
      : message.trim();

    const files = post.metadata?.files;
    if (content || files?.length) {
      await session.resumePausedSession(threadRoot, content, files);
    }
    return;
  }

  // New session requires @mention
  if (!client.isBotMentioned(message)) return;

  if (!client.isUserAllowed(username)) {
    await client.createPost(`⚠️ @${username} is not authorized`, threadRoot);
    return;
  }

  const prompt = client.extractPrompt(message);
  const files = post.metadata?.files;

  if (!prompt && !files?.length) {
    await client.createPost(`Mention me with your request`, threadRoot);
    return;
  }

  await session.startSession({ prompt, files }, username, threadRoot, platformId, user?.displayName);
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
