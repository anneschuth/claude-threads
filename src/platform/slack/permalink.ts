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

export const DEFAULT_THREAD_LIMIT = 20;
export const MAX_THREAD_LIMIT = 50;
export const MAX_MESSAGE_BODY_CHARS = 2000;

/**
 * Slack channel IDs are 9–11 character strings starting with C/G/D
 * (channel/group/dm) followed by uppercase alphanumeric.
 */
const CHANNEL_ID_RE = /^[CGD][A-Z0-9]{8,12}$/;

/**
 * The `p{tsNoDot}` shape: lowercase 'p' followed by digits. Slack
 * timestamps are seconds.microseconds with 6 digits of microseconds, so
 * the no-dot form has at least 16 digits.
 */
const PATH_TS_RE = /^p(\d{10,})$/;

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

  const ts = expandTimestamp(tsMatch[1]);
  if (!ts) return null;

  // Thread context comes from ?thread_ts=... query param if present.
  const threadParentTs = parsed.searchParams.get('thread_ts') ?? undefined;
  // Validate it as a Slack timestamp before trusting it.
  if (threadParentTs && !/^\d+\.\d+$/.test(threadParentTs)) {
    return { channelId, ts };
  }

  return { channelId, ts, threadParentTs };
}

/**
 * Slack permalinks store ts as digits with the decimal point dropped.
 * The decimal goes 6 characters from the right (microseconds), so a path
 * "1234567890123456" becomes "1234567890.123456".
 *
 * Returns null for inputs that aren't long enough.
 */
function expandTimestamp(digitsOnly: string): string | null {
  if (digitsOnly.length < 7) return null; // need at least 1 second-digit + 6 micros
  return `${digitsOnly.slice(0, -6)}.${digitsOnly.slice(-6)}`;
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
