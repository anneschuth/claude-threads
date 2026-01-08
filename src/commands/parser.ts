/**
 * Command Parser Module
 *
 * Shared command parsing logic for both user messages and Claude output.
 * Centralizes the definition of available commands and their parsing.
 */

// =============================================================================
// Command Definitions
// =============================================================================

/**
 * Parsed command result
 */
export interface ParsedCommand {
  /** The command name (without !) */
  command: string;
  /** Arguments for the command */
  args?: string;
  /** The full match string (for removal from text) */
  match: string;
}

/**
 * Commands that Claude is allowed to execute from its output.
 * Only safe commands that don't modify access control or security settings.
 */
export const CLAUDE_ALLOWED_COMMANDS = new Set([
  'cd',  // Change directory - safe, just changes context
]);

/**
 * All available commands and their patterns.
 * Each entry is [command, pattern] where pattern captures optional args.
 */
const COMMAND_PATTERNS: Array<[string, RegExp]> = [
  // Session control
  ['stop', /^!(?:stop|cancel)\s*$/i],
  ['escape', /^!(?:escape|interrupt)\s*$/i],
  ['approve', /^!(?:approve|yes)\s*$/i],
  ['help', /^!help\s*$/i],
  ['release-notes', /^!(?:release-notes|changelog)\s*$/i],

  // Directory/worktree
  ['cd', /^!cd\s+(.+)$/i],
  ['worktree', /^!worktree\s+(\S+(?:\s+.*)?)$/i],

  // User management
  ['invite', /^!invite\s+@?([\w.-]+)\s*$/i],
  ['kick', /^!kick\s+@?([\w.-]+)\s*$/i],

  // Permissions
  ['permissions', /^!permissions?\s+(interactive|auto)\s*$/i],

  // Updates
  ['update', /^!update(?:\s+(now|defer))?\s*$/i],

  // Claude Code passthrough commands
  ['context', /^!context\s*$/i],
  ['cost', /^!cost\s*$/i],
  ['compact', /^!compact\s*$/i],

  // Emergency
  ['kill', /^!kill\s*$/i],
];

// =============================================================================
// Parser Functions
// =============================================================================

/**
 * Parse a command from text content.
 *
 * @param text - The text to parse (should be trimmed)
 * @returns Parsed command or null if no command found
 */
export function parseCommand(text: string): ParsedCommand | null {
  for (const [command, pattern] of COMMAND_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return {
        command,
        args: match[1]?.trim(),
        match: match[0],
      };
    }
  }
  return null;
}

/**
 * Parse a command from Claude's assistant output.
 * Uses multiline matching since the command may be in the middle of text.
 *
 * Only returns commands that Claude is allowed to execute.
 *
 * @param text - The full assistant text output
 * @returns Parsed command or null if no allowed command found
 */
export function parseClaudeCommand(text: string): ParsedCommand | null {
  // For Claude output, we only allow specific commands
  // and they must be on their own line
  const cdMatch = text.match(/^!cd\s+([\w~./-]+)\s*$/m);
  if (cdMatch && CLAUDE_ALLOWED_COMMANDS.has('cd')) {
    return {
      command: 'cd',
      args: cdMatch[1],
      match: cdMatch[0].trimEnd(),  // Remove trailing whitespace/newline
    };
  }

  return null;
}

/**
 * Check if a command is allowed to be executed by Claude.
 */
export function isClaudeAllowedCommand(command: string): boolean {
  return CLAUDE_ALLOWED_COMMANDS.has(command);
}

/**
 * Remove a command from text (for cleaning up display).
 *
 * @param text - Original text
 * @param command - The parsed command to remove
 * @returns Text with command removed and trimmed
 */
export function removeCommandFromText(text: string, command: ParsedCommand): string {
  return text.replace(command.match, '').trim();
}
