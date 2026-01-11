/**
 * Chrome tool formatter
 *
 * Handles Claude in Chrome browser automation tools:
 * - computer (screenshot, click, type, scroll, etc.)
 * - navigate
 * - tabs_context_mcp, tabs_create_mcp
 * - read_page, find, form_input
 * - get_page_text, javascript_tool
 * - gif_creator
 */

import type { ToolFormatter, ToolFormatResult, ToolInput, ToolFormatOptions } from './types.js';
import { parseMcpToolName } from './utils.js';

// ---------------------------------------------------------------------------
// Chrome Tools Formatter
// ---------------------------------------------------------------------------

/**
 * Formatter for Claude in Chrome tools.
 */
export const chromeToolsFormatter: ToolFormatter = {
  toolNames: ['mcp__claude-in-chrome__*'],

  format(toolName: string, input: ToolInput, options: ToolFormatOptions): ToolFormatResult | null {
    const { formatter } = options;

    // Parse the MCP tool name
    const mcpParts = parseMcpToolName(toolName);
    if (!mcpParts || mcpParts.server !== 'claude-in-chrome') {
      return null;
    }

    const tool = mcpParts.tool;
    const action = (input.action as string) || '';
    const coord = input.coordinate as number[] | undefined;
    const url = (input.url as string) || '';
    const text = (input.text as string) || '';

    let detail = '';

    switch (tool) {
      case 'computer': {
        switch (action) {
          case 'screenshot':
            detail = 'screenshot';
            break;
          case 'left_click':
          case 'right_click':
          case 'double_click':
          case 'triple_click':
            detail = coord ? `${action} at (${coord[0]}, ${coord[1]})` : action;
            break;
          case 'type':
            detail = `type "${text.substring(0, 30)}${text.length > 30 ? '...' : ''}"`;
            break;
          case 'key':
            detail = `key ${text}`;
            break;
          case 'scroll':
            detail = `scroll ${input.scroll_direction || 'down'}`;
            break;
          case 'wait':
            detail = `wait ${input.duration}s`;
            break;
          default:
            detail = action || 'action';
        }
        return {
          display: `🌐 ${formatter.formatBold('Chrome')}[computer] ${formatter.formatCode(detail)}`,
        };
      }

      case 'navigate': {
        const displayUrl = url.substring(0, 50) + (url.length > 50 ? '...' : '');
        return {
          display: `🌐 ${formatter.formatBold('Chrome')}[navigate] ${formatter.formatCode(displayUrl)}`,
        };
      }

      case 'tabs_context_mcp':
        return {
          display: `🌐 ${formatter.formatBold('Chrome')}[tabs] reading context`,
        };

      case 'tabs_create_mcp':
        return {
          display: `🌐 ${formatter.formatBold('Chrome')}[tabs] creating new tab`,
        };

      case 'read_page': {
        const filter = input.filter === 'interactive' ? 'interactive elements' : 'accessibility tree';
        return {
          display: `🌐 ${formatter.formatBold('Chrome')}[read_page] ${filter}`,
        };
      }

      case 'find': {
        const query = (input.query as string) || '';
        return {
          display: `🌐 ${formatter.formatBold('Chrome')}[find] ${formatter.formatCode(query)}`,
        };
      }

      case 'form_input':
        return {
          display: `🌐 ${formatter.formatBold('Chrome')}[form_input] setting value`,
        };

      case 'get_page_text':
        return {
          display: `🌐 ${formatter.formatBold('Chrome')}[get_page_text] extracting content`,
        };

      case 'javascript_tool':
        return {
          display: `🌐 ${formatter.formatBold('Chrome')}[javascript] executing script`,
        };

      case 'gif_creator':
        return {
          display: `🌐 ${formatter.formatBold('Chrome')}[gif] ${action}`,
        };

      default:
        return {
          display: `🌐 ${formatter.formatBold('Chrome')}[${tool}]`,
        };
    }
  },
};
