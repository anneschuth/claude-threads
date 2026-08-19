/**
 * Bash tool formatter
 *
 * Handles formatting of Bash command execution with:
 * - Command truncation for long commands
 * - Worktree path shortening in commands
 */

import type { ToolFormatter, ToolFormatResult, ToolInput, ToolFormatOptions } from './types.js';
import { escapeRegExp } from './utils.js';

/**
 * The permission prompt is the user's only chance to see what is about to run —
 * a hard-truncated command turns the approval gate into rubber-stamping. Show
 * the command up to this cap; anything longer is still cut so a pathological
 * command cannot blow up the prompt post (the platform layer enforces its own
 * overall message-size limits on top).
 */
const PERMISSION_COMMAND_MAX = 1500;

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
      permissionText: `💻 ${formatter.formatBold('Bash')} ${formatter.formatCode(cmd.substring(0, PERMISSION_COMMAND_MAX) + (cmd.length > PERMISSION_COMMAND_MAX ? '...' : ''))}`,
      isDestructive: true, // Bash commands can be destructive
    };
  },
};
