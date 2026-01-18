/**
 * Figma MCP tool formatter
 *
 * Handles formatting of Figma plugin tools:
 * - get_screenshot: Capture Figma node screenshot
 * - get_metadata: Get node metadata
 * - get_design_context: Get design context
 * - get_file: Get file info
 */

import type { ToolFormatter, ToolFormatResult, ToolInput, ToolFormatOptions } from './types.js';
import { parseMcpToolName } from './utils.js';

// ---------------------------------------------------------------------------
// Figma Tools Formatter
// ---------------------------------------------------------------------------

/**
 * Formatter for Figma MCP tools (mcp__plugin_figma_figma__* and mcp__figma__*).
 */
export const figmaToolsFormatter: ToolFormatter = {
  toolNames: ['mcp__plugin_figma_figma__*', 'mcp__figma__*'],

  format(toolName: string, input: ToolInput, options: ToolFormatOptions): ToolFormatResult | null {
    const mcpParts = parseMcpToolName(toolName);
    if (!mcpParts) return null;

    // Support both plugin_figma_figma and figma server names
    const isFigma = mcpParts.server === 'plugin_figma_figma' || mcpParts.server === 'figma';
    if (!isFigma) return null;

    const { formatter } = options;
    const tool = mcpParts.tool;

    // Extract common Figma inputs
    const fileKey = (input.fileKey as string) || '';
    const nodeId = (input.nodeId as string) || '';

    // Format node reference
    const nodeRef = nodeId ? `node:${nodeId.substring(0, 8)}` : fileKey.substring(0, 8) || 'design';

    switch (tool) {
      case 'get_screenshot': {
        return {
          display: `🎨 ${formatter.formatBold('Figma')} screenshot ${formatter.formatCode(nodeRef)}`,
          permissionText: `🎨 ${formatter.formatBold('Figma')} screenshot`,
        };
      }

      case 'get_metadata': {
        return {
          display: `🎨 ${formatter.formatBold('Figma')} metadata ${formatter.formatCode(nodeRef)}`,
          permissionText: `🎨 ${formatter.formatBold('Figma')} metadata`,
        };
      }

      case 'get_design_context': {
        return {
          display: `🎨 ${formatter.formatBold('Figma')} context ${formatter.formatCode(nodeRef)}`,
          permissionText: `🎨 ${formatter.formatBold('Figma')} context`,
        };
      }

      case 'get_file': {
        return {
          display: `🎨 ${formatter.formatBold('Figma')} file ${formatter.formatCode(fileKey.substring(0, 12) || 'unknown')}`,
          permissionText: `🎨 ${formatter.formatBold('Figma')} file`,
        };
      }

      default: {
        // Generic fallback for unknown Figma tools
        return {
          display: `🎨 ${formatter.formatBold('Figma')} ${formatter.formatCode(tool)}`,
          permissionText: `🎨 ${formatter.formatBold('Figma')} ${tool}`,
        };
      }
    }
  },
};
