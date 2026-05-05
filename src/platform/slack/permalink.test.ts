/**
 * Unit tests for the Slack permalink follower.
 */

import { describe, it, expect } from 'bun:test';
import {
  parseSlackPermalink,
  resolveSlackPermalink,
  formatResolvedSlack,
  DEFAULT_THREAD_LIMIT,
  MAX_THREAD_LIMIT,
  MAX_MESSAGE_BODY_CHARS,
} from './permalink.js';
import type { McpPlatformApi, McpPost } from '../mcp-platform-api.js';

const CHANNEL = 'C0123456789';
const TS = '1234567890.123456';
const TS_NO_DOT = '1234567890123456';
const REPLY_TS = '1234567890.123457';

// =============================================================================
// parseSlackPermalink
// =============================================================================

describe('parseSlackPermalink', () => {
  it('parses a top-level permalink', () => {
    expect(parseSlackPermalink(`https://acme.slack.com/archives/${CHANNEL}/p${TS_NO_DOT}`))
      .toEqual({ channelId: CHANNEL, ts: TS, threadParentTs: undefined });
  });

  it('reconstructs the dot in the timestamp', () => {
    const parsed = parseSlackPermalink(`https://acme.slack.com/archives/${CHANNEL}/p${TS_NO_DOT}`);
    expect(parsed?.ts).toBe(TS);
  });

  it('extracts thread_ts from the query string', () => {
    expect(parseSlackPermalink(
      `https://acme.slack.com/archives/${CHANNEL}/p1234567890123457?thread_ts=${TS}&cid=${CHANNEL}`,
    )).toEqual({ channelId: CHANNEL, ts: REPLY_TS, threadParentTs: TS });
  });

  it('ignores invalid thread_ts', () => {
    const result = parseSlackPermalink(
      `https://acme.slack.com/archives/${CHANNEL}/p${TS_NO_DOT}?thread_ts=garbage`,
    );
    expect(result?.threadParentTs).toBeUndefined();
  });

  it('strips trailing slashes', () => {
    expect(parseSlackPermalink(`https://acme.slack.com/archives/${CHANNEL}/p${TS_NO_DOT}/`))
      .toEqual({ channelId: CHANNEL, ts: TS, threadParentTs: undefined });
  });

  it('rejects non-slack hosts', () => {
    expect(parseSlackPermalink(`https://other.example.com/archives/${CHANNEL}/p${TS_NO_DOT}`))
      .toBeNull();
    expect(parseSlackPermalink(`https://slack.evil.com/archives/${CHANNEL}/p${TS_NO_DOT}`))
      .toBeNull();
  });

  it('rejects http (non-https) URLs', () => {
    expect(parseSlackPermalink(`http://acme.slack.com/archives/${CHANNEL}/p${TS_NO_DOT}`))
      .toBeNull();
  });

  it('rejects malformed paths', () => {
    expect(parseSlackPermalink('https://acme.slack.com/messages/abc/123')).toBeNull();
    expect(parseSlackPermalink(`https://acme.slack.com/archives/${CHANNEL}`)).toBeNull();
    expect(parseSlackPermalink(`https://acme.slack.com/${CHANNEL}/p${TS_NO_DOT}`)).toBeNull();
  });

  it('rejects malformed channel ids', () => {
    expect(parseSlackPermalink(`https://acme.slack.com/archives/lowercase/p${TS_NO_DOT}`)).toBeNull();
    expect(parseSlackPermalink(`https://acme.slack.com/archives/X${CHANNEL}/p${TS_NO_DOT}`)).toBeNull();
  });

  it('rejects malformed message segments', () => {
    expect(parseSlackPermalink(`https://acme.slack.com/archives/${CHANNEL}/${TS_NO_DOT}`)).toBeNull(); // missing 'p'
    expect(parseSlackPermalink(`https://acme.slack.com/archives/${CHANNEL}/pXX${TS_NO_DOT}`)).toBeNull(); // non-digits after p
    expect(parseSlackPermalink(`https://acme.slack.com/archives/${CHANNEL}/p1234`)).toBeNull(); // too short
  });

  it('returns null for malformed URLs', () => {
    expect(parseSlackPermalink('not a url')).toBeNull();
    expect(parseSlackPermalink('')).toBeNull();
  });
});

// =============================================================================
// resolveSlackPermalink
// =============================================================================

function makePost(overrides: Partial<McpPost> = {}): McpPost {
  return {
    id: TS,
    channelId: CHANNEL,
    userId: 'U-1',
    username: 'alice',
    message: 'hello',
    createAt: 1_234_567_890_123,
    threadRootId: undefined,
    ...overrides,
  };
}

interface FakeApiOptions {
  posts?: Record<string, McpPost | null>;
  thread?: McpPost[];
  noReadPost?: boolean;
  noReadThread?: boolean;
}

