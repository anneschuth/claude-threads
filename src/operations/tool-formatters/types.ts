/**
 * Types for the ToolFormatterRegistry system
 *
 * This module defines the interfaces and types for the plugin-based
 * tool formatting system. Each tool (or group of tools) can register
 * a formatter that knows how to display it in chat.
 */

import type { PlatformFormatter } from '../../platform/formatter.js';

// ---------------------------------------------------------------------------
// Worktree Context
// ---------------------------------------------------------------------------

/**
 * Worktree context for path shortening.
 */
export interface WorktreeContext {
  /** Full path to the worktree */
  path: string;
  /** Branch name for display */
  branch: string;
}

// ---------------------------------------------------------------------------
// Format Options
// ---------------------------------------------------------------------------

/**
 * Options passed to tool formatters.
 */
export interface ToolFormatOptions {
  /** Platform-specific markdown formatter */
  formatter: PlatformFormatter;
  /** Include detailed previews (diffs, file content). Default: false */
  detailed?: boolean;
  /** Max command length for Bash. Default: 50 */
  maxCommandLength?: number;
  /** Max path display length. Default: 60 */
  maxPathLength?: number;
  /** Max lines to show in previews. Default: 20 for diff, 6 for content */
  maxPreviewLines?: number;
  /** Worktree info for shortening paths */
  worktreeInfo?: WorktreeContext;
}

// ---------------------------------------------------------------------------
// Format Result
// ---------------------------------------------------------------------------

/**
 * Result of formatting a tool for display.
 */
export interface ToolFormatResult {
  /**
   * Display text for the tool (shown during execution).
   * null means the tool should not be displayed (handled specially).
   */
  display: string | null;

  /**
   * Text for permission prompts (shorter, focused on what needs approval).
   * Falls back to display if not provided.
   */
  permissionText?: string;

  /**
   * Whether this tool is potentially destructive.
   * Can be used to highlight risky operations.
   */
  isDestructive?: boolean;

  /**
   * Whether this tool should be hidden from display.
   * Some tools (like TodoWrite) have custom display handling.
   */
  hidden?: boolean;
}

// ---------------------------------------------------------------------------
// Tool Input
// ---------------------------------------------------------------------------

/**
 * Generic tool input type.
 * Tool inputs are key-value objects from Claude's tool_use events.
 */
export interface ToolInput {
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Formatter Interface
// ---------------------------------------------------------------------------

/**
 * Interface for a tool formatter.
 * Each formatter handles one or more tools.
 */
export interface ToolFormatter {
  /**
   * Tool names this formatter handles.
   * Can include wildcards (e.g., 'mcp__claude-in-chrome__*').
   */
  readonly toolNames: string[];

  /**
   * Format a tool use for display.
   *
   * @param toolName - The name of the tool being called
   * @param input - The tool input parameters
   * @param options - Formatting options
   * @returns Format result, or null if formatter doesn't handle this tool
   */
  format(
    toolName: string,
    input: ToolInput,
    options: ToolFormatOptions
  ): ToolFormatResult | null;
}

// ---------------------------------------------------------------------------
// Registry Interface
// ---------------------------------------------------------------------------

/**
 * Interface for the tool formatter registry.
 */
export interface ToolFormatterRegistryInterface {
  /**
   * Register a formatter for one or more tools.
   *
   * @param formatter - The formatter to register
   */
  register(formatter: ToolFormatter): void;

  /**
   * Format a tool use.
   *
   * @param toolName - The name of the tool
   * @param input - The tool input parameters
   * @param options - Formatting options
   * @returns Format result (never null - falls back to generic format)
   */
  format(
    toolName: string,
    input: ToolInput,
    options: ToolFormatOptions
  ): ToolFormatResult;

  /**
   * Check if a formatter is registered for a tool.
   *
   * @param toolName - The tool name to check
   */
  hasFormatter(toolName: string): boolean;
}
