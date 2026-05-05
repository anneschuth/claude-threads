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

import { describe, it, expect, beforeEach } from 'bun:test';
import { createMattermostMcpPlatformApi } from './mcp-platform-api.js';
import {
  installFetchHarness,
  jsonResponse,
  errorResponse,
  type FetchResponder,
} from '../test-helpers/fetch-harness.js';

let fetchResponder: FetchResponder = () => jsonResponse({});
const { calls: fetchCalls } = installFetchHarness(() => fetchResponder);

beforeEach(() => {
  fetchResponder = () => jsonResponse({});
});

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

// -----------------------------------------------------------------------------
// readPost — hits /posts/{id}
// -----------------------------------------------------------------------------

describe('MattermostMcpPlatformApi.readPost', () => {
  it('GETs /posts/{id} with Bearer auth and resolves the username', async () => {
    fetchResponder = (url) => {
      if (url.endsWith('/posts/post-1')) {
        return jsonResponse({ id: 'post-1', channel_id: 'c', message: 'hi', user_id: 'u-1', create_at: 1234, root_id: '' });
      }
      if (url.endsWith('/users/u-1')) {
        return jsonResponse({ id: 'u-1', username: 'alice' });
      }
      return errorResponse(404);
    };
    const api = makeApi();
    const post = await api.readPost!('post-1');
    expect(post).not.toBeNull();
    expect(post!.id).toBe('post-1');
    expect(post!.username).toBe('alice');
    expect(post!.message).toBe('hi');
    expect(post!.createAt).toBe(1234);
    expect(post!.threadRootId).toBeUndefined();

    const postCall = fetchCalls.find(c => c.url.endsWith('/posts/post-1'));
    expect(postCall?.method).toBe('GET');
    expect(postCall?.headers.Authorization).toBe('Bearer secret-token');
  });

  it('returns null on 404 instead of throwing', async () => {
    fetchResponder = () => errorResponse(404, 'not found');
    const api = makeApi();
    expect(await api.readPost!('missing')).toBeNull();
  });

  it('returns null on 403 (no access) instead of throwing', async () => {
    fetchResponder = () => errorResponse(403, 'forbidden');
    const api = makeApi();
    expect(await api.readPost!('forbidden-id')).toBeNull();
  });

  it('preserves threadRootId when the post is a reply', async () => {
    fetchResponder = (url) => {
      if (url.endsWith('/posts/reply-1')) {
        return jsonResponse({ id: 'reply-1', channel_id: 'c', message: 'r', user_id: 'u-1', create_at: 2, root_id: 'root-1' });
      }
      return jsonResponse({ id: 'u-1', username: 'alice' });
    };
    const post = await makeApi().readPost!('reply-1');
    expect(post?.threadRootId).toBe('root-1');
  });

  it('still returns the post when the user lookup 404s', async () => {
    fetchResponder = (url) => {
      if (url.endsWith('/posts/post-1')) {
        return jsonResponse({ id: 'post-1', channel_id: 'c', message: 'hi', user_id: 'u-missing', create_at: 1 });
      }
      return errorResponse(404);
    };
    const post = await makeApi().readPost!('post-1');
    expect(post).not.toBeNull();
    expect(post!.username).toBeNull();
  });

  it('exposes the post channel on the returned McpPost so the resolver can scope', async () => {
    // The API does not gate on channel — that's the resolver's job. We
    // just need to make sure channelId comes through faithfully so the
    // resolver can compare.
    fetchResponder = (url) => {
      if (url.endsWith('/posts/post-1')) {
        return jsonResponse({
          id: 'post-1',
          channel_id: 'some-channel',
          message: 'hi',
          user_id: 'u-1',
          create_at: 1,
        });
      }
      return jsonResponse({ id: 'u-1', username: 'alice' });
    };
    const post = await makeApi().readPost!('post-1');
    expect(post?.channelId).toBe('some-channel');
  });

  it('marks public channels (Mattermost type "O") as public', async () => {
    fetchResponder = (url) => {
      if (url.endsWith('/posts/post-1')) {
        return jsonResponse({
          id: 'post-1',
          channel_id: 'c-public',
          message: 'hi',
          user_id: 'u-1',
          create_at: 1,
        });
      }
      if (url.endsWith('/channels/c-public')) {
        return jsonResponse({ id: 'c-public', type: 'O' });
      }
      return jsonResponse({ id: 'u-1', username: 'alice' });
    };
    const post = await makeApi().readPost!('post-1');
    expect(post?.channelType).toBe('public');
  });

  it('marks private channels (type "P") as private', async () => {
    fetchResponder = (url) => {
      if (url.endsWith('/posts/post-1')) {
        return jsonResponse({
          id: 'post-1',
          channel_id: 'c-private',
          message: 'hi',
          user_id: 'u-1',
          create_at: 1,
        });
      }
      if (url.endsWith('/channels/c-private')) {
        return jsonResponse({ id: 'c-private', type: 'P' });
      }
      return jsonResponse({ id: 'u-1', username: 'alice' });
    };
    const post = await makeApi().readPost!('post-1');
    expect(post?.channelType).toBe('private');
  });

  it('marks DMs (type "D") and group DMs (type "G") as private', async () => {
    for (const t of ['D', 'G'] as const) {
      fetchResponder = (url) => {
        if (url.endsWith('/posts/post-1')) {
          return jsonResponse({
            id: 'post-1',
            channel_id: `c-${t}`,
            message: 'hi',
            user_id: 'u-1',
            create_at: 1,
          });
        }
        if (url.endsWith(`/channels/c-${t}`)) {
          return jsonResponse({ id: `c-${t}`, type: t });
        }
        return jsonResponse({ id: 'u-1', username: 'alice' });
      };
      const post = await makeApi().readPost!('post-1');
      expect(post?.channelType).toBe('private');
    }
  });

  it('leaves channelType undefined when the channel lookup fails', async () => {
    // Fail-safe: if we can't classify the channel, the resolver treats
    // it as private. Test exercises that no exception bubbles up.
    fetchResponder = (url) => {
      if (url.endsWith('/posts/post-1')) {
        return jsonResponse({
          id: 'post-1',
          channel_id: 'c-unknown',
          message: 'hi',
          user_id: 'u-1',
          create_at: 1,
        });
      }
      if (url.endsWith('/channels/c-unknown')) {
        return errorResponse(403, 'forbidden');
      }
      return jsonResponse({ id: 'u-1', username: 'alice' });
    };
    const post = await makeApi().readPost!('post-1');
    expect(post).not.toBeNull();
    expect(post!.channelType).toBeUndefined();
  });

  it('caches channel-type lookups across reads', async () => {
    let channelCalls = 0;
    fetchResponder = (url) => {
      if (url.includes('/posts/post-1') || url.includes('/posts/post-2')) {
        const id = url.endsWith('/posts/post-1') ? 'post-1' : 'post-2';
        return jsonResponse({
          id,
          channel_id: 'c-shared',
          message: 'hi',
          user_id: 'u-1',
          create_at: 1,
        });
      }
      if (url.endsWith('/channels/c-shared')) {
        channelCalls += 1;
        return jsonResponse({ id: 'c-shared', type: 'O' });
      }
      return jsonResponse({ id: 'u-1', username: 'alice' });
    };
    const api = makeApi();
    await api.readPost!('post-1');
    await api.readPost!('post-2');
    expect(channelCalls).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// readThread — hits /posts/{id}/thread, sorts, applies limit
// -----------------------------------------------------------------------------

describe('MattermostMcpPlatformApi.readThread', () => {
  it('GETs /posts/{rootId}/thread, sorts chronologically, resolves usernames', async () => {
    fetchResponder = (url) => {
      if (url.endsWith('/posts/root-1/thread')) {
        return jsonResponse({
          // Intentionally out of order to verify sorting.
          order: ['p-2', 'p-1'],
          posts: {
            'p-1': { id: 'p-1', channel_id: 'c', message: 'first', user_id: 'u-1', create_at: 100, root_id: '' },
            'p-2': { id: 'p-2', channel_id: 'c', message: 'second', user_id: 'u-2', create_at: 200, root_id: 'root-1' },
          },
        });
      }
      if (url.endsWith('/users/u-1')) return jsonResponse({ id: 'u-1', username: 'alice' });
      if (url.endsWith('/users/u-2')) return jsonResponse({ id: 'u-2', username: 'bob' });
      return errorResponse(404);
    };
    const messages = await makeApi().readThread!('root-1');
    expect(messages.map(m => m.id)).toEqual(['p-1', 'p-2']);
    expect(messages.map(m => m.username)).toEqual(['alice', 'bob']);
  });

  it('caches per-user lookup so the same author is fetched once', async () => {
    fetchResponder = (url) => {
      if (url.endsWith('/posts/root-1/thread')) {
        return jsonResponse({
          order: ['p-1', 'p-2', 'p-3'],
          posts: {
            'p-1': { id: 'p-1', channel_id: 'c', message: 'a', user_id: 'u-1', create_at: 1, root_id: '' },
            'p-2': { id: 'p-2', channel_id: 'c', message: 'b', user_id: 'u-1', create_at: 2, root_id: 'root-1' },
            'p-3': { id: 'p-3', channel_id: 'c', message: 'c', user_id: 'u-1', create_at: 3, root_id: 'root-1' },
          },
        });
      }
      if (url.endsWith('/users/u-1')) return jsonResponse({ id: 'u-1', username: 'alice' });
      return errorResponse(404);
    };
    await makeApi().readThread!('root-1');
    const userCalls = fetchCalls.filter(c => c.url.endsWith('/users/u-1'));
    expect(userCalls).toHaveLength(1);
  });

  it('applies limit by keeping the most recent N (after sorting)', async () => {
    fetchResponder = (url) => {
      if (url.endsWith('/thread')) {
        return jsonResponse({
          order: ['p-1', 'p-2', 'p-3'],
          posts: {
            'p-1': { id: 'p-1', channel_id: 'c', message: 'a', user_id: 'u-1', create_at: 1 },
            'p-2': { id: 'p-2', channel_id: 'c', message: 'b', user_id: 'u-1', create_at: 2 },
            'p-3': { id: 'p-3', channel_id: 'c', message: 'c', user_id: 'u-1', create_at: 3 },
          },
        });
      }
      return jsonResponse({ id: 'u-1', username: 'alice' });
    };
    const messages = await makeApi().readThread!('root-1', { limit: 2 });
    expect(messages.map(m => m.id)).toEqual(['p-2', 'p-3']);
  });

  it('returns [] on 404 instead of throwing', async () => {
    fetchResponder = () => errorResponse(404, 'not found');
    expect(await makeApi().readThread!('missing')).toEqual([]);
  });
});
