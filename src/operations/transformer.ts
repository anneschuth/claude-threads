/**
 * Event Transformer - Convert Claude events to message operations
 *
 * This module transforms Claude CLI events into MessageOperation objects.
 * This is a pure transformation layer with no side effects.
 *
 * The transformer extracts the logic from events.ts into testable functions
 * that don't depend on session state or platform APIs.
 */

import type { ClaudeEvent } from '../claude/cli.js';
import type { PlatformFormatter } from '../platform/formatter.js';
import type {
  MessageOperation,
  TaskItem,
  Question,
  QuestionOption,
} from './types.js';
import {
  createAppendContentOp,
  createFlushOp,
  createTaskListOp,
  createQuestionOp,
  createApprovalOp,
  createSubagentOp,
  createStatusUpdateOp,
} from './types.js';
import { toolFormatterRegistry } from './tool-formatters/index.js';
import type { WorktreeContext } from './tool-formatters/index.js';

// ---------------------------------------------------------------------------
// Transform Context
// ---------------------------------------------------------------------------

/**
 * Context for transforming events.
 * Contains only the information needed for transformation (no side effects).
 */
export interface TransformContext {
  /** Session ID for created operations */
  sessionId: string;
  /** Platform formatter for markdown */
  formatter: PlatformFormatter;
  /** Worktree info for path shortening (optional) */
  worktreeInfo?: WorktreeContext;
  /** Active tool start times (for elapsed time calculation) */
  toolStartTimes: Map<string, number>;
  /** Whether to include detailed previews */
  detailed?: boolean;
}

// ---------------------------------------------------------------------------
// Main Transform Function
// ---------------------------------------------------------------------------

/**
 * Transform a Claude event into message operations.
 *
 * @param event - The Claude event to transform
 * @param ctx - Transform context
 * @returns Array of operations (may be empty, may have multiple)
 */
export function transformEvent(
  event: ClaudeEvent,
  ctx: TransformContext
): MessageOperation[] {
  switch (event.type) {
    case 'assistant':
      return transformAssistant(event, ctx);

    case 'tool_use':
      return transformToolUse(event, ctx);

    case 'tool_result':
      return transformToolResult(event, ctx);

    case 'result':
      return transformResult(event, ctx);

    default:
      // Unknown event type - no operations
      return [];
  }
}

// ---------------------------------------------------------------------------
// Assistant Event Transformation
// ---------------------------------------------------------------------------

/**
 * Transform an assistant event.
 * Handles text, tool_use, and thinking blocks.
 */
function transformAssistant(
  event: ClaudeEvent,
  ctx: TransformContext
): MessageOperation[] {
  const msg = event.message as {
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
    }>;
  };

  const operations: MessageOperation[] = [];
  const contentParts: string[] = [];

  for (const block of msg?.content || []) {
    if (block.type === 'text' && block.text) {
      // Filter out <thinking> tags that may appear in text content
      const text = block.text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
      if (text) contentParts.push(text);
    } else if (block.type === 'tool_use' && block.name) {
      // Handle special tools that create their own operations
      const specialOps = handleSpecialTool(block.name, block.id || '', block.input || {}, ctx);
      if (specialOps) {
        // Flush accumulated content first
        if (contentParts.length > 0) {
          operations.push(createAppendContentOp(ctx.sessionId, contentParts.join('\n\n')));
          contentParts.length = 0;
        }
        operations.push(...specialOps);
      } else {
        // Format regular tool use
        const result = toolFormatterRegistry.format(block.name, block.input || {}, {
          formatter: ctx.formatter,
          detailed: ctx.detailed ?? true,
          worktreeInfo: ctx.worktreeInfo,
        });
        if (result.display && !result.hidden) {
          contentParts.push(result.display);
        }
      }
    } else if (block.type === 'thinking' && block.thinking) {
      // Extended thinking - show abbreviated version
      const thinking = block.thinking as string;
      const preview = truncateAtWord(thinking, 200);
      const formatted = ctx.formatter.formatBlockquote(
        `💭 ${ctx.formatter.formatItalic(preview)}`
      );
      contentParts.push(formatted);
    } else if (block.type === 'server_tool_use' && block.name) {
      // Server-managed tools (e.g., web search)
      const inputStr = block.input ? JSON.stringify(block.input).substring(0, 50) : '';
      contentParts.push(
        `🌐 ${ctx.formatter.formatBold(block.name)} ${inputStr}`
      );
    }
  }

  // Add accumulated content
  if (contentParts.length > 0) {
    operations.push(createAppendContentOp(ctx.sessionId, contentParts.join('\n\n')));
  }

  return operations;
}

// ---------------------------------------------------------------------------
// Tool Use Event Transformation
// ---------------------------------------------------------------------------

/**
 * Transform a tool_use event.
 */
