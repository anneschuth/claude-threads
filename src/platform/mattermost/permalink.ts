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
import {
  DEFAULT_THREAD_LIMIT,
  MAX_THREAD_LIMIT,
  MAX_MESSAGE_BODY_CHARS,
  clampThreadLimit,
  truncateBody,
  quoteBlock,
} from '../permalink-shared.js';

// Re-exported so the MCP server (and tests) can import caps from a single
// per-platform entry point without learning about permalink-shared.ts.
export { DEFAULT_THREAD_LIMIT, MAX_THREAD_LIMIT, MAX_MESSAGE_BODY_CHARS };

/**
 * Mattermost post IDs are 26-character base32-style strings (lowercase
 * a-z plus 0-9). Anchored so we don't match longer ID-like substrings.
 */
const POST_ID_RE = /^[a-z0-9]{26}$/;

/**
 * Mattermost team URL-names: must start AND end with a letter or digit,
 * with optional letters/digits/hyphens/underscores in between. 1–64 chars
 * total. Mirrors Mattermost's own server-side rule
 * (^[a-z0-9]([a-z0-9\-_]*[a-z0-9])?$). The end-anchor matters: we don't
 * want to accept `-foo` or `_bar` as a "team name" just because we're
 * loose about the start.
 */
const TEAM_NAME_RE = /^[a-z0-9]([a-z0-9_-]{0,62}[a-z0-9])?$/;

export interface ParsedPermalink {
  postId: string;
}

/**
 * Parse a Mattermost permalink into a post ID. Returns null if the URL
 * isn't a permalink for `baseUrl`.
 *
 * Accepted shapes (with optional trailing slash, query string, and
 * fragment — all ignored):
 *   {baseUrl}/{team}/pl/{postId}     — chat permalink (team-scoped)
 *   {baseUrl}/_redirect/pl/{postId}  — redirect permalink (no team)
 *
 * `baseUrl` is matched on origin (scheme + host + port) plus path
 * prefix, so subpath installs like `https://host/chat` work — the
 * configured subpath is stripped before the {team}/pl/{id} segments
 * are validated.
 *
 * The two shapes are recognized explicitly. Anything else (channel
 * URLs, search results, settings pages, malformed paths) returns null.
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

  // Origin match: same scheme + host + port.
  if (parsed.origin !== base.origin) {
    return null;
  }

  // Strip configured subpath. Mattermost installs at `/chat` show up in
  // every permalink as a leading `/chat` segment that the parser must
  // remove before the team/pl/id segments are validated. Compare segment
  // arrays so `/chat` doesn't accidentally match `/chatter`.
  const baseSegments = base.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  const allSegments = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');

  for (let i = 0; i < baseSegments.length; i++) {
    if (allSegments[i] !== baseSegments[i]) return null;
  }
  const segments = allSegments.slice(baseSegments.length);

  if (segments.length !== 3) return null;

  // Second segment must literally be 'pl'.
  if (segments[1] !== 'pl') return null;

  // First segment is either '_redirect' or a team-name. Without this
  // check, /any/pl/{id} would match — including paths that have nothing
  // to do with permalinks but happen to be three segments.
  const first = segments[0];
  const isValidPrefix = first === '_redirect' || TEAM_NAME_RE.test(first);
  if (!isValidPrefix) return null;

  const postId = segments[2];
  if (!POST_ID_RE.test(postId)) return null;

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
  | { kind: 'wrong-channel' }      // post lives in a channel other than the bot's
  | { kind: 'not-found' }
  | { kind: 'unsupported' };       // platform doesn't support post reads

export type ResolveResult =
  | { ok: true; resolved: ResolvedPermalink }
  | { ok: false; error: ResolveError };

/**
 * Fetch the post (and optionally its thread) via the McpPlatformApi.
 * Returns a structured result so the caller can format errors however it
 * wants.
 *
 * `botChannelId` scopes resolution to the bot's own channel. Mattermost
 * permalinks are global (the URL doesn't pin a channel) and the bot's
 * token may have access to other channels too, so we fetch first and
 * reject after the fact when the returned post is in another channel —
 * that way the caller can distinguish "wrong channel" from a real
 * "not found." Pass `undefined` to skip the scope check (only useful
 * for tests / future cross-channel features).
 */
export async function resolvePermalink(
  api: McpPlatformApi,
  postId: string,
  botChannelId: string | undefined,
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  if (!api.readPost) {
    return { ok: false, error: { kind: 'unsupported' } };
  }

  const post = await api.readPost(postId);
  if (!post) {
    return { ok: false, error: { kind: 'not-found' } };
  }

  // Public channels on the same instance are readable by anyone with
  // an account, so the channel-scope guard adds no privacy value when
  // the target is public — anyone in the bot's thread could already
  // navigate to the post themselves. Skip the check in that case.
  // Missing channelType is treated as private (fail-safe).
  if (
    botChannelId !== undefined &&
    post.channelId !== botChannelId &&
    post.channelType !== 'public'
  ) {
    return { ok: false, error: { kind: 'wrong-channel' } };
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

  const limit = clampThreadLimit(opts.maxMessages);
  const thread = await api.readThread(rootId, { limit });

  return { ok: true, resolved: { post, thread } };
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
