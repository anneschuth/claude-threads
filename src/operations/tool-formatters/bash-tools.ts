/**
 * Bash tool formatter
 *
 * Handles formatting of Bash command execution with:
 * - Command truncation for long commands (full command below in detailed mode)
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

/**
 * Width of a line in the full-command block. Mattermost mobile renders a code
 * block without wrapping (its full-screen code view scrolls sideways), so a
 * one-line command stays unreadable on a phone even once expanded. The block is
 * display-only, so it is pre-wrapped for reading; the permission prompt keeps
 * the command verbatim.
 */
const COMMAND_BLOCK_WIDTH = 40;

/**
 * Wrap a command for display: break after `;`, `&&`, `||` and `|`, then at
 * spaces so no line exceeds `width` (a longer word is split). Continuation
 * lines are indented by two spaces. Runs of spaces collapse to one, so the
 * result is for reading, not for copying back into a shell.
 */
function wrapCommandForDisplay(cmd: string, width = COMMAND_BLOCK_WIDTH): string {
  const out: string[] = [];
  for (const rawLine of cmd.split('\n')) {
    for (const part of rawLine.split(/(?<=;|&&|\|\||\|)[ \t]+/)) {
      let line = '';
      for (let word of part.split(/[ \t]+/)) {
        if (!word) continue;
        if (line.trim() && line.length + 1 + word.length > width) {
          out.push(line);
          line = '  ';
        }
        if (line.trim()) line += ' ';
        while (line.length + word.length > width) {
          const room = Math.max(1, width - line.length);
          out.push(line + word.slice(0, room));
          word = word.slice(room);
          line = '  ';
        }
        line += word;
      }
      if (line.trim()) out.push(line);
    }
  }
  return out.join('\n');
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

    const { formatter, detailed = false, maxCommandLength = 50, worktreeInfo } = options;

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

    let display = `💻 ${formatter.formatBold('Bash')} ${formatter.formatCode(displayCmd + (truncated ? '...' : ''))}`;

    // A truncated one-liner hides the part of the command that matters, and
    // once approved the permission prompt is gone. In detailed mode (like the
    // Edit diff and Write preview) show the full command, same cap as the
    // prompt, as a fenced block: Mattermost mobile collapses a long block
    // behind "+N more lines", so the thread stays compact until it is opened.
    if (detailed && truncated) {
      const block = escapeCodeBlockContent(wrapCommandForDisplay(permission.text))
        + (permission.truncated ? '\n[... truncated]' : '');
      display += `\n${formatter.formatCodeBlock(block, 'bash')}`;
    }

    return {
      display,
      permissionText: `💻 ${formatter.formatBold('Bash')}\n${formatter.formatCodeBlock(permissionCmd, 'bash')}`,
      isDestructive: true, // Bash commands can be destructive
    };
  },
};
