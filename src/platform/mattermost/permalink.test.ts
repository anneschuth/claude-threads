/**
 * Unit tests for the Mattermost permalink follower.
 *
 * Three concerns covered here:
 *   - parseMattermostPermalink: pure URL parsing
 *   - resolvePermalink: orchestrates the McpPlatformApi calls
 *   - formatResolved: markdown rendering, including truncation
 */

import { describe, it, expect } from 'bun:test';
import {
  parseMattermostPermalink,
  resolvePermalink,
  formatResolved,
  DEFAULT_THREAD_LIMIT,
  MAX_THREAD_LIMIT,
  MAX_MESSAGE_BODY_CHARS,
} from './permalink.js';
import type { McpPlatformApi, McpPost } from '../mcp-platform-api.js';

const BASE = 'https://chat.example.test';
const ID_A = 'a'.repeat(26);
const ID_B = 'b'.repeat(26);

// =============================================================================
// parseMattermostPermalink
// =============================================================================

describe('parseMattermostPermalink', () => {
  it('parses the chat-permalink shape /{team}/pl/{id}', () => {
    expect(parseMattermostPermalink(`${BASE}/digilab/pl/${ID_A}`, BASE))
      .toEqual({ postId: ID_A });
  });

  it('parses the redirect shape /_redirect/pl/{id}', () => {
    expect(parseMattermostPermalink(`${BASE}/_redirect/pl/${ID_A}`, BASE))
      .toEqual({ postId: ID_A });
  });

  it('strips trailing slash', () => {
    expect(parseMattermostPermalink(`${BASE}/digilab/pl/${ID_A}/`, BASE))
      .toEqual({ postId: ID_A });
  });

  it('ignores query strings', () => {
    expect(parseMattermostPermalink(`${BASE}/digilab/pl/${ID_A}?source=share`, BASE))
      .toEqual({ postId: ID_A });
  });

  it('ignores hash fragments', () => {
    expect(parseMattermostPermalink(`${BASE}/digilab/pl/${ID_A}#scroll`, BASE))
      .toEqual({ postId: ID_A });
  });

  it('matches when baseUrl has a trailing slash', () => {
    expect(parseMattermostPermalink(`${BASE}/digilab/pl/${ID_A}`, `${BASE}/`))
      .toEqual({ postId: ID_A });
  });

  it('requires the URL path to be under the baseUrl path', () => {
    // When baseUrl has a path component, the permalink path must include
    // it as a prefix. Without this, /chat installs would match permalinks
    // that aren't actually on the bot's instance.
    expect(parseMattermostPermalink(`${BASE}/some/extra/path/digilab/pl/${ID_A}`, `${BASE}/some/extra/path`))
      .toEqual({ postId: ID_A });
    expect(parseMattermostPermalink(`${BASE}/digilab/pl/${ID_A}`, `${BASE}/some/extra/path`))
      .toBeNull();
  });

  // Mattermost subpath-installs ("https://host/chat") are common: the
  // permalink path then has a leading "/chat" prefix that must be stripped
  // before the {team}/pl/{id} segments. Without this, the bot rejects every
  // permalink on its own instance.
  describe('subpath installs', () => {
    const SUBPATH_BASE = 'https://digilab.overheid.nl/chat';

    it('parses /chat/{team}/pl/{id} when the base has a /chat subpath', () => {
      expect(parseMattermostPermalink(
        `https://digilab.overheid.nl/chat/digilab/pl/${ID_A}`,
        SUBPATH_BASE,
      )).toEqual({ postId: ID_A });
    });

    it('parses /chat/_redirect/pl/{id} when the base has a /chat subpath', () => {
      expect(parseMattermostPermalink(
        `https://digilab.overheid.nl/chat/_redirect/pl/${ID_A}`,
        SUBPATH_BASE,
      )).toEqual({ postId: ID_A });
    });

    it('matches when the base has a trailing slash on the subpath', () => {
      expect(parseMattermostPermalink(
        `https://digilab.overheid.nl/chat/digilab/pl/${ID_A}`,
        `${SUBPATH_BASE}/`,
      )).toEqual({ postId: ID_A });
    });

    it('rejects a permalink that omits the configured subpath', () => {
      expect(parseMattermostPermalink(
        `https://digilab.overheid.nl/digilab/pl/${ID_A}`,
        SUBPATH_BASE,
      )).toBeNull();
    });

    it('rejects a permalink under a different subpath', () => {
      expect(parseMattermostPermalink(
        `https://digilab.overheid.nl/other/digilab/pl/${ID_A}`,
        SUBPATH_BASE,
      )).toBeNull();
    });

    it('rejects a path that only happens to start with the subpath string', () => {
      // /chatter/{team}/pl/{id} must not match when the base subpath is /chat:
      // we compare path segments, not raw string prefixes.
      expect(parseMattermostPermalink(
        `https://digilab.overheid.nl/chatter/digilab/pl/${ID_A}`,
        SUBPATH_BASE,
      )).toBeNull();
    });
  });

  it('returns null for URLs on a different host', () => {
    expect(parseMattermostPermalink(`https://other.example.test/team/pl/${ID_A}`, BASE))
      .toBeNull();
  });

  it('returns null for URLs on a different scheme', () => {
    expect(parseMattermostPermalink(`http://chat.example.test/team/pl/${ID_A}`, BASE))
      .toBeNull();
  });

  it('returns null when the path is not a permalink', () => {
    expect(parseMattermostPermalink(`${BASE}/digilab/channels/town-square`, BASE)).toBeNull();
    expect(parseMattermostPermalink(`${BASE}/digilab/`, BASE)).toBeNull();
    expect(parseMattermostPermalink(`${BASE}/`, BASE)).toBeNull();
  });

  it('returns null when the id is the wrong length', () => {
    expect(parseMattermostPermalink(`${BASE}/team/pl/${'a'.repeat(25)}`, BASE)).toBeNull();
    expect(parseMattermostPermalink(`${BASE}/team/pl/${'a'.repeat(27)}`, BASE)).toBeNull();
  });

  it('returns null when the id has invalid characters', () => {
    // Uppercase, hyphens, etc. — Mattermost IDs are lowercase a-z + 0-9.
    expect(parseMattermostPermalink(`${BASE}/team/pl/${'A'.repeat(26)}`, BASE)).toBeNull();
    expect(parseMattermostPermalink(`${BASE}/team/pl/${'-'.repeat(26)}`, BASE)).toBeNull();
  });

  it('returns null for malformed URLs', () => {
    expect(parseMattermostPermalink('not a url', BASE)).toBeNull();
    expect(parseMattermostPermalink('', BASE)).toBeNull();
  });

  it('returns null when the path has the wrong number of segments', () => {
    // Extra trailing segment ("/team/pl/{id}/extra") should not match — we
    // require exactly three segments after stripping leading/trailing slashes.
    expect(parseMattermostPermalink(`${BASE}/team/pl/${ID_A}/extra`, BASE)).toBeNull();
    // Two segments only.
    expect(parseMattermostPermalink(`${BASE}/pl/${ID_A}`, BASE)).toBeNull();
    // Four segments with `pl` in the middle — must not match (an earlier
    // implementation accepted this by checking only segments[1]).
    expect(parseMattermostPermalink(`${BASE}/foo/bar/pl/${ID_A}`, BASE)).toBeNull();
  });

  it('returns null when the team segment violates Mattermost team-name rules', () => {
    // Uppercase letters: Mattermost team URL-names are lowercase only.
    expect(parseMattermostPermalink(`${BASE}/INVALID/pl/${ID_A}`, BASE)).toBeNull();
    // Spaces / special chars (URL-encoded would be %20 — also invalid).
    expect(parseMattermostPermalink(`${BASE}/with%20space/pl/${ID_A}`, BASE)).toBeNull();
    // Empty team: caught by the "wrong number of segments" path because
    // pathname.replace strips the empty component, but assert it explicitly.
    expect(parseMattermostPermalink(`${BASE}//pl/${ID_A}`, BASE)).toBeNull();
    // Leading hyphen/underscore: Mattermost requires the first char to
    // be alphanumeric. An earlier loose regex accepted these.
    expect(parseMattermostPermalink(`${BASE}/-team/pl/${ID_A}`, BASE)).toBeNull();
    expect(parseMattermostPermalink(`${BASE}/_team/pl/${ID_A}`, BASE)).toBeNull();
    // Trailing hyphen/underscore: same rule for the last char.
    expect(parseMattermostPermalink(`${BASE}/team-/pl/${ID_A}`, BASE)).toBeNull();
    expect(parseMattermostPermalink(`${BASE}/team_/pl/${ID_A}`, BASE)).toBeNull();
  });

  it('accepts single-character team names (boundary case)', () => {
    // The regex's optional middle-group must allow a one-char team like
    // `a` or `1`.
    expect(parseMattermostPermalink(`${BASE}/a/pl/${ID_A}`, BASE))
      .toEqual({ postId: ID_A });
    expect(parseMattermostPermalink(`${BASE}/9/pl/${ID_A}`, BASE))
      .toEqual({ postId: ID_A });
  });

  it('accepts only the literal _redirect prefix for the redirect shape', () => {
    // _redirect is special-cased; redirect / _Redirect / etc. must not
    // sneak through as if they were team names.
    expect(parseMattermostPermalink(`${BASE}/_redirect/pl/${ID_A}`, BASE))
      .toEqual({ postId: ID_A });
    // 'redirect' (no underscore) is a valid lowercase team name shape, so
    // this is allowed — but the test documents it.
    expect(parseMattermostPermalink(`${BASE}/redirect/pl/${ID_A}`, BASE))
      .toEqual({ postId: ID_A });
  });
});

