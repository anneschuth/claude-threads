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
 * @param platformType - The platform type (mattermost, etc.)
 * @returns Emoji icon for the platform
 */
export function getPlatformIcon(platformType: string): string {
  switch (platformType) {
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
  // Platforms may wrap the name in colons (`:thumbsup:`) — strip them
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

/**
 * Split a message into posts the platform will accept. A full code review runs
 * past the per-post limit, and the point of sending it is that the recipient
 * gets it entire — so it goes out as several posts rather than one rejected
 * call or a truncated fragment. Paragraph boundaries first, hard cut only for
 * a single paragraph that is itself too long.
 */
export function splitMessageForPosts(message: string, maxLength: number): string[] {
  // A non-positive limit would make the hard-cut loop below never advance.
  if (!Number.isFinite(maxLength) || maxLength <= 0) return [message];
  if (message.length <= maxLength) return [message];

  const chunks: string[] = [];
  let current = '';
  for (const para of message.split('\n\n')) {
    const piece = current ? `${current}\n\n${para}` : para;
    if (piece.length <= maxLength) {
      current = piece;
      continue;
    }
    if (current) chunks.push(current);
    if (para.length <= maxLength) {
      current = para;
      continue;
    }
    // One oversized paragraph (a giant code block): cut it into whole slices.
    for (let i = 0; i < para.length; i += maxLength) {
      chunks.push(para.slice(i, i + maxLength));
    }
    current = chunks.pop() ?? '';
  }
  if (current) chunks.push(current);
  return chunks;
}
