/**
 * Pure translation layer: codex app-server notifications → normalized AgentEvents
 * (shaped like Claude CLI stream-json events, see src/agents/types.ts).
 *
 * All protocol strings live in this module so a codex version bump that renames
 * methods or item types is a one-file change. Verified against codex-cli 0.144.x
 * (`codex app-server generate-json-schema`).
 */

import type { AgentEvent } from '../types.js';

// ---------------------------------------------------------------------------
// Protocol constants (codex app-server v2 surface)
// ---------------------------------------------------------------------------

export const CODEX_METHODS = {
  // client → server
  initialize: 'initialize',
  initialized: 'initialized',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  turnStart: 'turn/start',
  turnInterrupt: 'turn/interrupt',
  // server → client notifications
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  turnCompleted: 'turn/completed',
  turnPlanUpdated: 'turn/plan/updated',
  tokenUsageUpdated: 'thread/tokenUsage/updated',
  error: 'error',
  // server → client requests (approvals)
  commandApproval: 'item/commandExecution/requestApproval',
  fileChangeApproval: 'item/fileChange/requestApproval',
  // legacy approval method names (older app-server surface)
  legacyExecApproval: 'execCommandApproval',
  legacyPatchApproval: 'applyPatchApproval',
} as const;

/** Prefix for synthetic tool_use ids of Codex permission requests */
export const CODEX_PERMISSION_PREFIX = 'codex-perm:';

// ---------------------------------------------------------------------------
// Codex notification payload shapes (subset we consume)
// ---------------------------------------------------------------------------

interface CodexItem {
  type: string;
  id: string;
  // agentMessage
  text?: string;
  // reasoning
  summary?: string[] | string;
  content?: unknown;
  // commandExecution
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  status?: string;
  aggregatedOutput?: string | null;
  // fileChange
  changes?: Array<{ path: string; kind?: { type?: string } | string; diff?: string }>;
  // webSearch
  query?: string;
  // mcpToolCall
  server?: string;
  tool?: string;
  arguments?: unknown;
  error?: unknown;
}

interface ItemNotificationParams {
  item?: CodexItem;
  threadId?: string;
  turnId?: string;
}

interface TurnPlanUpdatedParams {
  plan?: Array<{ step: string; status: string }>;
}

export interface CodexTokenUsage {
  total: {
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens?: number;
  };
  last: {
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens?: number;
  };
  modelContextWindow?: number | null;
}

interface TokenUsageUpdatedParams {
  tokenUsage?: CodexTokenUsage;
}

interface TurnCompletedParams {
  turn?: {
    status?: string; // completed | interrupted | failed | inProgress
    error?: { message?: string } | null;
  };
}

interface ErrorNotificationParams {
  error?: { message?: string };
  willRetry?: boolean;
}

/** Default context window when codex doesn't report one (gpt-5.x-codex family) */
export const CODEX_DEFAULT_CONTEXT_WINDOW = 272000;

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/**
 * Mutable translation state owned by CodexCli and threaded through
 * translateNotification. Keeps the translator itself pure/stateless.
 */
export interface CodexTranslationState {
  /** Latest cumulative token usage from thread/tokenUsage/updated */
  tokenUsage: CodexTokenUsage | null;
  /** Model id reported by thread/start (e.g. "gpt-5.5-codex") */
  model: string;
}

export function createTranslationState(model = 'codex'): CodexTranslationState {
  return { tokenUsage: null, model };
}

/**
 * Translate a codex app-server notification into normalized AgentEvents.
 * Returns [] for notifications that have no chat-visible representation.
 */
export function translateNotification(
  method: string,
  params: unknown,
  state: CodexTranslationState
): AgentEvent[] {
  switch (method) {
    case CODEX_METHODS.itemStarted:
      return translateItemStarted((params as ItemNotificationParams).item);

    case CODEX_METHODS.itemCompleted:
      return translateItemCompleted((params as ItemNotificationParams).item);

    case CODEX_METHODS.turnPlanUpdated:
      return translatePlanUpdate(params as TurnPlanUpdatedParams);

    case CODEX_METHODS.tokenUsageUpdated: {
      const usage = (params as TokenUsageUpdatedParams).tokenUsage;
      if (usage) state.tokenUsage = usage;
      return []; // consumed at turn/completed time
    }

    case CODEX_METHODS.turnCompleted:
      return translateTurnCompleted(params as TurnCompletedParams, state);

    case CODEX_METHODS.error: {
      const p = params as ErrorNotificationParams;
      if (p.willRetry) return []; // transient, codex retries internally
      return [{
        type: 'system',
        subtype: 'error',
        error: p.error?.message ?? 'Unknown Codex error',
      }];
    }

    default:
      return [];
  }
}

function translateItemStarted(item: CodexItem | undefined): AgentEvent[] {
  if (!item) return [];

  switch (item.type) {
    case 'commandExecution':
      return [toolUseEvent(item.id, 'Bash', { command: displayCommand(item) })];

    case 'fileChange':
      return fileChangeToolUses(item);

    case 'webSearch':
      return [toolUseEvent(item.id, 'WebSearch', { query: item.query ?? '' })];

    case 'mcpToolCall':
      return [toolUseEvent(
        item.id,
        `mcp__${item.server ?? 'unknown'}__${item.tool ?? 'unknown'}`,
        (item.arguments as Record<string, unknown>) ?? {}
      )];

    default:
      // agentMessage/reasoning are emitted on completion (full text available);
      // userMessage echoes and other item types have no chat representation
      return [];
  }
}

