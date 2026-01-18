/**
 * Unified Command Registry
 *
 * Single source of truth for all commands and reactions.
 * This ensures the help message and system prompt stay in sync.
 */

// =============================================================================
// Types
// =============================================================================

/** Command categories for organizing help output */
export type CommandCategory =
  | 'session'      // Session control (!stop, !escape, !approve)
  | 'worktree'     // Git worktree management
  | 'collaboration' // Multi-user (!invite, !kick)
  | 'settings'     // Session settings (!permissions, !cd)
  | 'system'       // System commands (!update, !kill, !bug)
  | 'passthrough'; // Claude Code passthrough (/context, /cost)

/** Who can use this command */
export type CommandAudience =
  | 'user'         // Users type this in chat
  | 'claude'       // Claude can execute this
  | 'both';        // Both users and Claude

/** Command definition */
export interface CommandDefinition {
  /** Command name without ! prefix */
  command: string;
  /** Short description for help message */
  description: string;
  /** Optional argument placeholder (e.g., "<path>", "@user") */
  args?: string;
  /** Category for grouping in help */
  category: CommandCategory;
  /** Who can use this command */
  audience: CommandAudience;
  /** Additional notes for Claude's system prompt */
  claudeNotes?: string;
  /** Subcommands (for commands like !worktree, !update) */
  subcommands?: SubcommandDefinition[];
  /**
   * Whether Claude can execute this command from its output.
   * When true, the bot will parse Claude's output for this command
   * and execute it automatically.
   */
  claudeCanExecute?: boolean;
  /**
   * Whether executing this command returns a result to Claude.
   * When true, the command output is sent back to Claude in a <command-result> tag.
   */
  returnsResultToClaude?: boolean;
  /**
   * Whether this command can be used in the first message when starting a session.
   * When true, the command will be parsed and applied before session creation.
   * Commands that require an existing session (like !stop, !invite) should have this false/undefined.
   */
  worksInFirstMessage?: boolean;
}

/** Subcommand definition */
export interface SubcommandDefinition {
  /** Subcommand name */
  name: string;
  /** Description */
  description: string;
  /** Optional argument placeholder */
  args?: string;
  /** Whether Claude can execute this subcommand */
  claudeCanExecute?: boolean;
  /** Whether this subcommand returns results to Claude */
  returnsResultToClaude?: boolean;
}

/** Reaction definition */
export interface ReactionDefinition {
  /** Emoji */
  emoji: string;
  /** What it does */
  description: string;
  /** Context where this reaction is used */
  context: 'approval' | 'session' | 'both';
}

// =============================================================================
// Command Registry
// =============================================================================

/**
 * All available commands, organized by purpose.
 * This is the single source of truth for help and system prompt generation.
 */
