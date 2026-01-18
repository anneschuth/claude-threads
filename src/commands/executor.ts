/**
 * Command Executor
 *
 * Unified command execution for both root messages and in-session messages.
 * This is the single place where all commands are handled.
 */

import { COMMAND_REGISTRY } from './registry.js';
import type {
  CommandExecutorContext,
  CommandHandler,
  CommandHandlerMap,
  CommandResult,
} from './types.js';
import { generateHelpMessage } from './help-generator.js';
import { getReleaseNotes, formatReleaseNotes } from '../changelog.js';
import { VERSION } from '../version.js';

// =============================================================================
// Command Handler Registry
// =============================================================================

const handlers: CommandHandlerMap = new Map();

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get command definition from registry.
 */
function getCommandDef(command: string) {
  return COMMAND_REGISTRY.find((c) => c.command === command);
}

/**
 * Get subcommand definition from a command.
 */
function getSubcommandDef(command: string, subcommand: string) {
  const cmdDef = getCommandDef(command);
  return cmdDef?.subcommands?.find((s) => s.name === subcommand);
}

// =============================================================================
// Command Handlers
// =============================================================================

/**
 * Handle !help command.
 */
const handleHelp: CommandHandler = async (ctx) => {
  const helpMessage = generateHelpMessage(ctx.formatter);
  await ctx.client.createPost(helpMessage, ctx.threadId);
  return { handled: true };
};

/**
 * Handle !release-notes command.
 */
const handleReleaseNotes: CommandHandler = async (ctx) => {
  const notes = getReleaseNotes(VERSION);
  if (notes) {
    await ctx.client.createPost(formatReleaseNotes(notes, ctx.formatter), ctx.threadId);
  } else {
    await ctx.client.createPost(
      `📋 ${ctx.formatter.formatBold(`claude-threads v${VERSION}`)}\n\nRelease notes not available. See ${ctx.formatter.formatLink('GitHub releases', 'https://github.com/anneschuth/claude-threads/releases')}.`,
      ctx.threadId
    );
  }
  return { handled: true };
};

/**
 * Handle !update command.
 */
const handleUpdate: CommandHandler = async (ctx, args) => {
  const subcommand = args?.toLowerCase();

  if (ctx.commandContext === 'first-message') {
    // First message: just show status without starting session
    await ctx.sessionManager.showUpdateStatusWithoutSession(
      ctx.client.platformId,
      ctx.threadId
    );
    return { handled: true };
  }

  // In-session: handle subcommands
  if (subcommand === 'now') {
    await ctx.sessionManager.forceUpdateNow(ctx.threadId, ctx.username);
  } else if (subcommand === 'defer') {
    await ctx.sessionManager.deferUpdate(ctx.threadId, ctx.username);
  } else {
    await ctx.sessionManager.showUpdateStatus(ctx.threadId, ctx.username);
  }
  return { handled: true };
};

/**
 * Handle !stop command.
 */
const handleStop: CommandHandler = async (ctx) => {
  if (ctx.commandContext === 'first-message') {
    return { handled: false }; // !stop doesn't work in first message
  }
  if (ctx.isAllowed) {
    await ctx.sessionManager.cancelSession(ctx.threadId, ctx.username);
  }
  return { handled: true };
};

/**
 * Handle !escape command.
 */
const handleEscape: CommandHandler = async (ctx) => {
  if (ctx.commandContext === 'first-message') {
    return { handled: false }; // !escape doesn't work in first message
  }
  if (ctx.isAllowed) {
    await ctx.sessionManager.interruptSession(ctx.threadId, ctx.username);
  }
  return { handled: true };
};

/**
 * Handle !approve command.
 */
const handleApprove: CommandHandler = async (ctx) => {
  if (ctx.commandContext === 'first-message') {
    return { handled: false }; // !approve doesn't work in first message
  }
  if (ctx.isAllowed) {
    await ctx.sessionManager.approvePendingPlan(ctx.threadId, ctx.username);
  }
  return { handled: true };
};

/**
 * Handle !invite command.
 */
const handleInvite: CommandHandler = async (ctx, args) => {
  if (ctx.commandContext === 'first-message') {
    return { handled: false }; // !invite doesn't work in first message
  }
  if (args) {
    await ctx.sessionManager.inviteUser(ctx.threadId, args, ctx.username);
  }
  return { handled: true };
};

/**
 * Handle !kick command.
 */
const handleKick: CommandHandler = async (ctx, args) => {
  if (ctx.commandContext === 'first-message') {
    return { handled: false }; // !kick doesn't work in first message
  }
  if (args) {
    await ctx.sessionManager.kickUser(ctx.threadId, args, ctx.username);
  }
  return { handled: true };
};

