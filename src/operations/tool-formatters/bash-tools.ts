/**
 * Bash tool formatter
 *
 * Handles formatting of Bash command execution with:
 * - Command truncation for long commands
 * - Worktree path shortening in commands
 */

import type { ToolFormatter, ToolFormatResult, ToolInput, ToolFormatOptions } from './types.js';
import { escapeRegExp, escapeCodeBlockContent } from './utils.js';

/**
 * The permission prompt is the user's only chance to see what is about to run —
 * a hard-truncated command turns the approval gate into rubber-stamping. Show
 * the command up to this cap; anything longer is still cut so a pathological
 * command cannot blow up the prompt post (the platform layer enforces its own
 * overall message-size limits on top).
 *
 * The cap counts Unicode code points, not UTF-16 units: an all-astral command
 * can emit up to twice this many units (~3000), still far under the platform
 * layer's 16K message split.
 */
const PERMISSION_COMMAND_MAX = 1500;

/**
 * Truncate at a Unicode code-point boundary so a cut never lands inside a
 * surrogate pair (String.prototype.substring counts UTF-16 code units).
 */
function truncateAtCodePoint(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const points = Array.from(text);
  if (points.length <= max) return { text, truncated: false };
  return { text: points.slice(0, max).join(''), truncated: true };
}

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

    // The permission prompt renders the command as a fenced code block: a real
    // command may contain backticks or newlines, which would break out of an
    // inline code span and corrupt the prompt (including the reaction legend).
    const permission = truncateAtCodePoint(cmd, PERMISSION_COMMAND_MAX);
    const permissionCmd = escapeCodeBlockContent(permission.text) + (permission.truncated ? '\n[... truncated]' : '');

    return {
      display: `💻 ${formatter.formatBold('Bash')} ${formatter.formatCode(displayCmd + (truncated ? '...' : ''))}`,
      permissionText: `💻 ${formatter.formatBold('Bash')}\n${formatter.formatCodeBlock(permissionCmd, 'bash')}`,
      isDestructive: true, // Bash commands can be destructive
    };
  },
};
