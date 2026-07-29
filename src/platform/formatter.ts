/**
 * Platform-agnostic markdown formatter interface
 *
 * Platforms differ in their markdown dialect, so callers never emit
 * platform syntax directly — they go through this interface. Mattermost
 * (standard markdown: `**bold**`, `_italic_`, `@username`) is the only
 * implementation today.
 */
export interface PlatformFormatter {
  /**
   * Format text as bold
   * Mattermost: **text**
   */
  formatBold(text: string): string;

  /**
   * Format text as italic
   * Mattermost: _text_ or *text*
   */
  formatItalic(text: string): string;

  /**
   * Format text as inline code
   * Mattermost: `code`
   */
  formatCode(text: string): string;

  /**
   * Format text as code block with optional language
   * Mattermost: ```lang\ncode\n```
   */
  formatCodeBlock(code: string, language?: string): string;

  /**
   * Format a user mention
   * Mattermost: @username
   */
  formatUserMention(username: string, userId?: string): string;

  /**
   * Format a hyperlink
   * Mattermost: [text](url)
   */
  formatLink(text: string, url: string): string;

  /**
   * Format a bulleted list item
   * Mattermost: - item or * item
   */
  formatListItem(text: string): string;

  /**
   * Format a numbered list item
   * Mattermost: 1. item
   */
  formatNumberedListItem(number: number, text: string): string;

  /**
   * Format a blockquote
   * Mattermost: > text
   */
  formatBlockquote(text: string): string;

  /**
   * Format a horizontal rule
   * Mattermost: ---
   */
  formatHorizontalRule(): string;

  /**
   * Format a heading
   * Mattermost: # Heading (level 1), ## Heading (level 2), etc.
   */
  formatHeading(text: string, level: number): string;

  /**
   * Format text as strikethrough
   * Mattermost: ~~text~~
   */
  formatStrikethrough(text: string): string;

  /**
   * Escape special characters in text to prevent formatting
   */
  escapeText(text: string): string;

  /**
   * Format a table with headers and rows
   * Mattermost: Standard markdown table
   *
   * @param headers - Column headers
   * @param rows - Array of row data (each row is array of cell values)
   * @returns Formatted table string
   */
  formatTable(headers: string[], rows: string[][]): string;

  /**
   * Format a simple key-value list (for things like session headers)
   * Displays as a table on Mattermost
   *
   * @param items - Array of [icon, label, value] tuples
   * @returns Formatted key-value display
   */
  formatKeyValueList(items: [string, string, string][]): string;

  /**
   * Format markdown content for this platform.
   *
   * Converts standard markdown to the platform's native format.
   * This should be called on any content that may contain markdown
   * before posting to the platform.
   *
   * Mattermost: Mostly pass-through (standard markdown supported)
   *
   * @param content - Content in standard markdown
   * @returns Content formatted for this platform
   */
  formatMarkdown(content: string): string;
}