export const COMMAND_REGISTRY: CommandDefinition[] = [
  // ---------------------------------------------------------------------------
  // Info Commands (work without session)
  // ---------------------------------------------------------------------------
  {
    command: 'help',
    description: 'Show available commands',
    category: 'system',
    audience: 'user',
    worksInFirstMessage: true,  // Show help without starting session
  },
  {
    command: 'release-notes',
    description: 'Show release notes for current version',
    category: 'system',
    audience: 'user',
    worksInFirstMessage: true,  // Show release notes without starting session
  },

  // ---------------------------------------------------------------------------
  // Session Control
  // ---------------------------------------------------------------------------
  {
    command: 'stop',
    description: 'Stop this session',
    category: 'session',
    audience: 'user',
    claudeNotes: 'Would kill your own session - do not use',
  },
  {
    command: 'escape',
    description: 'Interrupt current task (session stays active)',
    category: 'session',
    audience: 'user',
    claudeNotes: 'Would interrupt your own session - do not use',
  },
  {
    command: 'approve',
    description: 'Approve pending plan (alternative to 👍 reaction)',
    category: 'session',
    audience: 'user',
  },

  // ---------------------------------------------------------------------------
  // Git Worktree Management
  // ---------------------------------------------------------------------------
  {
    command: 'worktree',
    description: 'Create and switch to a git worktree',
    args: '<branch>',
    category: 'worktree',
    audience: 'both',
    claudeNotes: 'Result is sent back to you in a <command-result> tag',
    worksInFirstMessage: true,  // Can specify branch when starting session
    subcommands: [
      { name: 'list', description: 'List all worktrees for the repo', claudeCanExecute: true, returnsResultToClaude: true },
      { name: 'switch', description: 'Switch to an existing worktree', args: '<branch>' },
      { name: 'remove', description: 'Remove a worktree', args: '<branch>' },
      { name: 'cleanup', description: 'Delete current worktree and switch back to repo' },
      { name: 'off', description: 'Disable worktree prompts for this session' },
    ],
  },

  // ---------------------------------------------------------------------------
  // Collaboration
  // ---------------------------------------------------------------------------
  {
    command: 'invite',
    description: 'Invite a user to this session',
    args: '@user',
    category: 'collaboration',
    audience: 'user',
    claudeNotes: 'User decisions, not yours',
  },
  {
    command: 'kick',
    description: 'Remove an invited user',
    args: '@user',
    category: 'collaboration',
    audience: 'user',
    claudeNotes: 'User decisions, not yours',
  },

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  {
    command: 'cd',
    description: 'Change working directory (restarts Claude)',
    args: '<path>',
    category: 'settings',
    audience: 'both',
    claudeNotes: 'WARNING: This spawns a NEW Claude instance - you won\'t remember this conversation!',
    claudeCanExecute: true,
    returnsResultToClaude: false,
    worksInFirstMessage: true,  // Start session in different directory
  },
  {
    command: 'permissions',
    description: 'Toggle permission prompts',
    args: 'interactive|skip',
    category: 'settings',
    audience: 'user',
    claudeNotes: 'User decisions, not yours',
    worksInFirstMessage: true,  // Start session with interactive permissions
  },

  // ---------------------------------------------------------------------------
  // System
  // ---------------------------------------------------------------------------
  {
    command: 'update',
    description: 'Show auto-update status',
    category: 'system',
    audience: 'user',
    worksInFirstMessage: true,  // Check for updates without starting session
    subcommands: [
      { name: 'now', description: 'Apply pending update immediately' },
      { name: 'defer', description: 'Defer pending update for 1 hour' },
    ],
  },
  {
    command: 'kill',
    description: 'Emergency shutdown (kills ALL sessions, exits bot)',
    category: 'system',
    audience: 'user',
  },
  {
    command: 'bug',
    description: 'Report a bug (creates GitHub issue)',
    args: '<description>',
    category: 'system',
    audience: 'both',
    claudeCanExecute: true,
    returnsResultToClaude: false,
  },
  {
    command: 'plugin',
    description: 'Manage Claude Code plugins',
    args: '<subcommand> [name]',
    category: 'system',
    audience: 'user',  // User only - security concern
    claudeNotes: 'User manages plugins themselves',
    subcommands: [
      { name: 'list', description: 'List installed plugins' },
      { name: 'install', description: 'Install a plugin (restarts Claude)', args: '<name>' },
      { name: 'uninstall', description: 'Uninstall a plugin (restarts Claude)', args: '<name>' },
    ],
  },

  // ---------------------------------------------------------------------------
  // Claude Code Passthrough (hidden from help, used in system prompt)
  // ---------------------------------------------------------------------------
  {
    command: 'context',
    description: 'Show context usage',
    category: 'passthrough',
    audience: 'both',
  },
  {
    command: 'cost',
    description: 'Show session cost',
    category: 'passthrough',
    audience: 'both',
  },
  {
    command: 'compact',
    description: 'Compact conversation',
    category: 'passthrough',
    audience: 'both',
  },
];

// =============================================================================
// Reaction Registry
// =============================================================================

/**
 * All available reactions for controlling sessions.
 */
export const REACTION_REGISTRY: ReactionDefinition[] = [
  { emoji: '👍', description: 'Approve action', context: 'approval' },
  { emoji: '✅', description: 'Approve all', context: 'approval' },
  { emoji: '👎', description: 'Deny', context: 'approval' },
  { emoji: '⏸️', description: 'Interrupt current task (session stays active)', context: 'session' },
  { emoji: '❌', description: 'Stop session', context: 'session' },
  { emoji: '🛑', description: 'Stop session', context: 'session' },
];

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get commands that should appear in user help (!help command).
 * Excludes passthrough commands which are internal.
 */
export function getUserHelpCommands(): CommandDefinition[] {
  return COMMAND_REGISTRY.filter(cmd =>
    cmd.category !== 'passthrough' &&
    (cmd.audience === 'user' || cmd.audience === 'both')
  );
}

/**
 * Get commands that Claude can execute.
 */
export function getClaudeExecutableCommands(): CommandDefinition[] {
  return COMMAND_REGISTRY.filter(cmd =>
    (cmd.audience === 'claude' || cmd.audience === 'both') &&
    !cmd.claudeNotes?.includes('do not use')
  );
}

/**
 * Get commands that Claude should NOT use (with reasons).
 */
export function getClaudeAvoidCommands(): Array<{ command: string; reason: string }> {
  return COMMAND_REGISTRY
    .filter(cmd => cmd.claudeNotes?.includes('do not use') || cmd.claudeNotes?.includes('User decisions'))
    .map(cmd => ({
      command: cmd.command,
      reason: cmd.claudeNotes ?? '',
    }));
}

/**
 * Build a Set of command strings that Claude is allowed to execute.
 * This is used by the parser to validate Claude's output commands.
 *
 * Returns commands in the format used by the parser:
 * - 'cd' for simple commands
 * - 'worktree list' for subcommands
 */
export function buildClaudeAllowedCommandsSet(): Set<string> {
  const allowed = new Set<string>();

  for (const cmd of COMMAND_REGISTRY) {
    // Check main command
    if (cmd.claudeCanExecute) {
      allowed.add(cmd.command);
    }

    // Check subcommands
    if (cmd.subcommands) {
      for (const sub of cmd.subcommands) {
        if (sub.claudeCanExecute) {
          allowed.add(`${cmd.command} ${sub.name}`);
        }
      }
    }
  }

  return allowed;
}

