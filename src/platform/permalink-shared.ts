/**
 * Shared utilities for platform-specific permalink followers.
 *
 * The Mattermost and Slack permalink modules render to the same shape
 * (a header line, a quoted post body, optional thread context). Anything
 * that is genuinely platform-agnostic lives here so the two modules
 * can't drift on caps, truncation rules, or rendering style.
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
 * Maximum characters of an individual message body included in the output.
 * Anything longer is truncated with a marker — Claude can call read_post
 * again with a smaller context if it needs the full body.
 */
export const MAX_MESSAGE_BODY_CHARS = 2000;

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
 * Truncate a message body to MAX_MESSAGE_BODY_CHARS with a trailing
 * marker indicating how many characters were dropped. Bodies at or under
 * the cap are returned verbatim.
 */
export function truncateBody(body: string): string {
  if (body.length <= MAX_MESSAGE_BODY_CHARS) return body;
  return `${body.slice(0, MAX_MESSAGE_BODY_CHARS)}\n[…truncated, ${body.length - MAX_MESSAGE_BODY_CHARS} more chars]`;
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
