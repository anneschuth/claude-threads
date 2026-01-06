import type { PlatformFormatter } from '../formatter.js';
import { convertMarkdownToSlack } from '../utils.js';

/**
 * Slack mrkdwn formatter
 *
 * Slack uses its own "mrkdwn" syntax which differs from standard markdown:
 * - Bold: *text* (single asterisks)
 * - Italic: _text_
 * - Code: `code`
 * - Code blocks: ```code``` (language hints not well supported)
 * - User mentions: <@USER_ID>
 * - Links: <url|text>
 * - Special characters &, <, > must be escaped
 *
 * @see https://api.slack.com/reference/surfaces/formatting
 */
export class SlackFormatter implements PlatformFormatter {
  formatBold(text: string): string {
    return `*${text}*`;
  }

  formatItalic(text: string): string {
    return `_${text}_`;
  }

  formatCode(text: string): string {
    return `\`${text}\``;
  }

  formatCodeBlock(code: string, _language?: string): string {
    // Slack doesn't support language hints in code blocks well,
    // so we omit the language identifier
    return `\`\`\`\n${code}\n\`\`\``;
  }

  formatUserMention(username: string, userId?: string): string {
    // Slack strongly prefers user ID format for mentions
    if (userId) {
      return `<@${userId}>`;
    }
    // Fallback to @username if no ID available (won't create a real mention)
    return `@${username}`;
  }

  formatLink(text: string, url: string): string {
    return `<${url}|${text}>`;
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
    // Slack mrkdwn doesn't support --- as horizontal rule
    // Use unicode box drawing characters instead
    return '━━━━━━━━━━━━━━━━━━━━';
  }

  formatStrikethrough(text: string): string {
    // Slack uses single tildes for strikethrough
    // Problem: If the text contains ~ characters (e.g., ~/.config/path), Slack interprets
    // them as the end of strikethrough formatting, breaking the display.
    // Solution: Insert a zero-width space (U+200B) after each tilde in the content.
    // This breaks Slack's pattern matching for strikethrough delimiters while preserving
    // the actual ~ character for copy/paste. The zero-width space is invisible.
    const escapedText = text.replace(/~/g, '~\u200B');
    return `~${escapedText}~`;
  }

  formatHeading(text: string, _level: number): string {
    // Slack doesn't have real headings, so we use bold text
    // The level parameter is ignored since all "headings" are rendered the same
    return `*${text}*`;
  }

  escapeText(text: string): string {
    // Slack requires escaping &, <, and > characters
    // These have special meaning in Slack mrkdwn:
    // & - used for special sequences like &amp;
    // < - used for links, mentions, and special formatting
    // > - used for blockquotes
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  formatTable(headers: string[], rows: string[][]): string {
    // Slack doesn't support markdown tables, so format as structured list
    const lines: string[] = [];
    for (const row of rows) {
      const items = row.map((cell, i) => {
        const header = headers[i];
        return header ? `*${header}:* ${cell}` : cell;
      });
      lines.push(items.join(' · '));
    }
    return lines.join('\n');
  }

  formatKeyValueList(items: [string, string, string][]): string {
    // Render as indented list with icon, bold label, and value
    return items.map(([icon, label, value]) => `${icon} *${label}:* ${value}`).join('\n');
  }

  formatMarkdown(content: string): string {
    // Convert standard markdown to Slack mrkdwn format
    return convertMarkdownToSlack(content);
  }
}
