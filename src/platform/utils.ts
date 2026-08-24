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
  '👀': 'eyes',
  '❤️': 'heart',
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
/**
 * Fix code blocks that have text immediately after the closing ``` —
 * happens when Claude outputs code blocks without proper newlines.
 *
 * The pattern distinguishes opening vs closing ```:
 * - Opening: at line start, followed by optional language identifier, then newline
 * - Closing: at line start (after code content), followed by newline or end of string
 *
 * We match ``` preceded by newline (closing marker), followed by a non-whitespace
 * character that isn't part of a language identifier pattern (which would indicate
 * opening ```). The (?=\S) ensures there IS something after ``` (not end of
 * string or whitespace).
 */
export function fixCodeFenceRuns(text: string): string {
  return text.replace(/(?<=\n)```(?=\S)(?![a-zA-Z]*\n)/g, '```\n');
}

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

  preserved = fixCodeFenceRuns(preserved);

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

// =============================================================================
// Direct channel mode (DCM)
// =============================================================================

/**
 * Prefix for the synthetic thread id used by direct channel mode (DCM).
 *
 * In DCM the whole configured channel behaves as one session: the bot replies
 * with top-level channel posts instead of thread replies, and messages do not
 * need an @mention. Internally every session is still keyed by a thread id, so
 * DCM uses a synthetic, per-platform id (`dcm:<platformId>`) as that key. The
 * platform clients recognize the prefix and post to the channel root instead
 * of treating it as a real post id.
 */
export const DCM_THREAD_PREFIX = 'dcm:';

/** Build the synthetic DCM thread id for a platform instance. */
export function dcmThreadId(platformId: string): string {
  return `${DCM_THREAD_PREFIX}${platformId}`;
}

/** True if the given thread id is a synthetic DCM id (not a real post id). */
export function isDcmThreadId(threadId: string | undefined): boolean {
  return !!threadId && threadId.startsWith(DCM_THREAD_PREFIX);
}

/**
 * Resolve a thread id for use in a platform API call: a synthetic DCM id must
 * never reach the platform as root_id/thread_ts (it is not a real post id), so
 * it resolves to `undefined` (= post to the channel root).
 */
export function resolvePostThreadId(threadId: string | undefined): string | undefined {
  return isDcmThreadId(threadId) ? undefined : threadId;
}

/** Per-platform DCM options (long form of `directChannelMode`). */
export interface DirectChannelModeOptions {
  /** Turn DCM on/off. Providing the object at all defaults to enabled. */
  enabled?: boolean;
  /**
   * Which channel messages the bot responds to. `all_messages` (default):
   * every message from an allowed user reaches the bot. `mention`: only
   * messages that @mention the bot (replies still arrive as channel posts).
   * Backed by the per-session quiet-mode flag, so `!mentions` toggles it at
   * runtime.
   */
  respondTo?: 'all_messages' | 'mention';
}

/** `directChannelMode` as written in config.yaml: shorthand boolean or options. */
export type DirectChannelModeConfig = boolean | DirectChannelModeOptions;

/** Fully-resolved DCM settings with defaults applied. */
export interface ResolvedDirectChannelMode {
  enabled: boolean;
  respondTo: 'all_messages' | 'mention';
}

/** Apply defaults: `true` → enabled with all_messages; object → enabled unless `enabled: false`. */
export function resolveDirectChannelMode(cfg: DirectChannelModeConfig | undefined): ResolvedDirectChannelMode {
  if (cfg === undefined || cfg === false) {
    return { enabled: false, respondTo: 'all_messages' };
  }
  if (cfg === true) {
    return { enabled: true, respondTo: 'all_messages' };
  }
  return {
    enabled: cfg.enabled ?? true,
    respondTo: cfg.respondTo ?? 'all_messages',
  };
}

/**
 * Who may answer tool-permission prompts and other reaction gates (plan
 * approvals, question answers, session resume) for a platform's sessions.
 *
 * - `owner`: the session participants — the starter plus explicitly
 *   `!invite`d users.
 * - `all_users`: everyone on the platform's `allowedUsers` list.
 *
 * Unset keeps each mode's historical default: `all_users` for classic thread
 * sessions (upstream behavior, non-breaking), `owner` for direct channel mode
 * (a shared channel should not let every allowed user approve by default).
 */
export type ApprovalsMode = 'owner' | 'all_users';

/** Resolve the effective approvals mode: explicit setting wins, else per-mode default. */
export function resolveApprovals(configured: ApprovalsMode | undefined, isDcmSession: boolean): ApprovalsMode {
  return configured ?? (isDcmSession ? 'owner' : 'all_users');
}

/**
 * Normalize the per-platform `ackReaction` config value at construction
 * time: booleans and non-empty strings pass through, anything else warns
 * once and disables the feature (a malformed value must not silently
 * enable the default emoji).
 */
export function normalizeAckReaction(value: unknown, fieldPath: string): boolean | string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    // A literal Unicode emoji is converted to its shortcode name here, so
    // both platforms see a name (Mattermost's reaction API silently no-ops
    // on raw Unicode; Slack converts late in addReaction). Anything that is
    // not a plain ASCII shortcode name after mapping — unmapped pictographs,
    // ZWJ sequences, regional-indicator flags, keycaps, stray modifiers —
    // gets the same warn-and-disable treatment as any malformed value: a
    // reaction that never appears is worse than a startup warning. (An
    // allowlist beats trying to enumerate every Unicode emoji shape.)
    const name = getEmojiName(value.trim());
    if (!/^[a-z0-9_+':.-]+$/i.test(name)) {
      console.warn(
        `Invalid ${fieldPath}: unknown emoji ${JSON.stringify(value)} — use its shortcode name (e.g. "eyes"); ack reaction disabled`,
      );
      return undefined;
    }
    return name;
  }
  console.warn(
    `Invalid ${fieldPath}: expected boolean or emoji name, got ${JSON.stringify(value)} — ack reaction disabled`,
  );
  return undefined;
}

/**
 * Resolve the effective read-receipt reaction: `true` means the default
 * `eyes` emoji, a string names a custom emoji, unset/false disables it.
 */
export function resolveAckReaction(configured: boolean | string | undefined): string | null {
  if (!configured) return null;
  return typeof configured === 'string' ? configured : 'eyes';
}
