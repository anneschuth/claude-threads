/**
 * Mattermost permalink follower
 *
 * Parses a Mattermost permalink URL into a post id, fetches the post (and
 * optionally its surrounding thread) via the McpPlatformApi, and renders
 * the result as a markdown block suitable for inclusion in MCP tool output.
 *
 * The parser only accepts URLs whose host matches the bot's own Mattermost
 * instance — by design, the bot can only follow links inside the platform
 * it's connected to.
 */

import type { McpPlatformApi, McpPost } from '../mcp-platform-api.js';

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
 * Anything longer is truncated with a marker — Claude can request the post
 * directly if it needs the full body.
 */
export const MAX_MESSAGE_BODY_CHARS = 2000;

/**
 * Mattermost post IDs are 26-character base32-style strings (lowercase
 * a-z plus 0-9). Anchored so we don't match longer ID-like substrings.
 */
const POST_ID_RE = /^[a-z0-9]{26}$/;

export interface ParsedPermalink {
  postId: string;
}

/**
 * Parse a Mattermost permalink into a post ID. Returns null if the URL
 * isn't a permalink for `baseUrl`.
 *
 * Accepted shapes (with optional trailing slash and ?query):
 *   {baseUrl}/{team}/pl/{postId}
 *   {baseUrl}/_redirect/pl/{postId}
 *
 * `baseUrl` is matched on origin (scheme + host + port) only; trailing
 * paths in the configured URL are ignored.
 */
export function parseMattermostPermalink(
  url: string,
  baseUrl: string,
): ParsedPermalink | null {
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(url);
    base = new URL(baseUrl);
  } catch {
    return null;
  }

  // Origin match: same scheme + host + port. The configured baseUrl might
  // have a trailing slash or path component, but only the origin matters
  // for permalink routing.
  if (parsed.origin !== base.origin) {
    return null;
  }

  // Strip leading and trailing slashes, split on '/'. Path shapes:
  //   ['{team}', 'pl', '{id}']                 — chat permalink
  //   ['_redirect', 'pl', '{id}']              — redirect permalink
  const segments = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (segments.length !== 3 || segments[1] !== 'pl') {
    return null;
  }

  const postId = segments[2];
  if (!POST_ID_RE.test(postId)) {
    return null;
  }

  return { postId };
}

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
  | { kind: 'not-found' }
  | { kind: 'unsupported' }; // platform doesn't support post reads

export type ResolveResult =
  | { ok: true; resolved: ResolvedPermalink }
  | { ok: false; error: ResolveError };

/**
 * Fetch the post (and optionally its thread) via the McpPlatformApi.
 * Returns a structured result so the caller can format errors however it
 * wants.
 */
export async function resolvePermalink(
  api: McpPlatformApi,
  postId: string,
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  if (!api.readPost) {
    return { ok: false, error: { kind: 'unsupported' } };
  }

  const post = await api.readPost(postId);
  if (!post) {
    return { ok: false, error: { kind: 'not-found' } };
  }

  if (!opts.includeThread) {
    return { ok: true, resolved: { post, thread: [] } };
  }

  // Top-level post is its own thread root; reply uses root_id.
  const rootId = post.threadRootId || post.id;

  // No thread reads available → return just the post; this isn't an error,
  // it's a partial result.
  if (!api.readThread) {
    return { ok: true, resolved: { post, thread: [] } };
  }

  const limit = clampLimit(opts.maxMessages);
  const thread = await api.readThread(rootId, { limit });

  return { ok: true, resolved: { post, thread } };
}

function clampLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_THREAD_LIMIT;
  }
  return Math.min(Math.floor(requested), MAX_THREAD_LIMIT);
}

/**
 * Render a resolved permalink as a markdown block. Format is opinionated:
 * a header naming the linked post, the post body, and (if present) the
 * thread context with the linked post highlighted.
 *
 * Bodies longer than MAX_MESSAGE_BODY_CHARS are truncated with a marker.
 */
export function formatResolved(resolved: ResolvedPermalink): string {
  const { post, thread } = resolved;
  const lines: string[] = [];

  lines.push(`Mattermost post by @${post.username ?? 'unknown'}:`);
  lines.push('');
  lines.push(quoteBlock(truncateBody(post.message)));

  if (thread.length > 0) {
    lines.push('');
    lines.push(`Thread context (${thread.length} message${thread.length === 1 ? '' : 's'}):`);
    lines.push('');
    for (const m of thread) {
      const marker = m.id === post.id ? ' ← linked post' : '';
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

function truncateBody(body: string): string {
  if (body.length <= MAX_MESSAGE_BODY_CHARS) return body;
  return `${body.slice(0, MAX_MESSAGE_BODY_CHARS)}\n[…truncated, ${body.length - MAX_MESSAGE_BODY_CHARS} more chars]`;
}

function quoteBlock(text: string): string {
  return text
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n');
}
