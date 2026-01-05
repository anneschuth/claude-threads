#!/usr/bin/env bun

import { program } from 'commander';
import {
  loadConfigWithMigration,
  configExists as checkConfigExists,
  type MattermostPlatformConfig,
  type SlackPlatformConfig,
  type PlatformInstanceConfig,
} from './config/migration.js';
import type { CliArgs } from './config.js';
import { runOnboarding } from './onboarding.js';
import { MattermostClient, SlackClient, type PlatformClient, type PlatformPost, type PlatformUser } from './platform/index.js';
import { SessionManager } from './session/index.js';
import { checkForUpdates } from './update-notifier.js';
import { VERSION } from './version.js';
import { keepAlive } from './utils/keep-alive.js';
import { dim, red } from './utils/colors.js';
import { validateClaudeCli } from './claude/version-check.js';
import { startUI, type UIInstance } from './ui/index.js';
import { setLogHandler } from './utils/logger.js';
import { setSessionLogHandler } from './utils/format.js';
import { handleMessage } from './message-handler.js';

// =============================================================================
// Platform Factory and Event Wiring
// =============================================================================

/**
 * Create a platform client based on the config type.
 */
function createPlatformClient(config: PlatformInstanceConfig): PlatformClient {
  switch (config.type) {
    case 'mattermost':
      return new MattermostClient(config as MattermostPlatformConfig);
    case 'slack':
      return new SlackClient(config as SlackPlatformConfig);
    default:
      throw new Error(`Unsupported platform type: ${(config as PlatformInstanceConfig).type}`);
  }
}

/**
 * Wire up platform events to session manager and UI.
 */
function wirePlatformEvents(
  platformId: string,
  client: PlatformClient,
  session: SessionManager,
  ui: UIInstance
): void {
  // Handle incoming messages
  client.on('message', async (post: PlatformPost, user: PlatformUser | null) => {
    await handleMessage(client, session, post, user, {
      platformId,
      logger: {
        error: (msg) => ui.addLog({ level: 'error', component: '❌', message: msg }),
      },
      onKill: (username) => {
        ui.addLog({ level: 'error', component: '🔴', message: `EMERGENCY SHUTDOWN initiated by @${username}` });
        process.exit(1);
      },
    });
  });

  // Wire up connection status events to UI
  client.on('connected', () => {
    ui.setPlatformStatus(platformId, { connected: true, reconnecting: false, reconnectAttempts: 0 });
  });
  client.on('disconnected', () => {
    ui.setPlatformStatus(platformId, { connected: false, reconnecting: true });
  });
  client.on('reconnecting', (attempt: number) => {
    ui.setPlatformStatus(platformId, { reconnecting: true, reconnectAttempts: attempt });
  });
  client.on('error', (e) => {
    ui.addLog({ level: 'error', component: platformId, message: String(e) });
  });
}

// =============================================================================
// CLI Options
// =============================================================================

// Define CLI options
program
  .name('claude-threads')
  .version(VERSION)
  .description('Share Claude Code sessions in Mattermost')
  .option('--url <url>', 'Mattermost server URL')
  .option('--token <token>', 'Mattermost bot token')
  .option('--channel <id>', 'Mattermost channel ID')
  .option('--bot-name <name>', 'Bot mention name (default: claude-code)')
  .option('--allowed-users <users>', 'Comma-separated allowed usernames')
  .option('--skip-permissions', 'Skip interactive permission prompts')
  .option('--no-skip-permissions', 'Enable interactive permission prompts (override env)')
  .option('--chrome', 'Enable Claude in Chrome integration')
  .option('--no-chrome', 'Disable Claude in Chrome integration')
  .option('--worktree-mode <mode>', 'Git worktree mode: off, prompt, require (default: prompt)')
  .option('--keep-alive', 'Enable system sleep prevention (default: enabled)')
  .option('--no-keep-alive', 'Disable system sleep prevention')
  .option('--setup', 'Run interactive setup wizard (reconfigure existing settings)')
  .option('--debug', 'Enable debug logging')
  .option('--skip-version-check', 'Skip Claude CLI version compatibility check')
  .parse();

const opts = program.opts();

// Check if required args are provided via CLI
function hasRequiredCliArgs(args: typeof opts): boolean {
  return !!(args.url && args.token && args.channel);
}

