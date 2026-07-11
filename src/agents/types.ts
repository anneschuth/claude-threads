/**
 * Agent backend abstraction.
 *
 * claude-threads can drive different coding-agent CLIs (Claude Code, OpenAI
 * Codex). Each backend is a process wrapper that emits a normalized event
 * stream shaped like Claude CLI stream-json events (`assistant`, `tool_use`,
 * `tool_result`, `result`, `system`), so the downstream pipeline (transformer,
 * MessageManager, executors) works unchanged regardless of which agent runs.
 *
 * The concrete event/content/option types live in src/claude/cli.ts (the
 * original home of the wire format); this module composes them into the
 * backend contract. The type imports are circular with claude/cli.ts but
 * type-only, so nothing exists at runtime.
 */

import type { EventEmitter } from 'events';
import type {
  ClaudeCliOptions,
  ClaudeEvent,
  StatusLineData,
} from '../claude/cli.js';

// Re-exported for backends that only need the shared wire types
export type { StatusLineData } from '../claude/cli.js';

/** Supported agent backends */
export type AgentType = 'claude' | 'codex';

/**
 * Normalized agent event. Shaped like Claude CLI stream-json events;
 * non-Claude backends synthesize events in this shape.
 */
export type AgentEvent = ClaudeEvent;

/** Codex-specific settings (from config.yaml `codex:` block) */
export interface CodexAgentConfig {
  /** Custom path to the codex binary (default: `codex`, or CODEX_PATH env) */
  path?: string;
  /** Model override passed to thread/start (default: codex's configured model) */
  model?: string;
  /** Sandbox mode used when permissions are bypassed (default: workspace-write) */
  sandbox?: 'workspace-write' | 'danger-full-access';
}

/**
 * Options for creating an agent backend via the factory.
 * Extends the Claude CLI option set; Codex ignores the Claude-only fields
 * (chrome, platformConfig, account, uploadDir, ...).
 */
export interface AgentBackendOptions extends ClaudeCliOptions {
  agentType: AgentType;
  codex?: CodexAgentConfig;
}

/**
 * Common interface implemented by all agent process wrappers.
 *
 * Events emitted:
 * - 'event' (AgentEvent) — normalized agent event
 * - 'exit' (code: number) — process exited
 * - 'error' (Error) — process spawn/runtime error
 * - 'status' (StatusLineData) — status line update (Claude only)
 */
export interface AgentBackend extends EventEmitter {
  readonly agentType: AgentType;

  start(): void;
  sendMessage(content: string): void;
  isRunning(): boolean;
  /** Kill the agent process; resolves when it has exited */
  kill(): Promise<void>;
  /** Interrupt current processing without killing the process; true if a process was signaled */
  interrupt(): boolean;

  /** Whether the last failure is permanent (retrying resume won't help) */
  isPermanentFailure(): boolean;
  /** Human-readable description of a permanent failure, or null */
  getPermanentFailureReason(): string | null;

  /** Latest context/usage data from the status line (Claude only; null otherwise) */
  getStatusData(): StatusLineData | null;

  /**
   * Answer a pending in-process permission request (Codex only).
   * Claude permissions flow through the MCP permission server instead.
   */
  respondToPermission?(toolUseId: string, decision: 'allow' | 'allow_session' | 'deny'): void;
}
