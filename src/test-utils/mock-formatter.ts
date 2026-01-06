/**
 * Shared mock formatter for tests
 *
 * Provides a Mattermost-style formatter that can be used across all test files.
 * This avoids duplicating the mock formatter in every test file.
 */

import type { PlatformFormatter } from '../platform/formatter.js';

/**
 * Create a mock formatter for testing (Mattermost-style markdown)
 */
export function createMockFormatter(): PlatformFormatter {
  return {
    formatBold: (text: string) => `**${text}**`,
    formatItalic: (text: string) => `_${text}_`,
    formatCode: (text: string) => `\`${text}\``,
    formatCodeBlock: (code: string, language?: string) => `\`\`\`${language || ''}\n${code}\n\`\`\``,
    formatUserMention: (username: string) => `@${username}`,
    formatLink: (text: string, url: string) => `[${text}](${url})`,
    formatListItem: (text: string) => `- ${text}`,
    formatNumberedListItem: (num: number, text: string) => `${num}. ${text}`,
    formatBlockquote: (text: string) => `> ${text}`,
    formatHorizontalRule: () => '---',
    formatHeading: (text: string, level: number) => `${'#'.repeat(level)} ${text}`,
    escapeText: (text: string) => text.replace(/([*_`[\]()#+\-.!])/g, '\\$1'),
    formatTable: (headers: string[], rows: string[][]) => {
      const headerRow = `| ${headers.join(' | ')} |`;
      const separatorRow = `| ${headers.map(() => '---').join(' | ')} |`;
      const dataRows = rows.map(row => `| ${row.join(' | ')} |`);
      return [headerRow, separatorRow, ...dataRows].join('\n');
    },
    formatKeyValueList: (items: [string, string, string][]) => {
      const rows = items.map(([icon, label, value]) => `| ${icon} **${label}** | ${value} |`);
      return ['| | |', '|---|---|', ...rows].join('\n');
    },
  };
}

/**
 * Pre-created mock formatter instance for simple test cases
 */
export const mockFormatter = createMockFormatter();

/**
 * Create a Slack-style mock formatter for testing
 */
export function createSlackMockFormatter(): PlatformFormatter {
  return {
    formatBold: (text: string) => `*${text}*`,
    formatItalic: (text: string) => `_${text}_`,
    formatCode: (text: string) => `\`${text}\``,
    formatCodeBlock: (code: string, _language?: string) => `\`\`\`\n${code}\n\`\`\``,
    formatUserMention: (username: string, userId?: string) => userId ? `<@${userId}>` : `@${username}`,
    formatLink: (text: string, url: string) => `<${url}|${text}>`,
    formatListItem: (text: string) => `- ${text}`,
    formatNumberedListItem: (num: number, text: string) => `${num}. ${text}`,
    formatBlockquote: (text: string) => `> ${text}`,
    formatHorizontalRule: () => '━━━━━━━━━━━━━━━━━━━━',
    formatHeading: (text: string, _level: number) => `*${text}*`,
    escapeText: (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    formatTable: (headers: string[], rows: string[][]) => {
      const lines: string[] = [];
      for (const row of rows) {
        const items = row.map((cell, i) => {
          const header = headers[i];
          return header ? `*${header}:* ${cell}` : cell;
        });
        lines.push(items.join(' · '));
      }
      return lines.join('\n');
    },
    formatKeyValueList: (items: [string, string, string][]) => {
      return items.map(([icon, label, value]) => `${icon} *${label}:* ${value}`).join('\n');
    },
  };
}

/**
 * Pre-created Slack mock formatter instance
 */
export const slackMockFormatter = createSlackMockFormatter();
