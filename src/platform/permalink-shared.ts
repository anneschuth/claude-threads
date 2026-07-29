/**
 * Shared utilities for platform-specific permalink followers.
 *
 * Permalink modules render to a common shape (a header line, a quoted
 * post body, optional thread context). Anything that is genuinely
 * platform-agnostic lives here so per-platform modules can't drift on
 * caps, truncation rules, or rendering style.
 */

/**
 * Default upper bound on how many thread messages to return when
 * `include_thread` is true. Picked to keep tool output well under typical
 * tool-result token budgets while still giving useful context.
 */
export const DEFAULT_THREAD_LIMIT = 20;

/**
 * Hard cap server-side; even if the caller asks for more we won't exceed
 * this. Stops a runaway thread (hundreds of replies) from blowing up
 * tool-result size.
 */
export const MAX_THREAD_LIMIT = 50;

/**
 * Per-message cap when several messages are listed at once (thread context,
 * channel history, search hits), to bound the tool-result size.
 *
 * To read one long message in full, fetch it directly — the focal post of
 * read_post is not subject to this cap.
 *
 * Kept low on purpose: it multiplies by the message count (up to 50 for a
 * thread, 100 for channel history), and an over-limit MCP result is replaced
 * wholesale by an error — the reader would get nothing instead of a trim.
 */
export const MAX_MESSAGE_BODY_CHARS = 2000;

/**
 * Cap for the one post a read_post call is *about*. Set above the platforms'
 * own per-post limits, so that body always arrives whole.
 *
 * It used to share the 2000-char listing cap, which made a long post
 * unreadable by any means: an 8K code review came back truncated from every
 * tool, with no way to ask for the rest (observed — a bot burned a turn on
 * read_post/list_thread/search_messages and gave up with "текст режется").
 */
export const MAX_FOCUSED_BODY_CHARS = 20000;

/**
 * Clamp a caller-supplied thread limit to a sane integer in
 * [1, MAX_THREAD_LIMIT], or fall back to DEFAULT_THREAD_LIMIT for
 * undefined / non-finite / non-positive inputs.
 */
export function clampThreadLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_THREAD_LIMIT;
  }
  return Math.min(Math.floor(requested), MAX_THREAD_LIMIT);
}

/**
 * Truncate a message body with a trailing marker indicating how many
 * characters were dropped. Bodies at or under the cap are returned verbatim.
 *
 * @param limit - defaults to the listing cap; pass MAX_FOCUSED_BODY_CHARS for
 *                the single post a read_post call is about.
 */
export function truncateBody(body: string, limit: number = MAX_MESSAGE_BODY_CHARS): string {
  if (body.length <= limit) return body;
  return `${body.slice(0, limit)}\n[…truncated, ${body.length - limit} more chars]`;
}

/**
 * Prefix every line of `text` with `> `. Used to quote post bodies in
 * tool output so the rendered markdown is unambiguous about where a
 * fetched message starts and ends.
 */
export function quoteBlock(text: string): string {
  return text
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n');
}
