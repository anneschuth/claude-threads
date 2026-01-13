import type { PlatformFormatter } from '../formatter.js';

/**
 * Mattermost markdown formatter
 *
 * Mattermost uses standard markdown syntax.
 */
export class MattermostFormatter implements PlatformFormatter {
  formatBold(text: string): string {
    return `**${text}**`;
  }

  formatItalic(text: string): string {
    return `_${text}_`;
  }

  formatCode(text: string): string {
    return `\`${text}\``;
  }

  formatCodeBlock(code: string, language?: string): string {
    const lang = language || '';
    // Add trailing newline to ensure proper rendering when followed by text
    return `\`\`\`${lang}\n${code}\n\`\`\`\n`;
  }

  formatUserMention(username: string): string {
    return `@${username}`;
  }

  formatLink(text: string, url: string): string {
    return `[${text}](${url})`;
  }

  formatListItem(text: string): string {
    return `- ${text}`;
  }

  formatNumberedListItem(number: number, text: string): string {
    return `${number}. ${text}`;
  }

  formatBlockquote(text: string): string {
    return `> ${text}`;
  }

  formatHorizontalRule(): string {
    return '---';
  }

  formatStrikethrough(text: string): string {
    return `~~${text}~~`;
  }

  formatHeading(text: string, level: number): string {
    const hashes = '#'.repeat(Math.min(Math.max(level, 1), 6));
    return `${hashes} ${text}`;
  }

  escapeText(text: string): string {
    // Escape markdown special characters
    return text.replace(/([*_`[\]()#+\-.!])/g, '\\$1');
  }

  formatTable(headers: string[], rows: string[][]): string {
    // Standard markdown table
    // Escape pipe characters in cells to prevent breaking table structure
    const escapeCell = (cell: string) => cell.replace(/\|/g, '\\|');
    const headerRow = `| ${headers.map(escapeCell).join(' | ')} |`;
    const separatorRow = `| ${headers.map(() => '---').join(' | ')} |`;
    const dataRows = rows.map(row => `| ${row.map(escapeCell).join(' | ')} |`);
    return [headerRow, separatorRow, ...dataRows].join('\n');
  }

  formatKeyValueList(items: [string, string, string][]): string {
    // Render as table with icon+label in first column, value in second
    // Escape pipe characters in labels and values to prevent breaking table structure
    const escapeCell = (cell: string) => cell.replace(/\|/g, '\\|');
    const rows = items.map(([icon, label, value]) => `| ${icon} ${this.formatBold(escapeCell(label))} | ${escapeCell(value)} |`);
    return ['| | |', '|---|---|', ...rows].join('\n');
  }

  formatMarkdown(content: string): string {
    // Mattermost supports standard markdown well, but we need to ensure
    // code blocks are properly terminated with a newline

    // Fix code blocks that have text immediately after the closing ```
    // This happens when Claude outputs code blocks without proper newlines
    //
    // The pattern distinguishes opening vs closing ```:
    // - Opening: at line start, followed by optional language identifier, then newline
    // - Closing: at line start (after code content), followed by newline or end of string
    //
    // We match ``` preceded by newline (closing marker), followed by a non-whitespace character
    // that isn't part of a language identifier pattern (which would indicate opening ```)
    // The (?=\S) ensures there IS something after ``` (not end of string or whitespace)
    let processed = content.replace(/(?<=\n)```(?=\S)(?![a-zA-Z]*\n)/g, '```\n');

    // Normalize excessive newlines
    processed = processed.replace(/\n{3,}/g, '\n\n');

    return processed;
  }
}
