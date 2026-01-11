/**
 * Tool Formatter Registry
 *
 * This module provides a plugin-based system for formatting tool calls
 * in chat platforms. Each tool (or group of tools) can register a
 * formatter that knows how to display it.
 *
 * Usage:
 * ```typescript
 * import { toolFormatterRegistry } from './operations/tool-formatters';
 *
 * const result = toolFormatterRegistry.format('Read', { file_path: '/foo/bar.ts' }, {
 *   formatter: platformFormatter,
 *   detailed: true,
 * });
 *
 * console.log(result.display); // "📄 **Read** `~/bar.ts`"
 * ```
 */

// Export types
export type {
  ToolFormatOptions,
  ToolFormatResult,
  ToolInput,
  ToolFormatter,
  ToolFormatterRegistryInterface,
  WorktreeContext,
} from './types.js';

// Export utilities
export {
  shortenPath,
  parseMcpToolName,
  escapeRegExp,
  truncateWithEllipsis,
  escapeCodeBlockContent,
} from './utils.js';

export type { McpToolParts } from './utils.js';

// Export registry class and instance
export { ToolFormatterRegistry, toolFormatterRegistry } from './registry.js';

// Export individual formatters (for testing and customization)
export { fileToolsFormatter } from './file-tools.js';
export { bashToolFormatter } from './bash-tools.js';
export { taskToolsFormatter } from './task-tools.js';
export { chromeToolsFormatter } from './chrome-tools.js';
export { webToolsFormatter } from './web-tools.js';

// ---------------------------------------------------------------------------
// Register all built-in formatters
// ---------------------------------------------------------------------------

import { toolFormatterRegistry } from './registry.js';
import { fileToolsFormatter } from './file-tools.js';
import { bashToolFormatter } from './bash-tools.js';
import { taskToolsFormatter } from './task-tools.js';
import { chromeToolsFormatter } from './chrome-tools.js';
import { webToolsFormatter } from './web-tools.js';

// Register all formatters with the default registry
toolFormatterRegistry.register(fileToolsFormatter);
toolFormatterRegistry.register(bashToolFormatter);
toolFormatterRegistry.register(taskToolsFormatter);
toolFormatterRegistry.register(chromeToolsFormatter);
toolFormatterRegistry.register(webToolsFormatter);

// ---------------------------------------------------------------------------
// Backward-compatible wrapper functions
// These match the old tool-formatter.ts API for easier migration
// ---------------------------------------------------------------------------

import type { PlatformFormatter } from '../../platform/formatter.js';
import type { ToolInput } from './types.js';

export interface FormatOptions {
  /** Include detailed previews (diffs, file content). Default: false */
  detailed?: boolean;
  /** Max command length for Bash. Default: 50 */
  maxCommandLength?: number;
  /** Max path display length. Default: 60 */
  maxPathLength?: number;
  /** Max lines to show in previews. Default: 20 for diff, 6 for content */
  maxPreviewLines?: number;
  /** Worktree info for shortening paths (if session is in a worktree) */
  worktreeInfo?: { path: string; branch: string };
}

/**
 * Format a tool use for display in chat platforms.
 * Backward-compatible wrapper around toolFormatterRegistry.format().
 *
 * @param toolName - The name of the tool being called
 * @param input - The tool input parameters
 * @param formatter - Platform-specific markdown formatter
 * @param options - Formatting options
 * @returns Formatted string or null if the tool should not be displayed
 */
export function formatToolUse(
  toolName: string,
  input: ToolInput,
  formatter: PlatformFormatter,
  options: FormatOptions = {}
): string | null {
  const result = toolFormatterRegistry.format(toolName, input, {
    formatter,
    detailed: options.detailed ?? false,
    maxCommandLength: options.maxCommandLength,
    maxPreviewLines: options.maxPreviewLines,
    worktreeInfo: options.worktreeInfo,
  });

  // Return null for hidden tools (Task, TodoWrite, etc.)
  if (!result.display) return null;

  return result.display;
}

/**
 * Format tool info for permission prompts (simpler format).
 * Backward-compatible wrapper around toolFormatterRegistry.format().
 *
 * @param toolName - The name of the tool
 * @param input - The tool input parameters
 * @param formatter - Platform-specific markdown formatter
 * @param options - Formatting options (including worktreeInfo for path shortening)
 * @returns Formatted string for permission prompts
 */
export function formatToolForPermission(
  toolName: string,
  input: ToolInput,
  formatter: PlatformFormatter,
  options: FormatOptions = {}
): string {
  const result = toolFormatterRegistry.format(toolName, input, {
    formatter,
    detailed: false, // Permission prompts are never detailed
    worktreeInfo: options.worktreeInfo,
  });

  return result.permissionText ?? toolName;
}
