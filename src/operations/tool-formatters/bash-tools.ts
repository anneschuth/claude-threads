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

    // Truncate long commands
    const truncated = cmd.length > maxCommandLength;
    const displayCmd = cmd.substring(0, maxCommandLength);

    return {
      display: `💻 ${formatter.formatBold('Bash')} ${formatter.formatCode(displayCmd + (truncated ? '...' : ''))}`,
      permissionText: `💻 ${formatter.formatBold('Bash')} ${formatter.formatCode(cmd.substring(0, 100) + (cmd.length >= 100 ? '...' : ''))}`,
      isDestructive: true, // Bash commands can be destructive
    };
  },
};
