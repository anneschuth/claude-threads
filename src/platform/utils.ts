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
      return '🆂';
    case 'mattermost':
      return '𝓜';
    default:
      return '💬';
  }
}

// =============================================================================
// Message Utilities
// =============================================================================

/**
 * Truncate a message to fit within a maximum length.
 * Adds ellipsis if truncated.
 *
 * @param message - The message to truncate
 * @param maxLength - Maximum allowed length
 * @returns Truncated message
 */
export function truncateMessage(message: string, maxLength: number): string {
  if (message.length <= maxLength) return message;
  return message.substring(0, maxLength - 3) + '...';
}

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

/**
 * Split a long message into chunks at natural breakpoints.
 * Tries to break at paragraph boundaries, then sentence boundaries.
 *
 * @param content - The content to split
 * @param maxLength - Maximum length per chunk
 * @returns Array of message chunks
 */
export function splitMessage(content: string, maxLength: number): string[] {
  if (content.length <= maxLength) return [content];

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to find a good break point
    const breakPoint = findBreakPoint(remaining, maxLength);

    chunks.push(remaining.substring(0, breakPoint).trim());
    remaining = remaining.substring(breakPoint).trim();
  }

  return chunks;
}

/**
 * Find a natural break point in text.
 * Priority: paragraph > sentence > word > hard break
 */
function findBreakPoint(text: string, maxLength: number): number {
  const searchWindow = text.substring(0, maxLength);

  // Try paragraph break (double newline)
  const paragraphBreak = searchWindow.lastIndexOf('\n\n');
  if (paragraphBreak > maxLength * 0.5) {
    return paragraphBreak + 2;
  }

  // Try single newline
  const lineBreak = searchWindow.lastIndexOf('\n');
  if (lineBreak > maxLength * 0.7) {
    return lineBreak + 1;
  }

  // Try sentence break
  const sentenceBreaks = ['. ', '! ', '? '];
  for (const sep of sentenceBreaks) {
    const idx = searchWindow.lastIndexOf(sep);
    if (idx > maxLength * 0.5) {
      return idx + sep.length;
    }
  }

  // Try word break (space)
  const spaceBreak = searchWindow.lastIndexOf(' ');
  if (spaceBreak > maxLength * 0.5) {
    return spaceBreak + 1;
  }

  // Hard break at max length
  return maxLength;
}

// =============================================================================
// Mention Utilities
// =============================================================================

/**
 * Extract usernames mentioned in a message.
 * Handles common mention formats: @username, <@userid>
 *
 * @param message - The message to parse
 * @returns Array of mentioned usernames/IDs
 */
export function extractMentions(message: string): string[] {
  const mentions: string[] = [];

  // Pattern: @username (word characters)
  const atPattern = /@(\w+)/g;
  let match;
  while ((match = atPattern.exec(message)) !== null) {
    mentions.push(match[1]);
  }

  // Pattern: <@USERID> (Slack-style)
  const slackPattern = /<@([A-Z0-9]+)>/g;
  while ((match = slackPattern.exec(message)) !== null) {
    mentions.push(match[1]);
  }

  return [...new Set(mentions)]; // Deduplicate
}

/**
 * Check if a message mentions a specific user.
 *
 * @param message - The message to check
 * @param usernameOrId - Username or user ID to look for
 * @returns True if the user is mentioned
 */
export function isMentioned(message: string, usernameOrId: string): boolean {
  const mentions = extractMentions(message);
  return mentions.some(m =>
    m.toLowerCase() === usernameOrId.toLowerCase()
  );
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
 * Mapping from emoji shortcode names to Unicode characters.
 * Used for converting shortcode names to display emoji.
 */
const EMOJI_NAME_TO_UNICODE: Record<string, string> = {
  '+1': '👍',
  '-1': '👎',
  'white_check_mark': '✅',
  'x': '❌',
  'warning': '⚠️',
  'stop': '🛑',
  'pause': '⏸️',
  'arrow_forward': '▶️',
  'one': '1️⃣',
  'two': '2️⃣',
  'three': '3️⃣',
  'four': '4️⃣',
  'five': '5️⃣',
  'six': '6️⃣',
  'seven': '7️⃣',
  'eight': '8️⃣',
  'nine': '9️⃣',
  'keycap_ten': '🔟',
  'zero': '0️⃣',
  'robot': '🤖',
  'gear': '⚙️',
  'lock': '🔐',
  'unlock': '🔓',
  'file_folder': '📁',
  'page_facing_up': '📄',
  'memo': '📝',
  'stopwatch': '⏱️',
  'hourglass': '⏳',
  'seedling': '🌱',
  'evergreen_tree': '🌲',
  'deciduous_tree': '🌳',
  'thread': '🧵',
  // Additional emoji used in update messages and throughout the app
  'arrows_counterclockwise': '🔄',
  'package': '📦',
  'partying_face': '🎉',
  'hourglass_flowing_sand': '⏳',
  'herb': '🌿',
  'bust_in_silhouette': '👤',
  'clipboard': '📋',
  'small_red_triangle_down': '🔽',
  'arrow_down_small': '🔽',
  'new': '🆕',
};

/**
 * Mapping from Unicode emoji characters to shortcode names.
 * Used for converting Unicode emoji to platform-specific shortcodes.
 * Generated by inverting EMOJI_NAME_TO_UNICODE.
 */
const EMOJI_UNICODE_TO_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(EMOJI_NAME_TO_UNICODE).map(([name, unicode]) => [unicode, name])
);

