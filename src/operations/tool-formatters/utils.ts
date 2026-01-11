/**
 * Utility functions for tool formatters
 *
 * These utilities are shared across different tool formatters.
 */

import type { WorktreeContext } from './types.js';

// ---------------------------------------------------------------------------
// Path Utilities
// ---------------------------------------------------------------------------

/**
 * Shorten a file path for display by replacing home directory with ~
 * and simplifying worktree paths to show just the branch name.
 *
 * @param path - The file path to shorten
 * @param homeDir - Optional home directory override (defaults to process.env.HOME)
 * @param worktreeInfo - Optional worktree context for reliable path shortening
 */
export function shortenPath(
  path: string,
  homeDir?: string,
  worktreeInfo?: WorktreeContext
): string {
  if (!path) return '';

  // If we have worktree context, use it for reliable path shortening
  if (worktreeInfo?.path && worktreeInfo?.branch) {
    const worktreePath = worktreeInfo.path.endsWith('/')
      ? worktreeInfo.path
      : worktreeInfo.path + '/';
    if (path.startsWith(worktreePath)) {
      const relativePath = path.slice(worktreePath.length);
      return `[${worktreeInfo.branch}]/${relativePath}`;
    }
    // Also check without trailing slash for exact match
    if (path === worktreeInfo.path) {
      return `[${worktreeInfo.branch}]/`;
    }
  }

  const home = homeDir ?? process.env.HOME ?? '';
  if (home && path.startsWith(home)) {
    return '~' + path.slice(home.length);
  }
  return path;
}

// ---------------------------------------------------------------------------
// MCP Tool Parsing
// ---------------------------------------------------------------------------

/**
 * Result of parsing an MCP tool name.
 */
export interface McpToolParts {
  /** The MCP server name */
  server: string;
  /** The tool name within the server */
  tool: string;
}

/**
 * Check if a tool name is an MCP tool and extract server/tool parts.
 *
 * MCP tools have the format: mcp__server__tool
 *
 * @param toolName - The tool name to parse
 * @returns Parsed parts, or null if not an MCP tool
 */
export function parseMcpToolName(toolName: string): McpToolParts | null {
  if (!toolName.startsWith('mcp__')) return null;

  const parts = toolName.split('__');
  if (parts.length < 3) return null;

  return {
    server: parts[1],
    tool: parts.slice(2).join('__'),
  };
}

// ---------------------------------------------------------------------------
// String Utilities
// ---------------------------------------------------------------------------

/**
 * Escape special regex characters in a string.
 *
 * @param string - The string to escape
 * @returns Escaped string safe for use in RegExp
 */
export function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Truncate a string to a maximum length with ellipsis.
 *
 * @param str - The string to truncate
 * @param maxLength - Maximum length
 * @returns Truncated string
 */
export function truncateWithEllipsis(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength) + '...';
}

/**
 * Escape triple backticks in code block content.
 * This prevents breaking outer code blocks in markdown.
 *
 * @param content - The content to escape
 * @returns Content with escaped backticks
 */
export function escapeCodeBlockContent(content: string): string {
  return content.replace(/```/g, '` ``');
}
