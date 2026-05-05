/**
 * Unit tests for the Slack McpPlatformApi implementation.
 *
 * Scope: HTTP-level coverage for readPost / readThread (added with the
 * permalink-follower feature). The other surface area (createInteractivePost,
 * waitForReaction, uploadFile, etc.) is exercised by integration tests
 * since it depends on Socket Mode WebSockets.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createSlackMcpPlatformApi } from './mcp-platform-api.js';

// -----------------------------------------------------------------------------
// Fetch harness
// -----------------------------------------------------------------------------

type FetchResponder = (url: string, init?: RequestInit) => Promise<Response> | Response;

let fetchResponder: FetchResponder = () =>
  new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
let fetchCalls: Array<{ url: string; method: string; body?: unknown }> = [];

const originalFetch = global.fetch;
beforeEach(() => {
  fetchCalls = [];
  global.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    fetchCalls.push({ url: urlStr, method, body });
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

function makeApi() {
  return createSlackMcpPlatformApi({
    botToken: 'xoxb-bot',
    appToken: 'xapp-app',
    channelId: 'C0123456789',
    threadTs: '1234567890.123456',
    allowedUsers: ['alice', 'bob'],
    debug: false,
  });
}

// =============================================================================
// readPost
// =============================================================================

describe('SlackMcpPlatformApi.readPost', () => {
  it('POSTs conversations.history with channel + ts and resolves the username', async () => {
    fetchResponder = (url) => {
      if (url.endsWith('/conversations.history')) {
        return jsonResponse({
          ok: true,
          messages: [{ type: 'message', ts: '1234567890.123456', user: 'U-1', text: 'hi' }],
        });
      }
      if (url.endsWith('/users.info')) {
        return jsonResponse({ ok: true, user: { id: 'U-1', name: 'alice' } });
      }
      return jsonResponse({ ok: false, error: 'not_found' });
    };
    const api = makeApi();
    const post = await api.readPost!('1234567890.123456');
    expect(post).not.toBeNull();
    expect(post!.id).toBe('1234567890.123456');
    expect(post!.userId).toBe('U-1');
    expect(post!.username).toBe('alice');
    expect(post!.message).toBe('hi');
    // Slack ts is seconds.microseconds — createAt is ms.
    expect(post!.createAt).toBe(1234567890123);

    const historyCall = fetchCalls.find(c => c.url.endsWith('/conversations.history'));
    expect(historyCall?.method).toBe('POST');
    const body = historyCall?.body as Record<string, unknown>;
    expect(body.channel).toBe('C0123456789');
    expect(body.latest).toBe('1234567890.123456');
    expect(body.oldest).toBe('1234567890.123456');
    expect(body.inclusive).toBe(true);
    expect(body.limit).toBe(1);
  });

  it('returns null when conversations.history returns ok:false', async () => {
    fetchResponder = () => jsonResponse({ ok: false, error: 'channel_not_found' });
    expect(await makeApi().readPost!('1234567890.123456')).toBeNull();
  });

  it('returns null when no message matches the requested ts', async () => {
    // Slack returns the closest message to `latest` even when nothing
    // matches exactly; we should treat a mismatch as not-found.
    fetchResponder = () => jsonResponse({
      ok: true,
      messages: [{ type: 'message', ts: '9999999999.000000', user: 'U-1', text: 'wrong' }],
    });
    expect(await makeApi().readPost!('1234567890.123456')).toBeNull();
  });

  it('returns null when messages array is empty', async () => {
    fetchResponder = () => jsonResponse({ ok: true, messages: [] });
    expect(await makeApi().readPost!('1234567890.123456')).toBeNull();
  });

  it('preserves threadRootId when the post is a reply (thread_ts != ts)', async () => {
    fetchResponder = (url) => {
      if (url.endsWith('/conversations.history')) {
        return jsonResponse({
          ok: true,
          messages: [{
            type: 'message',
            ts: '1234567890.123457',
            thread_ts: '1234567890.123456',
            user: 'U-1',
            text: 'reply',
          }],
        });
      }
      return jsonResponse({ ok: true, user: { id: 'U-1', name: 'alice' } });
    };
    const post = await makeApi().readPost!('1234567890.123457');
    expect(post?.threadRootId).toBe('1234567890.123456');
  });

  it('omits threadRootId for top-level posts (thread_ts equals ts)', async () => {
    fetchResponder = (url) => {
      if (url.endsWith('/conversations.history')) {
        return jsonResponse({
          ok: true,
          messages: [{
            type: 'message',
            ts: '1234567890.123456',
            thread_ts: '1234567890.123456',
            user: 'U-1',
            text: 'parent',
          }],
        });
      }
      return jsonResponse({ ok: true, user: { id: 'U-1', name: 'alice' } });
    };
    const post = await makeApi().readPost!('1234567890.123456');
    expect(post?.threadRootId).toBeUndefined();
  });
});

// =============================================================================
// readThread
// =============================================================================

describe('SlackMcpPlatformApi.readThread', () => {
  it('POSTs conversations.replies, sorts by ts, resolves usernames', async () => {
    fetchResponder = (url, init) => {
      if (url.endsWith('/conversations.replies')) {
        return jsonResponse({
          ok: true,
          // Intentionally out of order to exercise the sort.
          messages: [
            { type: 'message', ts: '1234567890.000200', user: 'U-2', text: 'second' },
            { type: 'message', ts: '1234567890.000100', user: 'U-1', text: 'first' },
          ],
          has_more: false,
        });
      }
      if (url.endsWith('/users.info')) {
        const body = JSON.parse(init?.body as string) as { user: string };
        return jsonResponse({ ok: true, user: { id: body.user, name: body.user === 'U-1' ? 'alice' : 'bob' } });
      }
      return jsonResponse({ ok: false });
    };
    const messages = await makeApi().readThread!('1234567890.000100');
    expect(messages.map(m => m.message)).toEqual(['first', 'second']);
    expect(messages.map(m => m.username)).toEqual(['alice', 'bob']);
  });

  it('caches per-user lookup so repeated authors are fetched once', async () => {
    fetchResponder = (url) => {
      if (url.endsWith('/conversations.replies')) {
        return jsonResponse({
          ok: true,
          messages: [
            { type: 'message', ts: '1.1', user: 'U-1', text: 'a' },
            { type: 'message', ts: '1.2', user: 'U-1', text: 'b' },
            { type: 'message', ts: '1.3', user: 'U-1', text: 'c' },
          ],
        });
      }
      return jsonResponse({ ok: true, user: { id: 'U-1', name: 'alice' } });
    };
    await makeApi().readThread!('1.1');
    const userCalls = fetchCalls.filter(c => c.url.endsWith('/users.info'));
    expect(userCalls).toHaveLength(1);
  });

  it('forwards the limit option to the API', async () => {
    fetchResponder = () => jsonResponse({ ok: true, messages: [] });
    await makeApi().readThread!('1.1', { limit: 7 });
    const repliesCall = fetchCalls.find(c => c.url.endsWith('/conversations.replies'));
    expect((repliesCall?.body as Record<string, unknown>).limit).toBe(7);
  });

  it('returns [] when the API errors', async () => {
    fetchResponder = () => jsonResponse({ ok: false, error: 'thread_not_found' });
    expect(await makeApi().readThread!('1.1')).toEqual([]);
  });
});
