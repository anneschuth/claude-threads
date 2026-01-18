/**
 * Context7 MCP tool formatter
 *
 * Handles formatting of Context7 documentation tools:
 * - resolve-library-id: Resolve library name to ID
 * - query-docs: Query library documentation
 * - get-library-docs: Get library documentation (legacy)
 */

import type { ToolFormatter, ToolFormatResult, ToolInput, ToolFormatOptions } from './types.js';
import { parseMcpToolName, truncateWithEllipsis } from './utils.js';

// ---------------------------------------------------------------------------
// Context7 Tools Formatter
// ---------------------------------------------------------------------------

/**
 * Formatter for Context7 MCP tools (mcp__plugin_context7_context7__*).
 */
export const context7ToolsFormatter: ToolFormatter = {
  toolNames: ['mcp__plugin_context7_context7__*'],

  format(toolName: string, input: ToolInput, options: ToolFormatOptions): ToolFormatResult | null {
    const mcpParts = parseMcpToolName(toolName);
    if (!mcpParts || mcpParts.server !== 'plugin_context7_context7') return null;

    const { formatter } = options;
    const tool = mcpParts.tool;

    switch (tool) {
      case 'resolve-library-id': {
        const libraryName = (input.libraryName as string) || '';
        const displayName = truncateWithEllipsis(libraryName, 30) || 'library';

        return {
          display: `📚 ${formatter.formatBold('Context7')} resolve ${formatter.formatCode(displayName)}`,
          permissionText: `📚 ${formatter.formatBold('Context7')} resolve library`,
        };
      }

      case 'query-docs': {
        const libraryId = (input.libraryId as string) || '';
        const query = (input.query as string) || '';

        // Extract library name from ID (e.g., "/vercel/next.js" -> "next.js")
        const libName = libraryId.split('/').pop() || libraryId;
        const displayQuery = truncateWithEllipsis(query, 25);

        return {
          display: `📚 ${formatter.formatBold('Context7')} ${formatter.formatCode(libName)} → ${formatter.formatCode(displayQuery)}`,
          permissionText: `📚 ${formatter.formatBold('Context7')} query docs`,
        };
      }

      case 'get-library-docs': {
        const libraryId = (input.context7CompatibleLibraryID as string) || '';
        const topic = (input.topic as string) || '';

        // Extract library name from ID
        const libName = libraryId.split('/').pop() || libraryId || 'library';
        const displayTopic = topic ? ` → ${truncateWithEllipsis(topic, 20)}` : '';

        return {
          display: `📚 ${formatter.formatBold('Context7')} ${formatter.formatCode(libName)}${displayTopic}`,
          permissionText: `📚 ${formatter.formatBold('Context7')} get docs`,
        };
      }

      default: {
        // Generic fallback for unknown Context7 tools
        return {
          display: `📚 ${formatter.formatBold('Context7')} ${formatter.formatCode(tool)}`,
          permissionText: `📚 ${formatter.formatBold('Context7')} ${tool}`,
        };
      }
    }
  },
};
