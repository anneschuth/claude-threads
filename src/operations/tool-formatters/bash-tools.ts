/**
 * Bash tool formatter
 *
 * Handles formatting of Bash command execution with:
 * - Command truncation for long commands
 * - Worktree path shortening in commands
 */

import type { ToolFormatter, ToolFormatResult, ToolInput, ToolFormatOptions } from './types.js';
import { escapeRegExp } from './utils.js';

// ---------------------------------------------------------------------------
// Bash Formatter
// ---------------------------------------------------------------------------

/** `cd <dir> &&` (or `;`), one or more times, quoted paths included. */
const CD_PREFIX_RE = /^(?:\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s&;|]+)\s*(?:&&|;)\s*)+/;

/**
 * Drop the `cd ~/workspaces/... &&` scaffolding agents prepend to nearly every
 * command. It ate ~40 of the 50 display characters, so a whole run of different
 * commands rendered as the same truncated prefix.
 */
export function stripCdPrefix(cmd: string): string {
  const stripped = cmd.replace(CD_PREFIX_RE, '');
  return stripped.trim() ? stripped : cmd;
}

/**
 * Formatter for Bash tool.
 */
export const bashToolFormatter: ToolFormatter = {
  toolNames: ['Bash'],

  format(toolName: string, input: ToolInput, options: ToolFormatOptions): ToolFormatResult | null {
    if (toolName !== 'Bash') return null;

    const { formatter, maxCommandLength = 50, worktreeInfo } = options;

    let cmd = (input.command as string) || '';

    // Shorten worktree paths in the command
    if (worktreeInfo?.path) {
      cmd = cmd.replace(
        new RegExp(escapeRegExp(worktreeInfo.path), 'g'),
        `[${worktreeInfo.branch}]`
      );
    }

    cmd = stripCdPrefix(cmd);

    // Truncate long commands
    const truncated = cmd.length > maxCommandLength;
    const displayCmd = cmd.substring(0, maxCommandLength);

    const prefix = `💻 ${formatter.formatBold('Bash')}`;
    const body = formatter.formatCode(displayCmd + (truncated ? '...' : ''));

    return {
      display: `${prefix} ${body}`,
      permissionText: `${prefix} ${formatter.formatCode(cmd.substring(0, 100) + (cmd.length >= 100 ? '...' : ''))}`,
      isDestructive: true, // Bash commands can be destructive
      group: { key: 'Bash', prefix, body },
    };
  },
};
