/**
 * Unit tests for the Mattermost McpPlatformApi implementation.
 *
 * This file primarily protects the inlined Mattermost REST helpers
 * (`mattermostApi`, `getMe`, `getUser`, `createPost`, `updatePostRaw`,
 * `addReaction`, `createInteractivePostInternal`) which used to live in
 * `src/mattermost/api.ts` with their own 459-line test suite. When that file
 * was folded into `mcp-platform-api.ts`, the tests were dropped; this file
 * reestablishes coverage for the MCP-subprocess code path.
 *
 * The `waitForReaction` WebSocket path is not covered here (would require a
 * WebSocket harness); integration tests exercise it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createMattermostMcpPlatformApi } from './mcp-platform-api.js';

// -----------------------------------------------------------------------------
// Fetch harness (same pattern as src/platform/mattermost/client.test.ts)
// -----------------------------------------------------------------------------

type FetchResponder = (url: string, init?: RequestInit) => Promise<Response> | Response;

let fetchResponder: FetchResponder = () =>
  new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
let fetchCalls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = [];

const originalFetch = global.fetch;
beforeEach(() => {
  fetchCalls = [];
  global.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k] = h[k];
    }
    let body: unknown;
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    fetchCalls.push({ url: urlStr, method, headers, body });
    return fetchResponder(urlStr, init);
  }) as typeof global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(status: number, text = 'oops'): Response {
  return new Response(text, { status });
}

function makeApi() {
  return createMattermostMcpPlatformApi({
    platformType: 'mattermost',
    url: 'https://chat.example.test',
    token: 'secret-token',
    channelId: 'c-123',
    threadId: 'thread-root',
    allowedUsers: ['alice', 'bob'],
    debug: false,
  });
}

// -----------------------------------------------------------------------------
// isUserAllowed — pure logic, no HTTP
// -----------------------------------------------------------------------------

describe('MattermostMcpPlatformApi.isUserAllowed', () => {
  it('returns true for users in the allowlist', () => {
    expect(makeApi().isUserAllowed('alice')).toBe(true);
    expect(makeApi().isUserAllowed('bob')).toBe(true);
  });

  it('returns false for users outside the allowlist', () => {
    expect(makeApi().isUserAllowed('mallory')).toBe(false);
    expect(makeApi().isUserAllowed('')).toBe(false);
  });

  it('returns true for any user when the allowlist is empty (legacy behavior)', () => {
    const api = createMattermostMcpPlatformApi({
      platformType: 'mattermost',
      url: 'https://x.test',
      token: 't',
      channelId: 'c',
      allowedUsers: [],
    });
    expect(api.isUserAllowed('anyone')).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// getBotUserId / getUsername — exercise the /users/me and /users/{id} paths
// -----------------------------------------------------------------------------

describe('MattermostMcpPlatformApi.getBotUserId', () => {
  it('fetches /users/me with Bearer auth and returns the id', async () => {
    fetchResponder = () => jsonResponse({ id: 'bot-user-id', username: 'claude' });
    const api = makeApi();
    const id = await api.getBotUserId();
    expect(id).toBe('bot-user-id');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('https://chat.example.test/api/v4/users/me');
    expect(fetchCalls[0].method).toBe('GET');
    expect(fetchCalls[0].headers.Authorization).toBe('Bearer secret-token');
  });

  it('caches the bot user id across calls', async () => {
    fetchResponder = () => jsonResponse({ id: 'bot-user-id', username: 'claude' });
    const api = makeApi();
    await api.getBotUserId();
    await api.getBotUserId();
    expect(fetchCalls).toHaveLength(1);
  });
});

describe('MattermostMcpPlatformApi.getUsername', () => {
  it('returns the username for a valid user id', async () => {
    fetchResponder = () => jsonResponse({ id: 'u-1', username: 'alice' });
    const username = await makeApi().getUsername('u-1');
    expect(username).toBe('alice');
    expect(fetchCalls[0].url).toBe('https://chat.example.test/api/v4/users/u-1');
  });

  it('returns null when the user lookup fails', async () => {
    fetchResponder = () => errorResponse(404, 'not found');
    expect(await makeApi().getUsername('u-missing')).toBeNull();
  });

  it('returns null on a 5xx server error', async () => {
    fetchResponder = () => errorResponse(500, 'boom');
    expect(await makeApi().getUsername('u-1')).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// createInteractivePost — posts + reactions, continues on partial failure
// -----------------------------------------------------------------------------

describe('MattermostMcpPlatformApi.createInteractivePost', () => {
  it('posts to /posts with channel and thread, then adds each reaction', async () => {
    let step = 0;
    fetchResponder = (url) => {
      if (url.endsWith('/users/me')) return jsonResponse({ id: 'bot-user-id' });
      if (url.endsWith('/posts')) {
        return jsonResponse({ id: 'post-1', channel_id: 'c-123', message: 'hi', root_id: 'thread-root' });
      }
      if (url.endsWith('/reactions')) {
        step += 1;
        return jsonResponse({});
      }
      return jsonResponse({});
    };

    const posted = await makeApi().createInteractivePost(
      'Permission requested',
      ['+1', 'white_check_mark', '-1'],
      'thread-root',
    );
    expect(posted.id).toBe('post-1');

    // getBotUserId + createPost + 3 addReactions = 5 calls.
    expect(fetchCalls).toHaveLength(5);
    const createCall = fetchCalls.find(c => c.url.endsWith('/posts'));
    expect(createCall?.method).toBe('POST');
    const body = createCall?.body as Record<string, unknown>;
    expect(body.channel_id).toBe('c-123');
    expect(body.root_id).toBe('thread-root');

    const reactionCalls = fetchCalls.filter(c => c.url.endsWith('/reactions'));
    expect(reactionCalls.map(c => (c.body as { emoji_name: string }).emoji_name))
      .toEqual(['+1', 'white_check_mark', '-1']);
    expect(step).toBe(3);
  });

  it('continues adding reactions when one fails', async () => {
    const emojiFailures = new Set(['white_check_mark']);
    fetchResponder = (url, init) => {
      if (url.endsWith('/users/me')) return jsonResponse({ id: 'bot' });
      if (url.endsWith('/posts')) return jsonResponse({ id: 'post-1', channel_id: 'c', message: '', root_id: '' });
      if (url.endsWith('/reactions')) {
        const body = init?.body ? JSON.parse(init.body as string) as { emoji_name: string } : { emoji_name: '' };
        if (emojiFailures.has(body.emoji_name)) return errorResponse(500);
        return jsonResponse({});
      }
      return jsonResponse({});
    };

    const posted = await makeApi().createInteractivePost(
      'hi',
      ['+1', 'white_check_mark', '-1'],
    );
    // Post still created; partial reaction failure does not propagate.
    expect(posted.id).toBe('post-1');
    const reactionCalls = fetchCalls.filter(c => c.url.endsWith('/reactions'));
    expect(reactionCalls).toHaveLength(3);
  });
});

// -----------------------------------------------------------------------------
// updatePost — hits /posts/{id} with PUT
// -----------------------------------------------------------------------------

describe('MattermostMcpPlatformApi.updatePost', () => {
  it('PUTs to /posts/{id} with id + message body', async () => {
    fetchResponder = () => jsonResponse({ id: 'post-1', channel_id: 'c', message: 'updated', root_id: '' });
    await makeApi().updatePost('post-1', '✅ Allowed by alice');

    const call = fetchCalls[0];
    expect(call.method).toBe('PUT');
    expect(call.url).toBe('https://chat.example.test/api/v4/posts/post-1');
    const body = call.body as Record<string, unknown>;
    expect(body.id).toBe('post-1');
    expect(body.message).toBe('✅ Allowed by alice');
  });

  it('throws on non-2xx response', async () => {
    fetchResponder = () => errorResponse(500, 'boom');
    await expect(makeApi().updatePost('post-1', 'x')).rejects.toThrow(/500/);
  });
});

// -----------------------------------------------------------------------------
// Formatter exposure
// -----------------------------------------------------------------------------

describe('MattermostMcpPlatformApi.getFormatter', () => {
  it('returns a stable Mattermost formatter instance', () => {
    const api = makeApi();
    expect(api.getFormatter()).toBe(api.getFormatter());
  });
});