async function main() {
  // Check for updates (non-blocking, shows notification if available)
  checkForUpdates();

  // Set debug mode from CLI flag
  if (opts.debug) {
    process.env.DEBUG = '1';
  }

  // Build CLI args object
  const cliArgs: CliArgs = {
    url: opts.url,
    token: opts.token,
    channel: opts.channel,
    botName: opts.botName,
    allowedUsers: opts.allowedUsers,
    skipPermissions: opts.skipPermissions,
    chrome: opts.chrome,
    worktreeMode: opts.worktreeMode,
    keepAlive: opts.keepAlive,
  };

  // Check if we need onboarding
  if (opts.setup) {
    await runOnboarding(true); // reconfigure mode
  } else if (!checkConfigExists() && !hasRequiredCliArgs(opts)) {
    await runOnboarding(false); // first-time mode
  }

  const workingDir = process.cwd();
  const newConfig = loadConfigWithMigration();

  if (!newConfig) {
    throw new Error('No configuration found. Run with --setup to configure.');
  }

  // CLI args can override global settings
  if (cliArgs.chrome !== undefined) {
    newConfig.chrome = cliArgs.chrome;
  }
  if (cliArgs.worktreeMode !== undefined) {
    newConfig.worktreeMode = cliArgs.worktreeMode;
  }
  if (cliArgs.keepAlive !== undefined) {
    newConfig.keepAlive = cliArgs.keepAlive;
  }

  // Determine keep-alive setting (actual setup happens after UI is ready)
  const keepAliveEnabled = newConfig.keepAlive !== false;

  // Validate we have at least one platform configured
  if (!newConfig.platforms || newConfig.platforms.length === 0) {
    throw new Error('No platforms configured. Run with --setup to configure.');
  }

  const config = newConfig;

  // Get the first platform's skipPermissions setting as the default
  // (for backwards compatibility with single-platform setups)
  const firstPlatformConfig = config.platforms[0] as MattermostPlatformConfig | SlackPlatformConfig;
  const initialSkipPermissions = firstPlatformConfig.skipPermissions ?? false;

  // Check Claude CLI version
  const claudeValidation = validateClaudeCli();

  // Fail on incompatible version unless --skip-version-check is set
  if (!claudeValidation.compatible && !opts.skipVersionCheck) {
    console.error(red(`  ❌ ${claudeValidation.message}`));
    console.error('');
    console.error(dim(`  Use --skip-version-check to bypass this check (not recommended)`));
    console.error('');
    process.exit(1);
  }

  // Mutable reference for shutdown - set after all components initialized
  let triggerShutdown: (() => void) | null = null;

  // Mutable runtime config (can be changed via keyboard toggles)
  // These affect new sessions and sticky message display
  const runtimeConfig = {
    skipPermissions: initialSkipPermissions,
    chromeEnabled: config.chrome ?? false,
    keepAliveEnabled,
  };

  // Session manager reference (set after UI is ready)
  let sessionManager: SessionManager | null = null;

  // Start the Ink UI
  const ui: UIInstance = await startUI({
    config: {
      version: VERSION,
      workingDir,
      claudeVersion: claudeValidation.version || 'unknown',
      claudeCompatible: claudeValidation.compatible,
      skipPermissions: runtimeConfig.skipPermissions,
      chromeEnabled: runtimeConfig.chromeEnabled,
      keepAliveEnabled: runtimeConfig.keepAliveEnabled,
    },
    onQuit: () => {
      if (triggerShutdown) triggerShutdown();
    },
    toggleCallbacks: {
      onDebugToggle: (enabled) => {
        // process.env.DEBUG is already updated in App.tsx
        ui.addLog({ level: 'info', component: 'toggle', message: `Debug mode ${enabled ? 'enabled' : 'disabled'}` });
        // Trigger sticky message update to reflect debug state
        sessionManager?.updateAllStickyMessages();
      },
      onPermissionsToggle: (skipPermissions) => {
        runtimeConfig.skipPermissions = skipPermissions;
        // Update ALL platform configs so new sessions use this setting
        for (const platformConfig of config.platforms) {
          (platformConfig as MattermostPlatformConfig | SlackPlatformConfig).skipPermissions = skipPermissions;
        }
        // Update SessionManager's internal state for sticky message
        sessionManager?.setSkipPermissions(skipPermissions);
        ui.addLog({ level: 'info', component: 'toggle', message: `Permissions ${skipPermissions ? 'auto (skip prompts)' : 'interactive'}` });
        sessionManager?.updateAllStickyMessages();
      },
      onChromeToggle: (enabled) => {
        runtimeConfig.chromeEnabled = enabled;
        config.chrome = enabled;
        // Update SessionManager's internal state for sticky message
        sessionManager?.setChromeEnabled(enabled);
        ui.addLog({ level: 'info', component: 'toggle', message: `Chrome integration ${enabled ? 'enabled' : 'disabled'} for new sessions` });
        sessionManager?.updateAllStickyMessages();
      },
      onKeepAliveToggle: (enabled) => {
        runtimeConfig.keepAliveEnabled = enabled;
        keepAlive.setEnabled(enabled);
        ui.addLog({ level: 'info', component: 'toggle', message: `Keep-alive ${enabled ? 'enabled' : 'disabled'}` });
        sessionManager?.updateAllStickyMessages();
      },
    },
  });

  // Route all logger output through the UI
  setLogHandler((level, component, message, sessionId) => {
    ui.addLog({ level, component, message, sessionId });
  });

  // Route session-specific logs through the UI
  // Session ID allows routing to the correct session panel
  setSessionLogHandler((level, message, sessionId) => {
    ui.addLog({ level, component: 'session', message, sessionId });
  });

  // Now that output handler is set, enable keep-alive (will route logs through UI)
  keepAlive.setEnabled(keepAliveEnabled);

  // Create session manager (shared across all platforms)
  const session = new SessionManager(workingDir, initialSkipPermissions, config.chrome, config.worktreeMode);

  // Set reference for toggle callbacks
  sessionManager = session;

  // Wire up session events to UI (shared across all platforms)
  session.on('session:add', (info) => {
    ui.addSession(info);
  });
  session.on('session:update', (sessionId, updates) => {
    ui.updateSession(sessionId, updates);
  });
  session.on('session:remove', (sessionId) => {
    ui.removeSession(sessionId);
  });

  // Store all platform clients for shutdown
  const platforms = new Map<string, PlatformClient>();

  // Initialize all configured platforms
  for (const platformConfig of config.platforms) {
    const typedConfig = platformConfig as MattermostPlatformConfig | SlackPlatformConfig;

    // Register platform with UI
    ui.setPlatformStatus(platformConfig.id, {
      displayName: platformConfig.displayName || platformConfig.id,
      botName: typedConfig.botName,
      url: typedConfig.type === 'mattermost' ? (typedConfig as MattermostPlatformConfig).url : 'slack.com',
    });

    // Create platform client using factory
    const client = createPlatformClient(platformConfig);
    platforms.set(platformConfig.id, client);

    // Register with session manager
    session.addPlatform(platformConfig.id, client);

    // Wire up platform events
    wirePlatformEvents(platformConfig.id, client, session, ui);
  }

  // Connect all platforms
  await Promise.all(
    Array.from(platforms.values()).map((client) => client.connect())
  );

  // Resume any persisted sessions from before restart
  await session.initialize();

  // Mark UI as ready
  ui.setReady();

  let isShuttingDown = false;
  const shutdown = async (_signal: string) => {
    // Guard against multiple shutdown calls (SIGINT + SIGTERM)
    if (isShuttingDown) return;
    isShuttingDown = true;

    // Update status bar to show shutdown in progress
    ui.setShuttingDown();

    // Give React a moment to render the shutdown state
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Set shutdown flag FIRST to prevent race conditions with exit events
    session.setShuttingDown();

    // Post shutdown message to active sessions (updates existing timeout posts or creates new ones)
    const activeCount = session.getActiveThreadIds().length;
    if (activeCount > 0) {
      ui.addLog({ level: 'info', component: '📤', message: `Notifying ${activeCount} active session(s)...` });
      await session.postShutdownMessages();
    }

    await session.killAllSessions();

    // Disconnect all platforms
    for (const client of platforms.values()) {
      client.disconnect();
    }
    // Don't call process.exit() here - let the signal handler do it after we resolve
  };

  // Wire up the Ctrl+C handler from UI to shutdown
  triggerShutdown = () => {
    shutdown('Ctrl+C').finally(() => process.exit(0));
  };

  // Remove any existing signal handlers (e.g., from 'when-exit' package)
  // and register our own to ensure graceful shutdown
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');

  process.on('SIGINT', () => {
    shutdown('SIGINT').finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM').finally(() => process.exit(0));
  });
}

main().catch(e => { console.error(e); process.exit(1); });
