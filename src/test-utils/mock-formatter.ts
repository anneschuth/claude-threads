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
    formatCodeBlock: (code: string, language?: string) => `\`\`\`${language || ''}\n${code}\n\`\`\`\n`,
    formatUserMention: (username: string) => `@${username}`,
    formatLink: (text: string, url: string) => `[${text}](${url})`,
    formatListItem: (text: string) => `- ${text}`,
    formatNumberedListItem: (num: number, text: string) => `${num}. ${text}`,
    formatBlockquote: (text: string) => `> ${text}`,
    formatHorizontalRule: () => '---',
    formatStrikethrough: (text: string) => `~~${text}~~`,
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
    formatMarkdown: (content: string) => content.replace(/\n{3,}/g, '\n\n'),
  };
}

/**
 * Pre-created mock formatter instance for simple test cases
 */
export const mockFormatter = createMockFormatter();
