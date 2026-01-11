/**
 * Task-related tool formatters
 *
 * Handles tools that affect task/workflow state:
 * - TodoWrite: Task list management (hidden, handled specially)
 * - Task: Subagent spawning (hidden, handled specially)
 * - EnterPlanMode: Plan mode entry
 * - ExitPlanMode: Plan approval (hidden, handled specially)
 * - AskUserQuestion: User questions (hidden, handled specially)
 */

import type { ToolFormatter, ToolFormatResult, ToolInput, ToolFormatOptions } from './types.js';

// ---------------------------------------------------------------------------
// Task Tools Formatter
// ---------------------------------------------------------------------------

/**
 * Formatter for task-related tools.
 */
export const taskToolsFormatter: ToolFormatter = {
  toolNames: ['TodoWrite', 'Task', 'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion'],

  format(toolName: string, _input: ToolInput, options: ToolFormatOptions): ToolFormatResult | null {
    const { formatter } = options;

    switch (toolName) {
      case 'TodoWrite':
        // Hidden - handled specially with task list display
        return { display: null, hidden: true };

      case 'Task':
        // Hidden - handled specially with subagent display
        return { display: null, hidden: true };

      case 'EnterPlanMode':
        return {
          display: `📋 ${formatter.formatBold('Planning...')}`,
          permissionText: `📋 ${formatter.formatBold('Planning...')}`,
        };

      case 'ExitPlanMode':
        // Hidden - handled specially with approval buttons
        return { display: null, hidden: true };

      case 'AskUserQuestion':
        // Hidden - the question text follows separately
        return { display: null, hidden: true };

      default:
        return null;
    }
  },
};
