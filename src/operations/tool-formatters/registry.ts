/**
 * ToolFormatterRegistry - Plugin system for tool display formatting
 *
 * This registry allows tool formatters to be registered and looked up
 * by tool name. It supports exact matches and wildcard patterns.
 */

import type {
  ToolFormatter,
  ToolFormatterRegistryInterface,
  ToolFormatOptions,
  ToolFormatResult,
  ToolInput,
} from './types.js';
import { parseMcpToolName } from './utils.js';

// ---------------------------------------------------------------------------
// Registry Implementation
// ---------------------------------------------------------------------------

/**
 * Registry for tool formatters.
 * Provides plugin-based formatting for Claude tool calls.
 */
export class ToolFormatterRegistry implements ToolFormatterRegistryInterface {
  /** Map of exact tool names to formatters */
  private exactMatchers = new Map<string, ToolFormatter>();

  /** List of wildcard patterns and their formatters */
  private wildcardMatchers: Array<{ pattern: RegExp; formatter: ToolFormatter }> = [];

  /**
   * Register a formatter for one or more tools.
   *
   * @param formatter - The formatter to register
   */
  register(formatter: ToolFormatter): void {
    for (const toolName of formatter.toolNames) {
      if (toolName.includes('*')) {
        // Convert glob pattern to regex
        const pattern = new RegExp(
          '^' + toolName.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
        );
        this.wildcardMatchers.push({ pattern, formatter });
      } else {
        this.exactMatchers.set(toolName, formatter);
      }
    }
  }

  /**
   * Find the formatter for a tool.
   *
   * @param toolName - The tool name
   * @returns The formatter, or undefined if not found
   */
  private findFormatter(toolName: string): ToolFormatter | undefined {
    // Check exact match first
    const exact = this.exactMatchers.get(toolName);
    if (exact) return exact;

    // Check wildcard patterns
    for (const { pattern, formatter } of this.wildcardMatchers) {
      if (pattern.test(toolName)) {
        return formatter;
      }
    }

    return undefined;
  }

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
  ): ToolFormatResult {
    const formatter = this.findFormatter(toolName);

    if (formatter) {
      const result = formatter.format(toolName, input, options);
      if (result) return result;
    }

    // Fallback to generic formatting
    return this.formatGeneric(toolName, options);
  }

  /**
   * Generic fallback formatting for unknown tools.
   */
  private formatGeneric(toolName: string, options: ToolFormatOptions): ToolFormatResult {
    const { formatter } = options;

    // Check if it's an MCP tool
    const mcpParts = parseMcpToolName(toolName);
    if (mcpParts) {
      return {
        display: `🔌 ${formatter.formatBold(mcpParts.tool)} ${formatter.formatItalic(`(${mcpParts.server})`)}`,
        permissionText: `🔌 ${formatter.formatBold(mcpParts.tool)} ${formatter.formatItalic(`(${mcpParts.server})`)}`,
      };
    }

    // Unknown tool - generic format
    return {
      display: `● ${formatter.formatBold(toolName)}`,
      permissionText: `● ${formatter.formatBold(toolName)}`,
    };
  }

  /**
   * Check if a formatter is registered for a tool.
   *
   * @param toolName - The tool name to check
   */
  hasFormatter(toolName: string): boolean {
    return this.findFormatter(toolName) !== undefined;
  }

  /**
   * Clear all registered formatters.
   * Useful for testing.
   */
  clear(): void {
    this.exactMatchers.clear();
    this.wildcardMatchers = [];
  }
}

// ---------------------------------------------------------------------------
// Singleton Instance
// ---------------------------------------------------------------------------

/**
 * Default tool formatter registry.
 * Formatters are registered by importing the formatter modules.
 */
export const toolFormatterRegistry = new ToolFormatterRegistry();
