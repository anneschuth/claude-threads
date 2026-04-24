/**
 * Platform-Agnostic Utilities
 *
 * Common utilities used across all platform implementations.
 * These should work regardless of the underlying chat platform.
 *
 * Benefits:
 * - DRY: Single implementation for common operations
 * - Consistency: Same behavior across platforms
 * - Testability: Platform-independent, easy to unit test
 */

// =============================================================================
// String Utilities
// =============================================================================

/**
 * Escape special regex characters in a string to prevent regex injection.
 *
 * @param string - The string to escape
 * @returns String with special regex characters escaped
 */
export function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Format a WebSocket error event into a readable string.
 *
 * Node's `ws` library and `undici` deliver two different shapes to `onerror`:
 * a plain `Error` (older) and a browser-style `ErrorEvent` wrapper with a
 * `.error` / `.message` field (newer). A template literal on the latter
 * produces the useless `[object ErrorEvent]`. Pull the first field that
 * carries signal and fall back to `String(x)`.
 */
export function formatWebSocketError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; error?: unknown; type?: unknown; code?: unknown };
    if (typeof e.message === 'string' && e.message) return e.message;
    if (e.error instanceof Error) return e.error.message;
    if (typeof e.error === 'string' && e.error) return e.error;
    if (typeof e.type === 'string' && e.type) {
      return typeof e.code === 'string' || typeof e.code === 'number'
        ? `${e.type} (code: ${e.code})`
        : e.type;
    }
  }
  return String(err);
}

// =============================================================================
// Platform Icons
// =============================================================================

/**
 * Get the display icon for a platform type.
 *
 * @param platformType - The platform type (slack, mattermost, etc.)
 * @returns Emoji icon for the platform
 */
export function getPlatformIcon(platformType: string): string {
  switch (platformType) {
    case 'slack':
      return '🆂 ';
    case 'mattermost':
      return '𝓜 ';
    default:
      return '💬 ';
  }
}

// =============================================================================
// Message Utilities
// =============================================================================

/**
 * Truncate a message safely, properly closing any open code blocks.
 * This prevents malformed markdown when truncating in the middle of a code block.
 *
 * @param message - The message to truncate
 * @param maxLength - Maximum allowed length
 * @param truncationIndicator - Text to append after truncation (default: '... (truncated)')
 * @returns Truncated message with properly closed code blocks
 */