// =============================================================================
// resolvePermalink
// =============================================================================

const BOT_CHANNEL = 'c-bot';

function makePost(overrides: Partial<McpPost> = {}): McpPost {
  return {
    id: ID_A,
    channelId: BOT_CHANNEL,
    userId: 'u-1',
    username: 'alice',
    message: 'hello',
    createAt: 1_000,
    threadRootId: undefined,
    ...overrides,
  };
}

interface FakeApiOptions {
  posts?: Record<string, McpPost | null>;
  thread?: McpPost[];
  threadCalls?: Array<{ rootId: string; limit?: number }>;
  noReadPost?: boolean;
  noReadThread?: boolean;
}

function makeFakeApi(opts: FakeApiOptions = {}): McpPlatformApi & { _threadCalls: Array<{ rootId: string; limit?: number }> } {
  const threadCalls: Array<{ rootId: string; limit?: number }> = [];

  const api: McpPlatformApi = {
    getFormatter: () => ({} as ReturnType<McpPlatformApi['getFormatter']>),
    getBotUserId: async () => 'bot',
    getUsername: async () => null,
    isUserAllowed: () => true,
    createInteractivePost: async () => ({ id: 'p' }),
    updatePost: async () => undefined,
    waitForReaction: async () => null,
  };

  if (!opts.noReadPost) {
    api.readPost = async (id: string) => {
      if (opts.posts && id in opts.posts) return opts.posts[id];
      return null;
    };
  }
  if (!opts.noReadThread) {
    api.readThread = async (rootId: string, options?: { limit?: number }) => {
      threadCalls.push({ rootId, limit: options?.limit });
      return opts.thread ?? [];
    };
  }

  return Object.assign(api, { _threadCalls: threadCalls });
}

