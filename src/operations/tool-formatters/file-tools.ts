/**
 * File tool formatters - Read, Write, Edit, Glob, Grep
 *
 * These formatters handle file-related tools with support for:
 * - Path shortening (worktree and home directory)
 * - Diff previews for Edit operations
 * - Content previews for Write operations
 */

import * as Diff from 'diff';
import type { ToolFormatter, ToolFormatResult, ToolInput, ToolFormatOptions } from './types.js';
import { shortenPath, escapeCodeBlockContent } from './utils.js';

// ---------------------------------------------------------------------------
// File Tools Formatter
// ---------------------------------------------------------------------------

/**
 * Formatter for file-related tools.
 */
export const fileToolsFormatter: ToolFormatter = {
  toolNames: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],

  format(toolName: string, input: ToolInput, options: ToolFormatOptions): ToolFormatResult | null {
    const { formatter, detailed = false, maxPreviewLines = 20, worktreeInfo } = options;
    const short = (p: string) => shortenPath(p, undefined, worktreeInfo);

    switch (toolName) {
      case 'Read': {
        const filePath = short(input.file_path as string);
        return {
          display: `📄 ${formatter.formatBold('Read')} ${formatter.formatCode(filePath)}`,
          permissionText: `📄 ${formatter.formatBold('Read')} ${formatter.formatCode(filePath)}`,
        };
      }

      case 'Edit': {
        const filePath = short(input.file_path as string);
        const oldStr = (input.old_string as string) || '';
        const newStr = (input.new_string as string) || '';

        // Show diff if detailed mode and we have old/new strings
        if (detailed && (oldStr || newStr)) {
          const changes = Diff.diffLines(oldStr, newStr);
          const maxLines = maxPreviewLines;
          let lineCount = 0;
          const diffLines: string[] = [];

          for (const change of changes) {
            const lines = change.value.replace(/\n$/, '').split('\n');
            for (const line of lines) {
              if (lineCount >= maxLines) break;
              const escapedLine = escapeCodeBlockContent(line);
              if (change.added) {
                diffLines.push(`+ ${escapedLine}`);
                lineCount++;
              } else if (change.removed) {
                diffLines.push(`- ${escapedLine}`);
                lineCount++;
              } else {
                diffLines.push(`  ${escapedLine}`);
                lineCount++;
              }
            }
            if (lineCount >= maxLines) break;
          }

          const totalLines = changes.reduce(
            (sum, c) => sum + c.value.split('\n').length - 1,
            0
          );

          let display = `✏️ ${formatter.formatBold('Edit')} ${formatter.formatCode(filePath)}\n`;
          if (totalLines > maxLines) {
            display += formatter.formatCodeBlock(
              diffLines.join('\n') + `\n... (+${totalLines - maxLines} more lines)`,
              'diff'
            );
          } else {
            display += formatter.formatCodeBlock(diffLines.join('\n'), 'diff');
          }

          return {
            display,
            permissionText: `✏️ ${formatter.formatBold('Edit')} ${formatter.formatCode(filePath)}`,
            isDestructive: true,
          };
        }

        return {
          display: `✏️ ${formatter.formatBold('Edit')} ${formatter.formatCode(filePath)}`,
          permissionText: `✏️ ${formatter.formatBold('Edit')} ${formatter.formatCode(filePath)}`,
          isDestructive: true,
        };
      }

      case 'Write': {
        const filePath = short(input.file_path as string);
        const content = (input.content as string) || '';
        const lines = content.split('\n');
        const lineCount = lines.length;

        // Show preview if detailed mode
        if (detailed && content && lineCount > 0) {
          const maxLines = 6;
          const previewLines = lines.slice(0, maxLines).map(line => escapeCodeBlockContent(line));
          let display = `📝 ${formatter.formatBold('Write')} ${formatter.formatCode(filePath)} ${formatter.formatItalic(`(${lineCount} lines)`)}\n`;
          if (lineCount > maxLines) {
            display += formatter.formatCodeBlock(
              previewLines.join('\n') + `\n... (${lineCount - maxLines} more lines)`
            );
          } else {
            display += formatter.formatCodeBlock(previewLines.join('\n'));
          }
          return {
            display,
            permissionText: `📝 ${formatter.formatBold('Write')} ${formatter.formatCode(filePath)}`,
            isDestructive: true,
          };
        }

        return {
          display: `📝 ${formatter.formatBold('Write')} ${formatter.formatCode(filePath)}`,
          permissionText: `📝 ${formatter.formatBold('Write')} ${formatter.formatCode(filePath)}`,
          isDestructive: true,
        };
      }

      case 'Glob': {
        const pattern = input.pattern as string;
        return {
          display: `🔍 ${formatter.formatBold('Glob')} ${formatter.formatCode(pattern)}`,
          permissionText: `🔍 ${formatter.formatBold('Glob')} ${formatter.formatCode(pattern)}`,
        };
      }

      case 'Grep': {
        const pattern = input.pattern as string;
        return {
          display: `🔎 ${formatter.formatBold('Grep')} ${formatter.formatCode(pattern)}`,
          permissionText: `🔎 ${formatter.formatBold('Grep')} ${formatter.formatCode(pattern)}`,
        };
      }

      default:
        return null;
    }
  },
};
