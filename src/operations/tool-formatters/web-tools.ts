/**
 * Web tool formatters
 *
 * Handles web-related tools:
 * - WebFetch: Fetching URL content
 * - WebSearch: Web search queries
 */

import type { ToolFormatter, ToolFormatResult, ToolInput, ToolFormatOptions } from './types.js';

// ---------------------------------------------------------------------------
// Web Tools Formatter
// ---------------------------------------------------------------------------

/**
 * Formatter for web-related tools.
 */
export const webToolsFormatter: ToolFormatter = {
  toolNames: ['WebFetch', 'WebSearch'],

  format(toolName: string, input: ToolInput, options: ToolFormatOptions): ToolFormatResult | null {
    const { formatter } = options;

    switch (toolName) {
      case 'WebFetch': {
        const url = ((input.url as string) || '').substring(0, 40);
        return {
          display: `🌐 ${formatter.formatBold('Fetching')} ${formatter.formatCode(url)}`,
          permissionText: `🌐 ${formatter.formatBold('Fetching')} ${formatter.formatCode(url)}`,
        };
      }

      case 'WebSearch': {
        const query = (input.query as string) || '';
        return {
          display: `🔍 ${formatter.formatBold('Searching')} ${formatter.formatCode(query)}`,
          permissionText: `🔍 ${formatter.formatBold('Searching')} ${formatter.formatCode(query)}`,
        };
      }

      default:
        return null;
    }
  },
};