function translateItemCompleted(item: CodexItem | undefined): AgentEvent[] {
  if (!item) return [];

  switch (item.type) {
    case 'agentMessage':
      if (!item.text) return [];
      return [{
        type: 'assistant',
        message: { content: [{ type: 'text', text: item.text }] },
      }];

    case 'reasoning': {
      const summary = Array.isArray(item.summary) ? item.summary.join('\n\n') : item.summary;
      if (!summary) return [];
      return [{
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: summary }] },
      }];
    }

    case 'commandExecution':
      return [toolResultEvent(item.id, item.status !== 'completed' || (item.exitCode ?? 0) !== 0)];

    case 'fileChange':
      return (item.changes ?? []).map((_, index) =>
        toolResultEvent(fileChangeId(item.id, index), item.status === 'failed')
      );

    case 'webSearch':
      return [toolResultEvent(item.id, false)];

    case 'mcpToolCall':
      return [toolResultEvent(item.id, item.status === 'failed' || (item.error !== null && item.error !== undefined))];

    default:
      return [];
  }
}

/** Map codex plan updates onto the TodoWrite shape so TaskListExecutor works unchanged */
function translatePlanUpdate(params: TurnPlanUpdatedParams): AgentEvent[] {
  const plan = params.plan;
  if (!plan?.length) return [];

  const statusMap: Record<string, string> = {
    pending: 'pending',
    inProgress: 'in_progress',
    completed: 'completed',
  };

  return [toolUseEvent(`codex-plan-${plan.length}`, 'TodoWrite', {
    todos: plan.map((step) => ({
      content: step.step,
      status: statusMap[step.status] ?? 'pending',
      activeForm: step.step,
    })),
  })];
}

function translateTurnCompleted(
  params: TurnCompletedParams,
  state: CodexTranslationState
): AgentEvent[] {
  const events: AgentEvent[] = [];
  const status = params.turn?.status;

  if (status === 'failed' && params.turn?.error?.message) {
    events.push({
      type: 'system',
      subtype: 'error',
      error: params.turn.error.message,
    });
  }

  events.push(buildResultEvent(state, status));
  return events;
}

/**
 * Synthesize a Claude-shaped `result` event from codex token usage.
 *
 * `modelUsage` must be present and cumulative — events/handler.ts
 * updateUsageStats() early-returns without it and the session header
 * would silently never show usage stats.
 */
export function buildResultEvent(state: CodexTranslationState, turnStatus?: string): AgentEvent {
  const usage = state.tokenUsage;
  const total = usage?.total;
  const last = usage?.last;
  const contextWindow = usage?.modelContextWindow ?? CODEX_DEFAULT_CONTEXT_WINDOW;

  return {
    type: 'result',
    subtype: turnStatus === 'failed' ? 'error' : 'success',
    result: {
      model: state.model,
    },
    // Per-request usage (last turn): drives the context-percentage display.
    // Codex inputTokens includes cached tokens, so split them out.
    usage: {
      input_tokens: Math.max(0, (last?.inputTokens ?? 0) - (last?.cachedInputTokens ?? 0)),
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: last?.cachedInputTokens ?? 0,
      output_tokens: last?.outputTokens ?? 0,
    },
    // Codex usage is covered by the ChatGPT/API subscription; no per-call cost data
    total_cost_usd: 0,
    modelUsage: {
      [state.model]: {
        inputTokens: Math.max(0, (total?.inputTokens ?? 0) - (total?.cachedInputTokens ?? 0)),
        outputTokens: total?.outputTokens ?? 0,
        cacheReadInputTokens: total?.cachedInputTokens ?? 0,
        cacheCreationInputTokens: 0,
        contextWindow,
        costUSD: 0,
      },
    },
  };
}

/** Synthetic init event carrying the codex threadId as session_id */
export function buildInitEvent(threadId: string, model: string): AgentEvent {
  return {
    type: 'system',
    subtype: 'init',
    session_id: threadId,
    model,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolUseEvent(id: string, name: string, input: Record<string, unknown>): AgentEvent {
  return { type: 'tool_use', tool_use: { id, name, input } };
}

function toolResultEvent(toolUseId: string, isError: boolean): AgentEvent {
  return { type: 'tool_result', tool_result: { tool_use_id: toolUseId, is_error: isError } };
}

/** One tool_use per file change; Write for additions, Edit for updates/deletes */
function fileChangeToolUses(item: CodexItem): AgentEvent[] {
  return (item.changes ?? []).map((change, index) => {
    const kind = typeof change.kind === 'string' ? change.kind : change.kind?.type;
    const name = kind === 'add' ? 'Write' : 'Edit';
    return toolUseEvent(fileChangeId(item.id, index), name, { file_path: change.path });
  });
}

function fileChangeId(itemId: string, index: number): string {
  return `${itemId}:${index}`;
}

/**
 * Strip the shell wrapper codex puts around commands
 * ("/bin/zsh -lc 'echo hi'" → "echo hi") for cleaner chat display.
 */
export function unwrapShellCommand(raw: string): string {
  const match = raw.match(/^\S*\/(?:zsh|bash|sh)\s+-[a-z]*c\s+'([\s\S]*)'$/) ||
    raw.match(/^\S*\/(?:zsh|bash|sh)\s+-[a-z]*c\s+"([\s\S]*)"$/);
  return match ? match[1] : raw;
}

function displayCommand(item: CodexItem): string {
  return unwrapShellCommand(item.command ?? '');
}