export function truncateMessageSafely(
  message: string,
  maxLength: number,
  truncationIndicator = '... (truncated)'
): string {
  if (message.length <= maxLength) return message;

  // Leave room for closing code block (4 chars: \n```) and truncation indicator
  const reservedSpace = 4 + 2 + truncationIndicator.length; // 4 for \n```, 2 for \n\n
  let truncated = message.substring(0, maxLength - reservedSpace);

  // Check if we're inside an unclosed code block
  // Count ``` occurrences - odd number means we're inside a code block
  const codeBlockMarkers = (truncated.match(/```/g) || []).length;
  const isInsideCodeBlock = codeBlockMarkers % 2 === 1;

  if (isInsideCodeBlock) {
    // Close the code block before adding truncation message
    truncated += '\n```';
  }

  return truncated + '\n\n' + truncationIndicator;
}

// =============================================================================
// Emoji Utilities
// =============================================================================

/**
 * Normalize emoji names across platforms.
 * Different platforms use different names for the same emoji.
 *
 * @param emojiName - The emoji name from the platform
 * @returns Normalized emoji name
 */
export function normalizeEmojiName(emojiName: string): string {
  // Remove colons if present (Slack-style)
  const name = emojiName.replace(/^:|:$/g, '');

  // Common aliases
  const aliases: Record<string, string> = {
    'thumbsup': '+1',
    'thumbs_up': '+1',
    'thumbsdown': '-1',
    'thumbs_down': '-1',
    'heavy_check_mark': 'white_check_mark',
    'x': 'x',
    'cross_mark': 'x',
    'heavy_multiplication_x': 'x',
    'pause_button': 'pause',
    'double_vertical_bar': 'pause',
    'play_button': 'arrow_forward',
    'stop_button': 'stop',
    'octagonal_sign': 'stop',
    '1': 'one',
    '2': 'two',
    '3': 'three',
    '4': 'four',
    '5': 'five',
  };

  return aliases[name.toLowerCase()] ?? name;
}

/**
 * Mapping from Unicode emoji characters to shortcode names.
 * Used for converting Unicode emoji to platform-specific shortcodes.
 */
const EMOJI_UNICODE_TO_NAME: Record<string, string> = {
  '👍': '+1',
  '👎': '-1',
  '✅': 'white_check_mark',
  '❌': 'x',
  '⚠️': 'warning',
  '🛑': 'stop',
  '⏸️': 'pause',
  '▶️': 'arrow_forward',
  '1️⃣': 'one',
  '2️⃣': 'two',
  '3️⃣': 'three',
  '4️⃣': 'four',
  '5️⃣': 'five',
  '6️⃣': 'six',
  '7️⃣': 'seven',
  '8️⃣': 'eight',
  '9️⃣': 'nine',
  '🔟': 'keycap_ten',
  '0️⃣': 'zero',
  '🤖': 'robot',
  '⚙️': 'gear',
  '🔐': 'lock',
  '🔓': 'unlock',
  '📁': 'file_folder',
  '📄': 'page_facing_up',
  '📝': 'memo',
  '⏱️': 'stopwatch',
  '⏳': 'hourglass',
  '🌱': 'seedling',
  '🌲': 'evergreen_tree',
  '🌳': 'deciduous_tree',
  '🧵': 'thread',
  '🔄': 'arrows_counterclockwise',
  '📦': 'package',
  '🎉': 'partying_face',
  '🌿': 'herb',
  '👤': 'bust_in_silhouette',
  '📋': 'clipboard',
  '🔽': 'small_red_triangle_down',
  '🆕': 'new',
};

/**
 * Convert a Unicode emoji character to its shortcode name.
 *
 * Used for converting Unicode emoji to API-compatible names for reactions.
 * For example, '👍' → '+1', '👎' → '-1', '✅' → 'white_check_mark'
 *
 * If the input is already a shortcode name (not Unicode), it's returned as-is.
 *
 * @param emoji - The Unicode emoji character or shortcode name
 * @returns The shortcode name (without colons)
 */
export function getEmojiName(emoji: string): string {
  // If it's already in the name mapping, return the mapped name
  const mapped = EMOJI_UNICODE_TO_NAME[emoji];
  if (mapped) {
    return mapped;
  }
  // Otherwise assume it's already a name (or unknown emoji)
  return emoji;
}

// =============================================================================
// Slack Markdown Conversion
// =============================================================================

/**
 * Convert standard markdown to Slack mrkdwn format.
 *
 * Handles the following conversions:
 * - **bold** → *bold* (double asterisks to single)
 * - ## Heading → *Heading* (headers to bold, Slack has no native headers)
 * - [text](url) → <url|text> (standard links to Slack format)
 * - --- → ━━━━━━━━━━━━ (horizontal rules to unicode)
 * - Tables → list format (via convertMarkdownTablesToSlack)
 *
 * Note: Preserves code blocks (``` ```) without modification inside them.
 *
 * @param content - Content in standard markdown
 * @returns Content converted to Slack mrkdwn format
 */
export function convertMarkdownToSlack(content: string): string {
  // First, extract and preserve code blocks to avoid modifying their content
  const codeBlocks: string[] = [];
  const CODE_BLOCK_PLACEHOLDER = '\x00CODE_BLOCK_';

  // Preserve fenced code blocks (```...```)
  let preserved = content.replace(/```[\s\S]*?```/g, match => {
    const index = codeBlocks.length;
    codeBlocks.push(match);
    return `${CODE_BLOCK_PLACEHOLDER}${index}\x00`;
  });

  // Preserve inline code (`...`)
  preserved = preserved.replace(/`[^`\n]+`/g, match => {
    const index = codeBlocks.length;
    codeBlocks.push(match);
    return `${CODE_BLOCK_PLACEHOLDER}${index}\x00`;
  });

  // Convert markdown tables to Slack format
  preserved = convertMarkdownTablesToSlack(preserved);

  // Convert headers (## Heading) to bold (*Heading*)
  // Match 1-6 # characters at start of line, followed by space and text
  preserved = preserved.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // Convert bold (**text**) to Slack bold (*text*)
  // Must be careful not to break already-correct single asterisks
  preserved = preserved.replace(/\*\*([^*]+)\*\*/g, '*$1*');

  // Convert standard markdown links [text](url) to Slack format <url|text>
  preserved = preserved.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // Convert horizontal rules (---, ***, ___) to unicode line
  preserved = preserved.replace(/^[-*_]{3,}\s*$/gm, '━━━━━━━━━━━━━━━━━━━━');

  // Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    preserved = preserved.replace(`${CODE_BLOCK_PLACEHOLDER}${i}\x00`, codeBlocks[i]);
  }

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
  preserved = preserved.replace(/(?<=\n)```(?=\S)(?![a-zA-Z]*\n)/g, '```\n');

  return preserved;
}

/**
 * Convert markdown tables to a Slack-friendly list format.
 *
 * Markdown tables like:
 * | Header1 | Header2 |
 * |---------|---------|
 * | Cell1   | Cell2   |
 *
 * Become:
 * *Header1:* Cell1 · *Header2:* Cell2
 *
 * @param content - Content potentially containing markdown tables
 * @returns Content with tables converted to list format
 */
export function convertMarkdownTablesToSlack(content: string): string {
  // Match markdown tables: | Header | Header | \n |---| \n | Cell | Cell |
  const tableRegex = /^\|(.+)\|\s*\n\|[-:\s|]+\|\s*\n((?:\|.+\|\s*\n?)+)/gm;

  return content.replace(tableRegex, (_match, headerLine, bodyLines) => {
    // Parse headers
    const headers = headerLine
      .split('|')
      .map((h: string) => h.trim())
      .filter((h: string) => h);

    // Parse body rows
    const rows = bodyLines
      .trim()
      .split('\n')
      .map((row: string) =>
        row
          .split('|')
          .map((c: string) => c.trim())
          .filter((c: string) => c !== '')
      );

    // Convert to Slack format: *Header:* Value · *Header:* Value
    const formattedRows = rows.map((row: string[]) => {
      const cells = row.map((cell: string, i: number) => {
        const header = headers[i];
        return header ? `*${header}:* ${cell}` : cell;
      });
      return cells.join(' · ');
    });

    return formattedRows.join('\n');
  });
}
