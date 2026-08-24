/**
 * Plugin command handler
 *
 * Manages Claude Code plugins via subprocess execution.
 * Handles install, uninstall, and list operations.
 */

import { getClaudePath } from '../../claude/version-check.js';
import { crossSpawn } from '../../utils/spawn.js';
import { auditLog } from '../../persistence/audit-log.js';
import type { Session } from '../../session/types.js';
import type { SessionContext } from '../session-context/index.js';
import type { ClaudeCliOptions } from '../../claude/cli.js';
import { effectivePermissionMode } from '../../config/index.js';
import { resolveSessionMemory, activeWorktreeRepoRoot } from '../../memory/store.js';
import { buildRestartCliOptions } from '../../claude/restart-options.js';
import { buildAppendSystemPrompt } from '../../commands/system-prompt-generator.js';
import { CHAT_PLATFORM_PROMPT } from '../../session/lifecycle.js';
import { post, postError } from '../post-helpers/index.js';
import { restartClaudeSession } from '../commands/index.js';
import { createLogger } from '../../utils/logger.js';
import { createSessionLog } from '../../utils/session-log.js';

const log = createLogger('plugin');
const sessionLog = createSessionLog(log);

/**
 * CLI options for the post-(un)install respawn. Built on
 * `buildRestartCliOptions` so the cross-cutting fields every restart site
 * must thread (uploadDir/outboundFiles for send_file, the session's pooled
 * account, the decision-bridge socket, sessionOwnerUsername) can't silently
 * drop — resuming under the wrong account HOME fails with "No conversation
 * found", and a missing uploadDir breaks send_file.
 *
 * Only resume when Claude has actually responded — an early restart (e.g.
 * plugin install before the first turn) has no conversation to resume and
 * Claude CLI rejects `--resume <uuid>` with "No conversation found".
 */
async function buildPluginRestartCliOptions(
  session: Session,
  ctx: SessionContext,
): Promise<ClaudeCliOptions> {
  const account = session.claudeAccountId
    ? ctx.ops.getClaudeAccount(session.claudeAccountId)
    : undefined;
  const memoryConfig = ctx.ops.getPlatformMemoryConfig(session.platformId);
  return {
    ...buildRestartCliOptions(session, {
      chromeEnabled: ctx.config.chromeEnabled,
      permissionTimeoutMs: ctx.config.permissionTimeoutMs,
      account: account ? { id: account.id, home: account.home, apiKey: account.apiKey } : undefined,
      ops: ctx.ops,
    }),
    workingDir: session.workingDir,
    permissionMode: effectivePermissionMode({
      override: session.permissionModeOverride,
      sessionHasInteractiveOverride: session.forceInteractivePermissions,
      botWideMode: ctx.config.permissionMode,
    }),
    sessionId: session.claudeSessionId,
    resume: session.lifecycle.hasClaudeResponded,
    // Rebuild the append-system-prompt: `--append-system-prompt` is
    // per-invocation and NOT re-applied by `--resume`, so without this the
    // respawned Claude would lose the platform context, command list,
    // co-author rules, attribution note, and channel memory. Mirrors the
    // !cd / !permissions restart paths.
    appendSystemPrompt: await buildAppendSystemPrompt(
      session.platform,
      session.platformId,
      session.workingDir,
      session.threadId,
      session.startedBy,
      session.sessionAllowedUsers,
      CHAT_PLATFORM_PROMPT,
      ctx.state.githubEmailsStore,
      memoryConfig.enabled && memoryConfig.channelLayer ? ctx.state.memoryStore : null,
      { userAttribution: session.userAttribution },
    ),
    memory: await resolveSessionMemory(
      ctx.state.memoryStore,
      memoryConfig,
      session.platformId,
      session.workingDir,
      activeWorktreeRepoRoot(session.workingDir, session.worktreeInfo),
    ),
  };
}

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
    const claudePath = getClaudePath(); // same PATH-fallback resolution as cli.ts
    const proc = crossSpawn(claudePath, ['plugin', ...args], {
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
  auditLog(session.platformId, {
    threadId: session.threadId,
    sessionId: session.sessionId,
    actor: username,
    kind: 'command',
    tool: 'plugin install',
    detail: pluginName,
  });
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

  const cliOptions = await buildPluginRestartCliOptions(session, ctx);

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
  auditLog(session.platformId, {
    threadId: session.threadId,
    sessionId: session.sessionId,
    actor: username,
    kind: 'command',
    tool: 'plugin uninstall',
    detail: pluginName,
  });
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

  const cliOptions = await buildPluginRestartCliOptions(session, ctx);

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
