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
  return clampLimit(requested, { dflt: DEFAULT_THREAD_LIMIT, max: MAX_THREAD_LIMIT });
}

/** Clamp a caller-supplied result limit to [1, max], defaulting when absent/invalid. */
export function clampLimit(requested: number | undefined, bounds: { dflt: number; max: number }): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return bounds.dflt;
  }
  return Math.min(Math.floor(requested), bounds.max);
}

/**
 * Render a list of posts for Claude: `@author:` (optionally with the channel)
 * then the quoted, truncated body. Shared by the read_thread,
 * read_channel_history, and search_messages MCP tools.
 */
export function formatPostList(
  header: string,
  posts: Array<{ username?: string | null; channelId?: string; message: string }>,
  opts?: { withChannel?: boolean },
): string {
  const lines: string[] = [header, ''];
  for (const m of posts) {
    const author = m.username ?? 'unknown';
    lines.push(opts?.withChannel ? `@${author} in channel ${m.channelId}:` : `@${author}:`);
    lines.push(quoteBlock(truncateBody(m.message)));
    lines.push('');
  }
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
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

import type { McpPost } from './mcp-platform-api.js';

export interface ResolveOptions {
  includeThread?: boolean;
  /** Defaults to DEFAULT_THREAD_LIMIT, capped at MAX_THREAD_LIMIT. */
  maxMessages?: number;
}

export interface ResolvedPermalink {
  /** The post the URL pointed to. */
  post: McpPost;
  /**
   * When `includeThread` is true and the post is in a thread, the surrounding
   * messages (oldest first). Includes the linked post itself. Empty array
   * when threading wasn't requested or the post is top-level.
   */
  thread: McpPost[];
}

export type ResolveError =
  | { kind: 'wrong-channel' }      // post lives in a channel other than the bot's
  | { kind: 'not-found' }
  | { kind: 'unsupported' };       // platform doesn't support post reads

export type ResolveResult =
  | { ok: true; resolved: ResolvedPermalink }
  | { ok: false; error: ResolveError };

/**
 * Render a resolved permalink for Claude: the linked post, then (when
 * requested) its thread context. Shared by both platforms — only the header
 * and the linked-post marker wording differ.
 */
export function formatResolvedPermalink(
  resolved: ResolvedPermalink,
  wording: { header: string; linkedMarker: string },
): string {
  const { post, thread } = resolved;
  const lines: string[] = [];

  lines.push(`${wording.header} @${post.username ?? 'unknown'}:`);
  lines.push('');
  lines.push(quoteBlock(truncateBody(post.message)));

  if (thread.length > 0) {
    lines.push('');
    lines.push(`Thread context (${thread.length} message${thread.length === 1 ? '' : 's'}):`);
    lines.push('');
    for (const m of thread) {
      const marker = m.id === post.id ? ` ${wording.linkedMarker}` : '';
      const author = m.username ?? 'unknown';
      lines.push(`@${author}${marker}:`);
      lines.push(quoteBlock(truncateBody(m.message)));
      lines.push('');
    }
    // Drop trailing blank.
    if (lines[lines.length - 1] === '') lines.pop();
  }

  return lines.join('\n');
}