describe('resolvePermalink', () => {
  it('returns the post on success when threading is not requested', async () => {
    const api = makeFakeApi({ posts: { [ID_A]: makePost() } });
    const result = await resolvePermalink(api, ID_A, undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.post.message).toBe('hello');
    expect(result.resolved.thread).toEqual([]);
    expect(api._threadCalls).toEqual([]); // didn't call readThread
  });

  it('returns not-found when readPost returns null', async () => {
    const api = makeFakeApi({ posts: { [ID_A]: null } });
    const result = await resolvePermalink(api, ID_A, undefined);
    expect(result).toEqual({ ok: false, error: { kind: 'not-found' } });
  });

  it('returns unsupported when the platform has no readPost', async () => {
    const api = makeFakeApi({ noReadPost: true });
    const result = await resolvePermalink(api, ID_A, undefined);
    expect(result).toEqual({ ok: false, error: { kind: 'unsupported' } });
  });

  it('returns wrong-channel when the post lives in another channel', async () => {
    // The fetched post is in 'c-other', but the bot is scoped to BOT_CHANNEL.
    // Resolver must surface that as wrong-channel, not not-found.
    const api = makeFakeApi({
      posts: { [ID_A]: makePost({ channelId: 'c-other' }) },
    });
    const result = await resolvePermalink(api, ID_A, BOT_CHANNEL);
    expect(result).toEqual({ ok: false, error: { kind: 'wrong-channel' } });
  });

  it('allows cross-channel reads when the target channel is public', async () => {
    // Public channels on the same instance are readable by anyone in the
    // thread already, so the guard adds no privacy value. The resolver
    // must let these through.
    const api = makeFakeApi({
      posts: { [ID_A]: makePost({ channelId: 'c-other', channelType: 'public' }) },
    });
    const result = await resolvePermalink(api, ID_A, BOT_CHANNEL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.post.channelId).toBe('c-other');
  });

  it('still rejects cross-channel reads when the channel is private', async () => {
    const api = makeFakeApi({
      posts: { [ID_A]: makePost({ channelId: 'c-other', channelType: 'private' }) },
    });
    const result = await resolvePermalink(api, ID_A, BOT_CHANNEL);
    expect(result).toEqual({ ok: false, error: { kind: 'wrong-channel' } });
  });

  it('treats missing channelType as private (fail-safe)', async () => {
    // Older platform implementations or persisted state may not set
    // channelType. The resolver must not silently widen the guard.
    const api = makeFakeApi({
      posts: { [ID_A]: makePost({ channelId: 'c-other', channelType: undefined }) },
    });
    const result = await resolvePermalink(api, ID_A, BOT_CHANNEL);
    expect(result).toEqual({ ok: false, error: { kind: 'wrong-channel' } });
  });

  it('does not check channel scope when botChannelId is undefined', async () => {
    const api = makeFakeApi({
      posts: { [ID_A]: makePost({ channelId: 'c-other' }) },
    });
    const result = await resolvePermalink(api, ID_A, undefined);
    expect(result.ok).toBe(true);
  });

  it('returns the post when the channel matches', async () => {
    const api = makeFakeApi({ posts: { [ID_A]: makePost() } });
    const result = await resolvePermalink(api, ID_A, BOT_CHANNEL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.post.channelId).toBe(BOT_CHANNEL);
  });

  it('fetches the thread when includeThread is true and post is top-level', async () => {
    const post = makePost();
    const reply = makePost({ id: ID_B, threadRootId: ID_A, message: 'reply', createAt: 2_000 });
    const api = makeFakeApi({
      posts: { [ID_A]: post },
      thread: [post, reply],
    });
    const result = await resolvePermalink(api, ID_A, undefined, { includeThread: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.thread.map(m => m.id)).toEqual([ID_A, ID_B]);
    // Top-level post: thread root is the post itself.
    expect(api._threadCalls).toEqual([{ rootId: ID_A, limit: DEFAULT_THREAD_LIMIT }]);
  });

  it('uses threadRootId as the thread root when the post is a reply', async () => {
    const reply = makePost({ id: ID_B, threadRootId: ID_A, message: 'reply' });
    const api = makeFakeApi({
      posts: { [ID_B]: reply },
      thread: [makePost(), reply],
    });
    await resolvePermalink(api, ID_B, undefined, { includeThread: true });
    expect(api._threadCalls).toEqual([{ rootId: ID_A, limit: DEFAULT_THREAD_LIMIT }]);
  });

  it('clamps maxMessages above MAX_THREAD_LIMIT', async () => {
    const api = makeFakeApi({ posts: { [ID_A]: makePost() } });
    await resolvePermalink(api, ID_A, undefined, { includeThread: true, maxMessages: 999 });
    expect(api._threadCalls[0].limit).toBe(MAX_THREAD_LIMIT);
  });

  it('falls back to default when maxMessages is not a positive integer', async () => {
    const api = makeFakeApi({ posts: { [ID_A]: makePost() } });
    await resolvePermalink(api, ID_A, undefined, { includeThread: true, maxMessages: 0 });
    expect(api._threadCalls[0].limit).toBe(DEFAULT_THREAD_LIMIT);

    await resolvePermalink(api, ID_A, undefined, { includeThread: true, maxMessages: -5 });
    expect(api._threadCalls[1].limit).toBe(DEFAULT_THREAD_LIMIT);
  });

  it('floors fractional maxMessages', async () => {
    const api = makeFakeApi({ posts: { [ID_A]: makePost() } });
    await resolvePermalink(api, ID_A, undefined, { includeThread: true, maxMessages: 7.9 });
    expect(api._threadCalls[0].limit).toBe(7);
  });

  it('returns just the post when includeThread is true but readThread is missing', async () => {
    const api = makeFakeApi({ posts: { [ID_A]: makePost() }, noReadThread: true });
    const result = await resolvePermalink(api, ID_A, undefined, { includeThread: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.thread).toEqual([]);
  });
});

// =============================================================================
// formatResolved
// =============================================================================

describe('formatResolved', () => {
  it('renders just the linked post when there is no thread', () => {
    const post = makePost({ message: 'hello world' });
    const out = formatResolved({ post, thread: [] });
    expect(out).toContain('Mattermost post by @alice');
    expect(out).toContain('> hello world');
    expect(out).not.toContain('Thread context');
  });

  it('handles a null username gracefully', () => {
    const post = makePost({ username: null });
    const out = formatResolved({ post, thread: [] });
    expect(out).toContain('@unknown');
  });

  it('renders multi-line bodies with a blockquote prefix on every line', () => {
    const post = makePost({ message: 'line one\nline two\nline three' });
    const out = formatResolved({ post, thread: [] });
    expect(out).toContain('> line one\n> line two\n> line three');
  });

  it('truncates bodies longer than MAX_MESSAGE_BODY_CHARS', () => {
    const longBody = 'x'.repeat(MAX_MESSAGE_BODY_CHARS + 500);
    const post = makePost({ message: longBody });
    const out = formatResolved({ post, thread: [] });
    expect(out).toContain('[…truncated, 500 more chars]');
    // The truncation marker must come after exactly MAX_MESSAGE_BODY_CHARS
    // characters of body, and not be in the body itself.
    expect(out.match(/truncated/g)?.length).toBe(1);
  });

  it('renders a thread with the linked post highlighted', () => {
    const post = makePost({ id: ID_A, message: 'first' });
    const reply = makePost({ id: ID_B, username: 'bob', message: 'second', createAt: 2_000 });
    const out = formatResolved({ post, thread: [post, reply] });
    expect(out).toContain('Thread context (2 messages)');
    expect(out).toContain('@alice ← linked post');
    expect(out).toContain('@bob:');
    expect(out).toContain('> first');
    expect(out).toContain('> second');
  });

  it('uses singular "message" when the thread has exactly one entry', () => {
    const post = makePost();
    const out = formatResolved({ post, thread: [post] });
    expect(out).toContain('Thread context (1 message)');
    expect(out).not.toContain('1 messages');
  });
});