/**
 * Handle !cd command.
 */
const handleCd: CommandHandler = async (ctx, args) => {
  if (!args) {
    return { handled: false };
  }

  if (ctx.commandContext === 'first-message') {
    // First message: store in session options for later
    return {
      sessionOptions: { workingDir: args },
      continueProcessing: true,
    };
  }

  // In-session: change directory immediately
  await ctx.sessionManager.changeDirectory(ctx.threadId, args, ctx.username);
  return { handled: true };
};

/**
 * Handle !permissions command.
 */
const handlePermissions: CommandHandler = async (ctx, args) => {
  const mode = args?.toLowerCase();

  if (ctx.commandContext === 'first-message') {
    if (mode === 'interactive') {
      return {
        sessionOptions: { forceInteractivePermissions: true },
        continueProcessing: true,
      };
    }
    return { handled: false };
  }

  // In-session: toggle permissions
  if (mode === 'interactive') {
    await ctx.sessionManager.enableInteractivePermissions(ctx.threadId, ctx.username);
  } else {
    await ctx.client.createPost(
      `⚠️ Cannot upgrade to auto permissions - can only downgrade to interactive`,
      ctx.threadId
    );
  }
  return { handled: true };
};

/**
 * Handle !worktree command (unified handling for subcommands and branch creation).
 */
const handleWorktree: CommandHandler = async (ctx, args) => {
  const parts = args?.split(/\s+/) || [];
  const subcommandOrBranch = parts[0]?.toLowerCase();
  const subArgs = parts.slice(1).join(' ');
  const originalFirstArg = parts[0]; // Keep original case for branch names

  // Check if this is a known subcommand
  const subDef = getSubcommandDef('worktree', subcommandOrBranch);

  if (subDef) {
    // Check if subcommand works in current context
    if (ctx.commandContext === 'first-message' && !subDef.worksInFirstMessage) {
      return { handled: false };
    }

    // Handle known subcommands
    switch (subcommandOrBranch) {
      case 'list':
        // In first-message context, use session-less version
        if (ctx.commandContext === 'first-message') {
          await ctx.sessionManager.listWorktreesWithoutSession(ctx.client.platformId, ctx.threadId);
        } else {
          await ctx.sessionManager.listWorktreesCommand(ctx.threadId, ctx.username);
        }
        return { handled: true };

      case 'switch':
        if (!subArgs) {
          await ctx.client.createPost(
            `❌ Usage: ${ctx.formatter.formatCode('!worktree switch <branch>')}`,
            ctx.threadId
          );
          return { handled: true };
        }
        await ctx.sessionManager.switchToWorktree(ctx.threadId, subArgs, ctx.username);
        return { handled: true };

      case 'remove':
        if (!subArgs) {
          await ctx.client.createPost(
            `❌ Usage: ${ctx.formatter.formatCode('!worktree remove <branch>')}`,
            ctx.threadId
          );
          return { handled: true };
        }
        await ctx.sessionManager.removeWorktreeCommand(ctx.threadId, subArgs, ctx.username);
        return { handled: true };

      case 'cleanup':
        await ctx.sessionManager.cleanupWorktreeCommand(ctx.threadId, ctx.username);
        return { handled: true };

      case 'off':
        await ctx.sessionManager.disableWorktreePrompt(ctx.threadId, ctx.username);
        return { handled: true };
    }
  }

  // Not a subcommand - treat as branch name
  if (originalFirstArg) {
    if (ctx.commandContext === 'first-message') {
      // First message: return branch name for session creation
      return {
        worktreeBranch: originalFirstArg,
        continueProcessing: true,
        remainingText: subArgs || undefined,
      };
    }

    // In-session: create worktree immediately
    await ctx.sessionManager.createAndSwitchToWorktree(ctx.threadId, originalFirstArg, ctx.username);
    return { handled: true };
  }

  return { handled: false };
};

/**
 * Handle !bug command.
 */
const handleBug: CommandHandler = async (ctx, args) => {
  if (ctx.commandContext === 'first-message') {
    return { handled: false }; // !bug doesn't work in first message
  }
  if (ctx.isAllowed) {
    await ctx.sessionManager.reportBug(ctx.threadId, args, ctx.username, ctx.files);
  }
  return { handled: true };
};

/**
 * Handle !plugin command.
 */