function transformToolUse(
  event: ClaudeEvent,
  ctx: TransformContext
): MessageOperation[] {
  const tool = event.tool_use as {
    id?: string;
    name: string;
    input?: Record<string, unknown>;
  };

  // Track tool start time
  if (tool.id) {
    ctx.toolStartTimes.set(tool.id, Date.now());
  }

  // Check for special tools
  const specialOps = handleSpecialTool(tool.name, tool.id || '', tool.input || {}, ctx);
  if (specialOps) {
    return specialOps;
  }

  // Format regular tool use
  const result = toolFormatterRegistry.format(tool.name, tool.input || {}, {
    formatter: ctx.formatter,
    detailed: ctx.detailed ?? true,
    worktreeInfo: ctx.worktreeInfo,
  });

  if (result.display && !result.hidden) {
    return [createAppendContentOp(ctx.sessionId, result.display, true)];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Tool Result Event Transformation
// ---------------------------------------------------------------------------

/**
 * Transform a tool_result event.
 */
function transformToolResult(
  event: ClaudeEvent,
  ctx: TransformContext
): MessageOperation[] {
  // Guard against undefined tool_result
  if (!event.tool_result) {
    return [];
  }

  const result = event.tool_result as {
    tool_use_id?: string;
    is_error?: boolean;
  };

  const operations: MessageOperation[] = [];

  // Calculate elapsed time
  let elapsed = '';
  if (result.tool_use_id) {
    const startTime = ctx.toolStartTimes.get(result.tool_use_id);
    if (startTime) {
      const secs = Math.round((Date.now() - startTime) / 1000);
      if (secs >= 3) {
        elapsed = ` (${secs}s)`;
      }
      ctx.toolStartTimes.delete(result.tool_use_id);
    }
  }

  // Format result indicator
  const icon = result.is_error ? '❌' : '✓';
  const errorNote = result.is_error ? ' Error' : '';
  operations.push(
    createAppendContentOp(ctx.sessionId, `  ↳ ${icon}${errorNote}${elapsed}`, true)
  );

  // Tool results are a natural break point - suggest flush
  operations.push(createFlushOp(ctx.sessionId, 'tool_complete'));

  return operations;
}

// ---------------------------------------------------------------------------
// Result Event Transformation
// ---------------------------------------------------------------------------

/**
 * Transform a result event (Claude finished processing).
 */
function transformResult(
  event: ClaudeEvent,
  ctx: TransformContext
): MessageOperation[] {
  const operations: MessageOperation[] = [];

  // Result event triggers a final flush
  operations.push(createFlushOp(ctx.sessionId, 'result'));

  // Extract usage stats if available
  const result = event as ClaudeEvent & {
    result?: {
      model?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
      cost_usd?: number;
    };
  };

  if (result.result) {
    const r = result.result;
    operations.push(
      createStatusUpdateOp(ctx.sessionId, {
        modelId: r.model,
        totalCostUSD: r.cost_usd,
        // Note: Full usage stats would require model-specific token tracking
      })
    );
  }

  return operations;
}

// ---------------------------------------------------------------------------
// Special Tool Handling
// ---------------------------------------------------------------------------

/**
 * Handle special tools that create their own operations.
 * Returns null if the tool should use normal formatting.
 */
function handleSpecialTool(
  toolName: string,
  toolUseId: string,
  input: Record<string, unknown>,
  ctx: TransformContext
): MessageOperation[] | null {
  switch (toolName) {
    case 'TodoWrite':
      return handleTodoWrite(input, ctx);

    case 'Task':
      return handleTaskStart(toolUseId, input, ctx);

    case 'AskUserQuestion':
      return handleAskUserQuestion(toolUseId, input, ctx);

    case 'ExitPlanMode':
      return handleExitPlanMode(toolUseId, ctx);

    default:
      return null;
  }
}

/**
 * Handle TodoWrite tool - update task list.
 */
function handleTodoWrite(
  input: Record<string, unknown>,
  ctx: TransformContext
): MessageOperation[] {
  const todos = (input.todos as Array<{
    content: string;
    status: string;
    activeForm: string;
  }>) || [];

  const tasks: TaskItem[] = todos.map(t => ({
    content: t.content,
    status: t.status as TaskItem['status'],
    activeForm: t.activeForm,
  }));

  // Determine if all tasks are completed
  const allCompleted = tasks.every(t => t.status === 'completed');
  const action = allCompleted ? 'complete' : 'update';

  return [createTaskListOp(ctx.sessionId, action, tasks)];
}

/**
 * Handle Task tool - start a subagent.
 */
function handleTaskStart(
  toolUseId: string,
  input: Record<string, unknown>,
  ctx: TransformContext
): MessageOperation[] {
  const description = (input.description as string) || (input.prompt as string) || 'Subagent';
  const subagentType = (input.subagent_type as string) || 'general-purpose';

  return [
    createSubagentOp(ctx.sessionId, toolUseId, 'start', description, subagentType),
  ];
}

/**
 * Handle AskUserQuestion tool - post questions.
 */
function handleAskUserQuestion(
  toolUseId: string,
  input: Record<string, unknown>,
  ctx: TransformContext
): MessageOperation[] {
  const rawQuestions = (input.questions as Array<{
    header: string;
    question: string;
    options: Array<{ label: string; description: string }>;
    multiSelect?: boolean;
  }>) || [];

  const questions: Question[] = rawQuestions.map(q => ({
    header: q.header,
    question: q.question,
    options: q.options.map((o): QuestionOption => ({
      label: o.label,
      description: o.description,
    })),
    multiSelect: q.multiSelect ?? false,
  }));

  return [createQuestionOp(ctx.sessionId, toolUseId, questions, 0)];
}

/**
 * Handle ExitPlanMode tool - request plan approval.
 */
function handleExitPlanMode(
  toolUseId: string,
  ctx: TransformContext
): MessageOperation[] {
  return [createApprovalOp(ctx.sessionId, toolUseId, 'plan')];
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Truncate text at word boundary.
 */
function truncateAtWord(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  let truncated = text.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLength * 0.7) {
    truncated = truncated.substring(0, lastSpace);
  }
  return truncated + '...';
}
