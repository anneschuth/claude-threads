/**
 * Plugin command handler
 *
 * Manages Claude Code plugins via subprocess execution.
 * Handles install, uninstall, and list operations.
 */

import { spawn } from 'child_process';
import type { Session } from '../../session/types.js';
import type { SessionContext } from '../session-context/index.js';
import type { ClaudeCliOptions } from '../../claude/cli.js';
import { post, postError } from '../post-helpers/index.js';
import { restartClaudeSession } from '../commands/index.js';
import { createLogger } from '../../utils/logger.js';
import { createSessionLog } from '../../utils/session-log.js';

const log = createLogger('plugin');
const sessionLog = createSessionLog(log);

// ---------------------------------------------------------------------------
// Subprocess execution
// ---------------------------------------------------------------------------

interface PluginResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a `claude plugin` subcommand as a subprocess.
 */
async function runPluginCommand(
  args: string[],
  cwd: string,
  timeout = 60000
): Promise<PluginResult> {
  return new Promise((resolve) => {
    const claudePath = process.env.CLAUDE_PATH || 'claude';
    const proc = spawn(claudePath, ['plugin', ...args], {
      cwd,
      timeout,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    proc.on('error', (err) => {
      resolve({ stdout, stderr, exitCode: 1 });
      log.error(`Plugin command error: ${err.message}`);
    });
  });
}

// ---------------------------------------------------------------------------
// Plugin operations
// ---------------------------------------------------------------------------

/**
 * List installed plugins.
 */
export async function handlePluginList(session: Session): Promise<void> {
  const formatter = session.platform.getFormatter();

  await post(session, 'info', `📦 Listing installed plugins...`);

  const result = await runPluginCommand(['list'], session.workingDir);

  if (result.exitCode !== 0) {
    await postError(session, `Failed to list plugins:\n${formatter.formatCodeBlock(result.stderr || result.stdout, 'text')}`);
    return;
  }

  const output = result.stdout.trim() || 'No plugins installed';
  await post(session, 'info', `${formatter.formatBold('Installed plugins:')}\n${formatter.formatCodeBlock(output, 'text')}`);

  sessionLog(session).info(`Listed plugins: ${output.substring(0, 100)}...`);
}

/**
 * Install a plugin and restart Claude to load it.
 */
export async function handlePluginInstall(
  session: Session,
  pluginName: string,
  username: string,
  ctx: SessionContext
): Promise<void> {
  const formatter = session.platform.getFormatter();

  await post(session, 'info', `📦 Installing plugin: ${formatter.formatCode(pluginName)}...`);
  sessionLog(session).info(`Installing plugin: ${pluginName} (requested by @${username})`);
  session.threadLogger?.logCommand('plugin install', pluginName, username);

  const result = await runPluginCommand(['install', pluginName], session.workingDir);

  if (result.exitCode !== 0) {
    const errorMsg = result.stderr || result.stdout || 'Unknown error';
    await postError(session, `Failed to install plugin ${formatter.formatCode(pluginName)}:\n${formatter.formatCodeBlock(errorMsg, 'text')}`);
    sessionLog(session).error(`Failed to install plugin ${pluginName}: ${errorMsg}`);
    return;
  }

  await post(
    session,
    'success',
    `✅ Plugin installed: ${formatter.formatCode(pluginName)}\n🔄 Restarting Claude to load plugin...`
  );

  // Build CLI options from session state (can't access private session.claude.options)
  const cliOptions: ClaudeCliOptions = {
    workingDir: session.workingDir,
    threadId: session.threadId,
    skipPermissions: ctx.config.skipPermissions || !session.forceInteractivePermissions,
    sessionId: session.claudeSessionId,
    resume: true, // Resume to keep conversation context
    chrome: ctx.config.chromeEnabled,
    platformConfig: session.platform.getMcpConfig(),
    logSessionId: session.sessionId,
    permissionTimeoutMs: ctx.config.permissionTimeoutMs,
  };

  // Restart Claude CLI to pick up the new plugin
  const success = await restartClaudeSession(
    session,
    cliOptions,
    ctx,
    `Plugin installation: ${pluginName}`
  );

  if (success) {
    sessionLog(session).info(`Claude restarted after installing plugin: ${pluginName}`);
  } else {
    await postError(session, `Plugin installed but failed to restart Claude. Try ${formatter.formatCode('!cd .')} to manually restart.`);
  }
}

/**
 * Uninstall a plugin and restart Claude.
 */
export async function handlePluginUninstall(
  session: Session,
  pluginName: string,
  username: string,
  ctx: SessionContext
): Promise<void> {
  const formatter = session.platform.getFormatter();

  await post(session, 'info', `🗑️ Uninstalling plugin: ${formatter.formatCode(pluginName)}...`);
  sessionLog(session).info(`Uninstalling plugin: ${pluginName} (requested by @${username})`);
  session.threadLogger?.logCommand('plugin uninstall', pluginName, username);

  const result = await runPluginCommand(['uninstall', pluginName], session.workingDir);

  if (result.exitCode !== 0) {
    const errorMsg = result.stderr || result.stdout || 'Unknown error';
    await postError(session, `Failed to uninstall plugin ${formatter.formatCode(pluginName)}:\n${formatter.formatCodeBlock(errorMsg, 'text')}`);
    sessionLog(session).error(`Failed to uninstall plugin ${pluginName}: ${errorMsg}`);
    return;
  }

  await post(
    session,
    'success',
    `✅ Plugin uninstalled: ${formatter.formatCode(pluginName)}\n🔄 Restarting Claude...`
  );

  // Build CLI options from session state (can't access private session.claude.options)
  const cliOptions: ClaudeCliOptions = {
    workingDir: session.workingDir,
    threadId: session.threadId,
    skipPermissions: ctx.config.skipPermissions || !session.forceInteractivePermissions,
    sessionId: session.claudeSessionId,
    resume: true, // Resume to keep conversation context
    chrome: ctx.config.chromeEnabled,
    platformConfig: session.platform.getMcpConfig(),
    logSessionId: session.sessionId,
    permissionTimeoutMs: ctx.config.permissionTimeoutMs,
  };

  // Restart Claude CLI to unload the plugin
  const success = await restartClaudeSession(
    session,
    cliOptions,
    ctx,
    `Plugin uninstallation: ${pluginName}`
  );

  if (success) {
    sessionLog(session).info(`Claude restarted after uninstalling plugin: ${pluginName}`);
  } else {
    await postError(session, `Plugin uninstalled but failed to restart Claude. Try ${formatter.formatCode('!cd .')} to manually restart.`);
  }
}