/**
 * Get the display emoji character for an emoji name.
 * Falls back to the name in colons if unknown.
 *
 * @param emojiName - The emoji name
 * @returns Emoji character or :name:
 */
export function getEmojiCharacter(emojiName: string): string {
  const normalized = normalizeEmojiName(emojiName);
  return EMOJI_NAME_TO_UNICODE[normalized] ?? `:${emojiName}:`;
}

// NOTE: convertUnicodeEmojiToShortcodes was removed because modern Mattermost
// clients (7.x+) render Unicode emoji natively. The conversion was causing issues
// because not all shortcodes (like :stopwatch:, :pause:) are recognized by all
// Mattermost instances.

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
// Code Block Utilities
// =============================================================================

/**
 * Check if content contains a code block.
 *
 * @param content - The content to check
 * @returns True if contains code block
 */
export function containsCodeBlock(content: string): boolean {
  return content.includes('```');
}

/**
 * Extract code blocks from content.
 *
 * @param content - The content to parse
 * @returns Array of {language, code} objects
 */
export function extractCodeBlocks(content: string): Array<{ language: string; code: string }> {
  const blocks: Array<{ language: string; code: string }> = [];
  const regex = /```(\w*)\n?([\s\S]*?)```/g;

  let match;
  while ((match = regex.exec(content)) !== null) {
    blocks.push({
      language: match[1] || '',
      code: match[2].trim(),
    });
  }

  return blocks;
}

/**
 * Wrap code in a code block with optional language.
 *
 * @param code - The code to wrap
 * @param language - Optional language for syntax highlighting
 * @returns Formatted code block with trailing newline
 */
export function formatCodeBlock(code: string, language?: string): string {
  const lang = language ?? '';
  // Add trailing newline to ensure proper rendering when followed by text
  return '```' + lang + '\n' + code + '\n```\n';
}

// =============================================================================
// URL Utilities
// =============================================================================

/**
 * Extract URLs from a message.
 *
 * @param message - The message to parse
 * @returns Array of URLs found
 */
export function extractUrls(message: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"[\]]+/gi;
  return message.match(urlRegex) ?? [];
}

/**
 * Check if a string is a valid URL.
 *
 * @param str - The string to check
 * @returns True if valid URL
 */
export function isValidUrl(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Retry Utilities
// =============================================================================

/**
 * Retry an async operation with exponential backoff.
 *
 * @param operation - The async operation to retry
 * @param options - Retry options
 * @returns The result of the operation
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    shouldRetry?: (error: unknown) => boolean;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    shouldRetry = () => true,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      // Exponential backoff with jitter
      const delay = Math.min(
        baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000,
        maxDelayMs
      );

      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// Validation Utilities
// =============================================================================

/**
 * Validate that a user is in the allowed list.
 *
 * @param username - Username to check
 * @param allowedUsers - Set of allowed usernames
 * @returns True if allowed
 */
export function isUserAllowed(username: string, allowedUsers: Set<string>): boolean {
  return allowedUsers.has(username) || allowedUsers.size === 0;
}

/**
 * Sanitize a message for logging (remove sensitive info).
 *
 * @param message - The message to sanitize
 * @returns Sanitized message
 */
export function sanitizeForLogging(message: string): string {
  // Remove potential tokens/secrets
  return message
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/token[=:]\s*["']?[^"'\s]+["']?/gi, 'token=[REDACTED]')
    .replace(/password[=:]\s*["']?[^"'\s]+["']?/gi, 'password=[REDACTED]')
    .replace(/secret[=:]\s*["']?[^"'\s]+["']?/gi, 'secret=[REDACTED]');
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
