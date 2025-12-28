/**
 * Tool formatting utilities for displaying Claude tool calls in Mattermost
 *
 * This module provides shared formatting logic used by both:
 * - src/claude/session.ts (main bot)
 * - src/mcp/permission-server.ts (MCP permission handler)
 */

import * as Diff from 'diff';

export interface ToolInput {
  [key: string]: unknown;
}

export interface FormatOptions {
  /** Include detailed previews (diffs, file content). Default: false */
  detailed?: boolean;
  /** Max command length for Bash. Default: 50 */
  maxCommandLength?: number;
  /** Max path display length. Default: 60 */
  maxPathLength?: number;
  /** Max lines to show in previews. Default: 20 for diff, 6 for content */
  maxPreviewLines?: number;
}

const DEFAULT_OPTIONS: Required<FormatOptions> = {
  detailed: false,
  maxCommandLength: 50,
  maxPathLength: 60,
  maxPreviewLines: 20,
};

/**
 * Shorten a file path for display by replacing home directory with ~
 */
export function shortenPath(path: string, homeDir?: string): string {
  if (!path) return '';
  const home = homeDir ?? process.env.HOME ?? '';
  if (home && path.startsWith(home)) {
    return '~' + path.slice(home.length);
  }
  return path;
}

/**
 * Check if a tool name is an MCP tool and extract server/tool parts
 */
export function parseMcpToolName(
  toolName: string
): { server: string; tool: string } | null {
  if (!toolName.startsWith('mcp__')) return null;

  const parts = toolName.split('__');
  if (parts.length < 3) return null;

  return {
    server: parts[1],
    tool: parts.slice(2).join('__'),
  };
}

/**
 * Format a tool use for display in Mattermost
 *
 * @param toolName - The name of the tool being called
 * @param input - The tool input parameters
 * @param options - Formatting options
 * @returns Formatted string or null if the tool should not be displayed
 */
export function formatToolUse(
  toolName: string,
  input: ToolInput,
  options: FormatOptions = {}
): string | null {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const short = (p: string) => shortenPath(p);

  switch (toolName) {
    case 'Read':
      return `📄 **Read** \`${short(input.file_path as string)}\``;

    case 'Edit': {
      const filePath = short(input.file_path as string);
      const oldStr = (input.old_string as string) || '';
      const newStr = (input.new_string as string) || '';

      // Show diff if detailed mode and we have old/new strings
      if (opts.detailed && (oldStr || newStr)) {
        const changes = Diff.diffLines(oldStr, newStr);
        const maxLines = opts.maxPreviewLines;
        let lineCount = 0;
        const diffLines: string[] = [];

        for (const change of changes) {
          const lines = change.value.replace(/\n$/, '').split('\n');
          for (const line of lines) {
            if (lineCount >= maxLines) break;
            if (change.added) {
              diffLines.push(`+ ${line}`);
              lineCount++;
            } else if (change.removed) {
              diffLines.push(`- ${line}`);
              lineCount++;
            } else {
              diffLines.push(`  ${line}`);
              lineCount++;
            }
          }
          if (lineCount >= maxLines) break;
        }

        const totalLines = changes.reduce(
          (sum, c) => sum + c.value.split('\n').length - 1,
          0
        );

        let diff = `✏️ **Edit** \`${filePath}\`\n\`\`\`diff\n`;
        diff += diffLines.join('\n');
        if (totalLines > maxLines) {
          diff += `\n... (+${totalLines - maxLines} more lines)`;
        }
        diff += '\n```';
        return diff;
      }
      return `✏️ **Edit** \`${filePath}\``;
    }

    case 'Write': {
      const filePath = short(input.file_path as string);
      const content = (input.content as string) || '';
      const lines = content.split('\n');
      const lineCount = lines.length;

      // Show preview if detailed mode
      if (opts.detailed && content && lineCount > 0) {
        const maxLines = 6;
        const previewLines = lines.slice(0, maxLines);
        let preview = `📝 **Write** \`${filePath}\` *(${lineCount} lines)*\n\`\`\`\n`;
        preview += previewLines.join('\n');
        if (lineCount > maxLines) {
          preview += `\n... (${lineCount - maxLines} more lines)`;
        }
        preview += '\n```';
        return preview;
      }
      return `📝 **Write** \`${filePath}\``;
    }

    case 'Bash': {
      const cmd = ((input.command as string) || '').substring(
        0,
        opts.maxCommandLength
      );
      const truncated = cmd.length >= opts.maxCommandLength;
      return `💻 **Bash** \`${cmd}${truncated ? '...' : ''}\``;
    }

    case 'Glob':
      return `🔍 **Glob** \`${input.pattern}\``;

    case 'Grep':
      return `🔎 **Grep** \`${input.pattern}\``;

    case 'Task':
      return null; // Handled specially with subagent display

    case 'EnterPlanMode':
      return `📋 **Planning...**`;

    case 'ExitPlanMode':
      return null; // Handled specially with approval buttons

    case 'AskUserQuestion':
      return null; // Don't show, the question text follows

    case 'TodoWrite':
      return null; // Handled specially with task list display

    case 'WebFetch': {
      const url = ((input.url as string) || '').substring(0, 40);
      return `🌐 **Fetching** \`${url}\``;
    }

    case 'WebSearch':
      return `🔍 **Searching** \`${input.query}\``;

    default: {
      // Handle MCP tools: mcp__server__tool
      const mcpParts = parseMcpToolName(toolName);
      if (mcpParts) {
        return `🔌 **${mcpParts.tool}** *(${mcpParts.server})*`;
      }
      return `● **${toolName}**`;
    }
  }
}

/**
 * Format tool info for permission prompts (simpler format)
 *
 * @param toolName - The name of the tool
 * @param input - The tool input parameters
 * @returns Formatted string for permission prompts
 */
export function formatToolForPermission(
  toolName: string,
  input: ToolInput
): string {
  const short = (p: string) => shortenPath(p);

  switch (toolName) {
    case 'Read':
      return `📄 **Read** \`${short(input.file_path as string)}\``;
    case 'Write':
      return `📝 **Write** \`${short(input.file_path as string)}\``;
    case 'Edit':
      return `✏️ **Edit** \`${short(input.file_path as string)}\``;
    case 'Bash': {
      const cmd = ((input.command as string) || '').substring(0, 100);
      return `💻 **Bash** \`${cmd}${cmd.length >= 100 ? '...' : ''}\``;
    }
    default: {
      const mcpParts = parseMcpToolName(toolName);
      if (mcpParts) {
        return `🔌 **${mcpParts.tool}** *(${mcpParts.server})*`;
      }
      return `● **${toolName}**`;
    }
  }
}