const handlePlugin: CommandHandler = async (ctx, args) => {
  if (ctx.commandContext === 'first-message') {
    return { handled: false }; // !plugin doesn't work in first message
  }
  if (!ctx.isAllowed) {
    return { handled: true };
  }

  const parts = args?.split(/\s+/) || [];
  const subcommand = parts[0]?.toLowerCase() || 'list';
  const pluginName = parts.slice(1).join(' ');

  switch (subcommand) {
    case 'list':
      await ctx.sessionManager.pluginList(ctx.threadId);
      break;
    case 'install':
      if (!pluginName) {
        await ctx.client.createPost(
          `❌ Usage: ${ctx.formatter.formatCode('!plugin install <plugin-name>')}`,
          ctx.threadId
        );
      } else {
        await ctx.sessionManager.pluginInstall(ctx.threadId, pluginName, ctx.username);
      }
      break;
    case 'uninstall':
      if (!pluginName) {
        await ctx.client.createPost(
          `❌ Usage: ${ctx.formatter.formatCode('!plugin uninstall <plugin-name>')}`,
          ctx.threadId
        );
      } else {
        await ctx.sessionManager.pluginUninstall(ctx.threadId, pluginName, ctx.username);
      }
      break;
    default:
      await ctx.client.createPost(
        `❌ Unknown subcommand: ${ctx.formatter.formatCode(subcommand)}. Use ${ctx.formatter.formatCode('list')}, ${ctx.formatter.formatCode('install')}, or ${ctx.formatter.formatCode('uninstall')}.`,
        ctx.threadId
      );
  }
  return { handled: true };
};

/**
 * Create a passthrough handler for Claude Code slash commands.
 */
function createPassthroughHandler(slashCommand: string): CommandHandler {
  return async (ctx) => {
    if (ctx.commandContext === 'first-message') {
      return { handled: false }; // Passthrough commands don't work in first message
    }
    if (ctx.isAllowed) {
      await ctx.sessionManager.sendFollowUp(ctx.threadId, `/${slashCommand}`);
    }
    return { handled: true };
  };
}

// =============================================================================
// Register Handlers
// =============================================================================

handlers.set('help', handleHelp);
handlers.set('release-notes', handleReleaseNotes);
handlers.set('update', handleUpdate);
handlers.set('stop', handleStop);
handlers.set('escape', handleEscape);
handlers.set('approve', handleApprove);
handlers.set('invite', handleInvite);
handlers.set('kick', handleKick);
handlers.set('cd', handleCd);
handlers.set('permissions', handlePermissions);
handlers.set('worktree', handleWorktree);
handlers.set('bug', handleBug);
handlers.set('plugin', handlePlugin);

// Passthrough commands
handlers.set('context', createPassthroughHandler('context'));
handlers.set('cost', createPassthroughHandler('cost'));
handlers.set('compact', createPassthroughHandler('compact'));

// =============================================================================
// Main Execution Function
// =============================================================================

/**
 * Execute a command in the given context.
 *
 * @param command - The command name (without !)
 * @param args - Command arguments
 * @param ctx - Execution context
 * @returns CommandResult indicating what happened
 */
export async function executeCommand(
  command: string,
  args: string | undefined,
  ctx: CommandExecutorContext
): Promise<CommandResult> {
  const cmdDef = getCommandDef(command);

  // Check if command exists
  if (!cmdDef) {
    return { handled: false };
  }

  // Check if command works in current context
  if (ctx.commandContext === 'first-message' && !cmdDef.worksInFirstMessage) {
    return { handled: false };
  }

  // Get the handler
  const handler = handlers.get(command);
  if (!handler) {
    return { handled: false };
  }

  // Execute the handler
  return handler(ctx, args);
}

/**
 * Check if a command is a dynamic slash command (passthrough to Claude Code).
 * These are commands like !review that come from Claude Code's init event.
 */
export function isDynamicSlashCommand(
  command: string,
  availableSlashCommands?: Set<string>
): boolean {
  // Check if it's a known command first
  if (handlers.has(command)) {
    return false;
  }
  // Check if it's in the available slash commands from Claude Code
  return availableSlashCommands?.has(command) ?? false;
}

/**
 * Handle a dynamic slash command by passing it through to Claude Code.
 */
export async function handleDynamicSlashCommand(
  command: string,
  args: string | undefined,
  ctx: CommandExecutorContext
): Promise<CommandResult> {
  if (ctx.commandContext === 'first-message') {
    return { handled: false };
  }
  if (ctx.isAllowed) {
    const fullCommand = args ? `/${command} ${args}` : `/${command}`;
    await ctx.sessionManager.sendFollowUp(ctx.threadId, fullCommand);
  }
  return { handled: true };
}
