/**
 * Playwright MCP tool formatter
 *
 * Handles formatting of Playwright browser automation tools:
 * - browser_navigate: Navigate to URL
 * - browser_take_screenshot: Capture screenshot
 * - browser_wait_for: Wait for time/selector
 * - browser_close: Close browser
 * - browser_run_code: Execute code in browser
 */

import type { ToolFormatter, ToolFormatResult, ToolInput, ToolFormatOptions } from './types.js';
import { parseMcpToolName, truncateWithEllipsis } from './utils.js';

// ---------------------------------------------------------------------------
// Playwright Tools Formatter
// ---------------------------------------------------------------------------

/**
 * Formatter for Playwright MCP tools (mcp__playwright__*).
 */
export const playwrightToolsFormatter: ToolFormatter = {
  toolNames: ['mcp__playwright__*'],

  format(toolName: string, input: ToolInput, options: ToolFormatOptions): ToolFormatResult | null {
    const mcpParts = parseMcpToolName(toolName);
    if (!mcpParts || mcpParts.server !== 'playwright') return null;

    const { formatter } = options;
    const tool = mcpParts.tool;

    switch (tool) {
      case 'browser_navigate': {
        const url = (input.url as string) || '';
        // Extract domain from URL for display
        let domain = url;
        try {
          domain = new URL(url).hostname;
        } catch {
          domain = truncateWithEllipsis(url, 40);
        }

        return {
          display: `🎭 ${formatter.formatBold('Playwright')} navigate → ${formatter.formatCode(domain)}`,
          permissionText: `🎭 ${formatter.formatBold('Playwright')} navigate → ${formatter.formatCode(domain)}`,
        };
      }

      case 'browser_take_screenshot': {
        const filename = (input.filename as string) || 'screenshot';
        const fullPage = input.fullPage as boolean | undefined;
        const details = fullPage ? ' (full page)' : '';

        return {
          display: `🎭 ${formatter.formatBold('Playwright')} screenshot ${formatter.formatCode(filename)}${details}`,
          permissionText: `🎭 ${formatter.formatBold('Playwright')} screenshot`,
        };
      }

      case 'browser_wait_for': {
        const time = input.time as number | undefined;
        const selector = input.selector as string | undefined;

        let waitFor = '';
        if (time) waitFor = `${time}ms`;
        else if (selector) waitFor = truncateWithEllipsis(selector, 30);
        else waitFor = 'condition';

        return {
          display: `🎭 ${formatter.formatBold('Playwright')} wait ${formatter.formatCode(waitFor)}`,
          permissionText: `🎭 ${formatter.formatBold('Playwright')} wait`,
        };
      }

      case 'browser_close': {
        return {
          display: `🎭 ${formatter.formatBold('Playwright')} close browser`,
          permissionText: `🎭 ${formatter.formatBold('Playwright')} close`,
        };
      }

      case 'browser_run_code': {
        const code = (input.code as string) || '';
        const preview = truncateWithEllipsis(code.split('\n')[0] || '', 40);

        return {
          display: `🎭 ${formatter.formatBold('Playwright')} run ${formatter.formatCode(preview)}`,
          permissionText: `🎭 ${formatter.formatBold('Playwright')} run code`,
          isDestructive: true,
        };
      }

      default: {
        // Generic fallback for unknown Playwright tools
        return {
          display: `🎭 ${formatter.formatBold('Playwright')} ${formatter.formatCode(tool)}`,
          permissionText: `🎭 ${formatter.formatBold('Playwright')} ${tool}`,
        };
      }
    }
  },
};