function makeFakeApi(opts: FakeApiOptions = {}): McpPlatformApi & {
  _readPostCalls: string[];
  _threadCalls: Array<{ rootId: string; limit?: number }>;
} {
  const readPostCalls: string[] = [];
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
      readPostCalls.push(id);
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

  return Object.assign(api, { _readPostCalls: readPostCalls, _threadCalls: threadCalls });
}

describe('resolveSlackPermalink', () => {
  it('rejects permalinks for a different channel', async () => {
    const api = makeFakeApi({ posts: { [TS]: makePost() } });
    const result = await resolveSlackPermalink(api, { channelId: 'C-OTHER', ts: TS }, CHANNEL);
    expect(result).toEqual({ ok: false, error: { kind: 'wrong-channel' } });
    expect(api._readPostCalls).toEqual([]); // never even tried
  });

  it('returns the post when channel matches', async () => {
    const api = makeFakeApi({ posts: { [TS]: makePost() } });
    const result = await resolveSlackPermalink(api, { channelId: CHANNEL, ts: TS }, CHANNEL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.post.message).toBe('hello');
    expect(result.resolved.thread).toEqual([]);
  });

  it('returns not-found when readPost returns null', async () => {
    const api = makeFakeApi({ posts: { [TS]: null } });
    const result = await resolveSlackPermalink(api, { channelId: CHANNEL, ts: TS }, CHANNEL);
    expect(result).toEqual({ ok: false, error: { kind: 'not-found' } });
  });

  it('returns unsupported when readPost is missing', async () => {
    const api = makeFakeApi({ noReadPost: true });
    const result = await resolveSlackPermalink(api, { channelId: CHANNEL, ts: TS }, CHANNEL);
    expect(result).toEqual({ ok: false, error: { kind: 'unsupported' } });
  });

  it('uses threadParentTs from the URL as the thread root when present', async () => {
    const api = makeFakeApi({
      posts: { [REPLY_TS]: makePost({ id: REPLY_TS, threadRootId: TS }) },
      thread: [],
    });
    await resolveSlackPermalink(
      api,
      { channelId: CHANNEL, ts: REPLY_TS, threadParentTs: TS },
      CHANNEL,
      { includeThread: true },
    );
    expect(api._threadCalls).toEqual([{ rootId: TS, limit: DEFAULT_THREAD_LIMIT }]);
  });

  it('falls back to the post threadRootId when the URL has no thread_ts', async () => {
    const api = makeFakeApi({
      posts: { [REPLY_TS]: makePost({ id: REPLY_TS, threadRootId: TS }) },
      thread: [],
    });
    await resolveSlackPermalink(
      api,
      { channelId: CHANNEL, ts: REPLY_TS },
      CHANNEL,
      { includeThread: true },
    );
    expect(api._threadCalls[0].rootId).toBe(TS);
  });

  it('uses the post id as the thread root for top-level posts', async () => {
    const api = makeFakeApi({
      posts: { [TS]: makePost({ id: TS }) },
      thread: [],
    });
    await resolveSlackPermalink(
      api,
      { channelId: CHANNEL, ts: TS },
      CHANNEL,
      { includeThread: true },
    );
    expect(api._threadCalls[0].rootId).toBe(TS);
  });

  it('clamps maxMessages above MAX_THREAD_LIMIT', async () => {
    const api = makeFakeApi({ posts: { [TS]: makePost() } });
    await resolveSlackPermalink(
      api,
      { channelId: CHANNEL, ts: TS },
      CHANNEL,
      { includeThread: true, maxMessages: 999 },
    );
    expect(api._threadCalls[0].limit).toBe(MAX_THREAD_LIMIT);
  });
});

// =============================================================================
// formatResolvedSlack
// =============================================================================

describe('formatResolvedSlack', () => {
  it('renders just the message when no thread is requested', () => {
    const post = makePost({ message: 'hello world' });
    const out = formatResolvedSlack({ post, thread: [] });
    expect(out).toContain('Slack message by @alice');
    expect(out).toContain('> hello world');
    expect(out).not.toContain('Thread context');
  });

  it('renders thread context with the linked message highlighted', () => {
    const post = makePost({ id: TS, message: 'first' });
    const reply = makePost({ id: REPLY_TS, username: 'bob', message: 'second' });
    const out = formatResolvedSlack({ post, thread: [post, reply] });
    expect(out).toContain('Thread context (2 messages)');
    expect(out).toContain('@alice ← linked message');
    expect(out).toContain('@bob:');
  });

  it('truncates bodies longer than MAX_MESSAGE_BODY_CHARS', () => {
    const post = makePost({ message: 'x'.repeat(MAX_MESSAGE_BODY_CHARS + 100) });
    const out = formatResolvedSlack({ post, thread: [] });
    expect(out).toContain('[…truncated, 100 more chars]');
  });

  it('uses singular "message" for thread of one', () => {
    const post = makePost();
    const out = formatResolvedSlack({ post, thread: [post] });
    expect(out).toContain('Thread context (1 message)');
    expect(out).not.toContain('1 messages');
  });
});
