/**
 * Slack permalink follower
 *
 * Parses a Slack permalink URL into a channel id + message timestamp,
 * fetches the message (and optionally its thread) via the McpPlatformApi,
 * and renders the result as a markdown block suitable for inclusion in
 * MCP tool output.
 *
 * Slack permalinks look like:
 *   https://{workspace}.slack.com/archives/{channelId}/p{tsNoDot}
 *   https://{workspace}.slack.com/archives/{channelId}/p{tsNoDot}?thread_ts={parentTs}&cid=...
 *
 * The bot only follows links inside its configured channel, partly to avoid
 * cross-workspace channel-id collisions and partly because that channel is
 * the only one the bot is authorized to read.
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

export { DEFAULT_THREAD_LIMIT, MAX_THREAD_LIMIT, MAX_MESSAGE_BODY_CHARS };

/**
 * Slack channel IDs are 9–11 character strings starting with C/G/D
 * (channel/group/dm) followed by uppercase alphanumeric.
 */
const CHANNEL_ID_RE = /^[CGD][A-Z0-9]{8,12}$/;

/**
 * The `p{tsNoDot}` shape Slack uses in permalinks: lowercase 'p'
 * followed by digits. Slack timestamps are `seconds.microseconds` with
 * 6 digits of microseconds, and seconds since the Unix epoch hit 10
 * digits in 2001 — so any real permalink today has at least 16 digits.
 * We enforce 16+ here so `expandTimestamp` can rely on the slice.
 */
const PATH_TS_RE = /^p(\d{16,})$/;

export interface ParsedSlackPermalink {
  channelId: string;
  ts: string;
  /** When set, the URL pointed to a reply: this is the thread parent ts. */
  threadParentTs?: string;
}

/**
 * Parse a Slack permalink. Returns null if the URL isn't a recognizable
 * Slack permalink. Workspace subdomain is not verified here — the
 * resolver compares the extracted channel id to the bot's configured
 * channel.
 */
export function parseSlackPermalink(url: string): ParsedSlackPermalink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  // Slack permalinks are always on slack.com or a workspace subdomain of it.
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.slack.com')) {
    return null;
  }

  // Path: /archives/{channelId}/p{tsNoDot}
  const segments = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (segments.length !== 3 || segments[0] !== 'archives') {
    return null;
  }

  const channelId = segments[1];
  if (!CHANNEL_ID_RE.test(channelId)) return null;

  const tsMatch = segments[2].match(PATH_TS_RE);
  if (!tsMatch) return null;

  // Slack permalinks store ts as digits with the decimal point dropped.
  // The decimal goes 6 chars from the right (microseconds): the regex
  // above guarantees at least 16 digits, so the slice is safe.
  const tsNoDot = tsMatch[1];
  const ts = `${tsNoDot.slice(0, -6)}.${tsNoDot.slice(-6)}`;

  // Thread context comes from ?thread_ts=... query param if present.
  const threadParentTs = parsed.searchParams.get('thread_ts') ?? undefined;
  // Validate it as a Slack timestamp before trusting it.
  if (threadParentTs && !/^\d+\.\d+$/.test(threadParentTs)) {
    return { channelId, ts };
  }

  return { channelId, ts, threadParentTs };
}

export interface ResolveOptions {
  includeThread?: boolean;
  /** Defaults to DEFAULT_THREAD_LIMIT, capped at MAX_THREAD_LIMIT. */
  maxMessages?: number;
}

export interface ResolvedSlackPermalink {
  post: McpPost;
  thread: McpPost[];
}

export type ResolveError =
  | { kind: 'wrong-channel' } // permalink is for a channel other than the bot's
  | { kind: 'not-found' }
  | { kind: 'unsupported' };

export type ResolveResult =
  | { ok: true; resolved: ResolvedSlackPermalink }
  | { ok: false; error: ResolveError };

/**
 * Fetch the post (and optionally thread) via the McpPlatformApi. The
 * `botChannelId` arg is the channel the bot is configured to operate in;
 * permalinks pointing at any other channel are rejected.
 */
export async function resolveSlackPermalink(
  api: McpPlatformApi,
  parsed: ParsedSlackPermalink,
  botChannelId: string,
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  if (parsed.channelId !== botChannelId) {
    return { ok: false, error: { kind: 'wrong-channel' } };
  }
  if (!api.readPost) {
    return { ok: false, error: { kind: 'unsupported' } };
  }

  const post = await api.readPost(parsed.ts);
  if (!post) {
    return { ok: false, error: { kind: 'not-found' } };
  }

  if (!opts.includeThread) {
    return { ok: true, resolved: { post, thread: [] } };
  }

  // Pick the thread root: if the URL itself encodes a thread parent, use
  // that. Otherwise use the post's own threadRootId, falling back to the
  // post's id (a top-level post is its own thread root).
  const rootId = parsed.threadParentTs || post.threadRootId || post.id;

  if (!api.readThread) {
    return { ok: true, resolved: { post, thread: [] } };
  }

  const limit = clampThreadLimit(opts.maxMessages);
  const thread = await api.readThread(rootId, { limit });

  return { ok: true, resolved: { post, thread } };
}

/**
 * Render a resolved Slack permalink as markdown. Mirrors the Mattermost
 * formatter for consistency in tool output.
 */
export function formatResolvedSlack(resolved: ResolvedSlackPermalink): string {
  const { post, thread } = resolved;
  const lines: string[] = [];

  lines.push(`Slack message by @${post.username ?? 'unknown'}:`);
  lines.push('');
  lines.push(quoteBlock(truncateBody(post.message)));

  if (thread.length > 0) {
    lines.push('');
    lines.push(`Thread context (${thread.length} message${thread.length === 1 ? '' : 's'}):`);
    lines.push('');
    for (const m of thread) {
      const marker = m.id === post.id ? ' ← linked message' : '';
      const author = m.username ?? 'unknown';
      lines.push(`@${author}${marker}:`);
      lines.push(quoteBlock(truncateBody(m.message)));
      lines.push('');
    }
    if (lines[lines.length - 1] === '') lines.pop();
  }

  return lines.join('\n');
}
