/**
 * Task-related tool formatters
 *
 * Handles tools that affect task/workflow state:
 * - TodoWrite: Task list management (hidden, handled specially)
 * - TaskCreate/TaskUpdate: Incremental task tracking on modern CLIs (hidden,
 *   handled specially via the task tracker)
 * - TaskGet/TaskList: Read-only task queries (hidden, pure noise in chat)
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
  toolNames: [
    'TodoWrite',
    'TaskCreate',
    'TaskUpdate',
    'TaskGet',
    'TaskList',
    'Task',
    'EnterPlanMode',
    'ExitPlanMode',
    'AskUserQuestion',
  ],

  format(toolName: string, input: ToolInput, options: ToolFormatOptions): ToolFormatResult | null {
    const { formatter } = options;

    switch (toolName) {
      case 'TodoWrite':
      case 'TaskCreate':
      case 'TaskUpdate':
        // Hidden - handled specially with task list display
        return { display: null, hidden: true };

      case 'TaskGet':
      case 'TaskList':
        // Hidden - read-only task queries, nothing worth showing
        return { display: null, hidden: true };

      case 'Task':
        // Hidden - handled specially with subagent display
        return { display: null, hidden: true };

      case 'EnterPlanMode':
        return {
          display: `📋 ${formatter.formatBold('Planning...')}`,
          permissionText: `📋 ${formatter.formatBold('Planning...')}`,
        };

      case 'ExitPlanMode': {
        // Hidden in the content stream — the plan-approval UI renders the
        // plan. But on modern CLIs the tool ALSO routes through the MCP
        // permission prompt (verified on 2.1.223), and without permissionText
        // that prompt showed only the bare tool name, asking users to approve
        // a plan they couldn't see. Give it the plan text. (The duplicate
        // prompt itself — MCP prompt vs. the bot's approval UI — is a known
        // conflict tracked as follow-up work.)
        const plan = typeof input.plan === 'string' ? input.plan : '';
        // Truncate on a code-point boundary (Array.from) so the cut can't
        // split a surrogate pair.
        let preview =
          plan.length > 1500 ? `${Array.from(plan).slice(0, 1500).join('')}\n…` : plan;
        // Balance code fences: a cut inside a ``` block would otherwise
        // swallow the reaction legend and decision lines the MCP server
        // appends after this text into the code block.
        const fenceCount = (preview.match(/```/g) || []).length;
        if (fenceCount % 2 === 1) preview += '\n```';
        return {
          display: null,
          hidden: true,
          permissionText: preview
            ? `📋 ${formatter.formatBold('Plan approval requested')}\n\n${preview}`
            : `📋 ${formatter.formatBold('Plan approval requested')}`,
        };
      }

      case 'AskUserQuestion':
        // Hidden - the question text follows separately
        return { display: null, hidden: true };

      default:
        return null;
    }
  },
};
