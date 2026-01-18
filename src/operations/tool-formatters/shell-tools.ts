/**
 * Shell management tool formatters
 *
 * Handles formatting of shell management tools:
 * - TaskOutput: Retrieve output from background tasks
 * - BashOutput: Retrieve output from background bash shells
 * - KillShell: Terminate a running background shell
 */

import type { ToolFormatter, ToolFormatResult, ToolInput, ToolFormatOptions } from './types.js';

// ---------------------------------------------------------------------------
// Shell Tools Formatter
// ---------------------------------------------------------------------------

/**
 * Formatter for shell management tools (TaskOutput, BashOutput, KillShell).
 */
export const shellToolsFormatter: ToolFormatter = {
  toolNames: ['TaskOutput', 'BashOutput', 'KillShell'],

  format(toolName: string, input: ToolInput, options: ToolFormatOptions): ToolFormatResult | null {
    const { formatter } = options;

    switch (toolName) {
      case 'TaskOutput': {
        const taskId = (input.task_id as string) || 'unknown';
        const block = input.block as boolean | undefined;
        const timeout = input.timeout as number | undefined;

        // Format timeout if present (convert ms to seconds for readability)
        let details = '';
        if (block === false) {
          details = ' (non-blocking)';
        } else if (timeout) {
          const timeoutSec = Math.round(timeout / 1000);
          details = ` (timeout: ${timeoutSec}s)`;
        }

        return {
          display: `📋 ${formatter.formatBold('TaskOutput')} ${formatter.formatCode(taskId)}${details}`,
          permissionText: `📋 ${formatter.formatBold('TaskOutput')} ${formatter.formatCode(taskId)}`,
        };
      }

      case 'BashOutput': {
        const bashId = (input.bash_id as string) || 'unknown';
        const block = input.block as boolean | undefined;
        const waitUpTo = input.wait_up_to as number | undefined;

        // Format wait time if present
        let details = '';
        if (block === false) {
          details = ' (non-blocking)';
        } else if (waitUpTo) {
          details = ` (wait: ${waitUpTo}s)`;
        }

        return {
          display: `💻 ${formatter.formatBold('BashOutput')} ${formatter.formatCode(bashId)}${details}`,
          permissionText: `💻 ${formatter.formatBold('BashOutput')} ${formatter.formatCode(bashId)}`,
        };
      }

      case 'KillShell': {
        const shellId = (input.shell_id as string) || 'unknown';

        return {
          display: `🛑 ${formatter.formatBold('KillShell')} ${formatter.formatCode(shellId)}`,
          permissionText: `🛑 ${formatter.formatBold('KillShell')} ${formatter.formatCode(shellId)}`,
          isDestructive: true, // Killing a shell is a destructive operation
        };
      }

      default:
        return null;
    }
  },
};
