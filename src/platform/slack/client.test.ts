/**
 * Slack client unit tests
 *
 * Tests for Slack-specific functionality, including emoji handling and the
 * SlackClient HTTP surface (fetch-backed).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { getEmojiName } from '../utils.js';
import { SlackClient } from './client.js';
import type { SlackPlatformConfig } from '../../config/types.js';

describe('Slack Client Emoji Handling', () => {
  describe('getEmojiName conversion for reactions', () => {
    it('converts Unicode thumbs up to +1', () => {
      expect(getEmojiName('👍')).toBe('+1');
    });

    it('converts Unicode thumbs down to -1', () => {
      expect(getEmojiName('👎')).toBe('-1');
    });

    it('converts Unicode checkmark to white_check_mark', () => {
      expect(getEmojiName('✅')).toBe('white_check_mark');
    });

    it('converts Unicode X to x', () => {
      expect(getEmojiName('❌')).toBe('x');
    });

    it('passes through already-valid emoji names', () => {
      expect(getEmojiName('+1')).toBe('+1');
      expect(getEmojiName('-1')).toBe('-1');
      expect(getEmojiName('white_check_mark')).toBe('white_check_mark');
      expect(getEmojiName('thumbsup')).toBe('thumbsup');
    });

    it('passes through unknown emoji unchanged', () => {
      expect(getEmojiName('custom_emoji')).toBe('custom_emoji');
      expect(getEmojiName('🦄')).toBe('🦄');
    });
  });

  describe('reaction emoji used in update prompts', () => {
    const updatePromptEmoji = ['👍', '👎'];
    it('converts all update prompt emoji to valid Slack names', () => {
      const converted = updatePromptEmoji.map(getEmojiName);
      expect(converted).toEqual(['+1', '-1']);
    });
  });

  describe('reaction emoji used in permission prompts', () => {
    const permissionPromptEmoji = ['👍', '✅', '👎'];
    it('converts all permission prompt emoji to valid Slack names', () => {
      const converted = permissionPromptEmoji.map(getEmojiName);
      expect(converted).toEqual(['+1', 'white_check_mark', '-1']);
    });
  });

  describe('reaction emoji used in message approval', () => {
    const messageApprovalEmoji = ['👍', '✅', '👎'];
    it('converts all message approval emoji to valid Slack names', () => {
      const converted = messageApprovalEmoji.map(getEmojiName);
      expect(converted).toEqual(['+1', 'white_check_mark', '-1']);
    });
  });
});

// -----------------------------------------------------------------------------
// SlackClient tests — fetch is stubbed; Socket Mode paths are exercised via
// pure helpers that don't need a WebSocket.
// -----------------------------------------------------------------------------

type FetchResponder = (url: string, init?: RequestInit) => Promise<Response> | Response;

let fetchResponder: FetchResponder = () =>
  new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
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

function ok(body: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ ok: true, ...body }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function notOk(error: string, status = 200): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function httpError(status: number, text = 'server error'): Response {
  return new Response(text, { status });
}

function makeConfig(overrides: Partial<SlackPlatformConfig> = {}): SlackPlatformConfig {
  return {
    id: 'slack-main',
    type: 'slack',
    displayName: 'Slack Main',
    botToken: 'xoxb-bot-token',
    appToken: 'xapp-app-token',
    channelId: 'C123',
    botName: 'claude',
    allowedUsers: ['alice', 'bob'],
    skipPermissions: false,
    apiUrl: 'https://mock.slack.test/api',
    ...overrides,
  };
}

function makeClient(overrides: Partial<SlackPlatformConfig> = {}): SlackClient {
  return new SlackClient(makeConfig(overrides));
}

async function primeBotUser(client: SlackClient, userId = 'U-BOT') {
  fetchResponder = (url) => {
    if (url.endsWith('auth.test')) return ok({ user_id: userId, url: 'https://team.slack.com/' });
    if (url.includes('users.info')) {
      return ok({ user: { id: userId, name: 'claude', real_name: 'Claude', profile: {} } });
    }
    return ok();
  };
  await client.getBotUser();
  fetchCalls = [];
}

describe('SlackClient pure helpers', () => {
  it('getMessageLimits returns Slack-specific stricter limits', () => {
    expect(makeClient().getMessageLimits()).toEqual({ maxLength: 12000, hardThreshold: 10000 });
  });

  it('isBotMentioned detects <@USERID> mentions when bot user id is known', async () => {
    const c = makeClient();
    await primeBotUser(c, 'U-BOT');
    expect(c.isBotMentioned('<@U-BOT> hello')).toBe(true);
    expect(c.isBotMentioned('<@U-OTHER> hi')).toBe(false);
  });

  it('isBotMentioned detects @botname (case-insensitive)', () => {
    const c = makeClient({ botName: 'claude' });
    expect(c.isBotMentioned('@claude help')).toBe(true);
    expect(c.isBotMentioned('@CLAUDE help')).toBe(true);
    expect(c.isBotMentioned('claude help')).toBe(false);
  });

  it('extractPrompt strips <@USERID> mentions when bot user id is known', async () => {
    const c = makeClient();
    await primeBotUser(c, 'U-BOT');
    expect(c.extractPrompt('<@U-BOT> do something')).toBe('do something');
    expect(c.extractPrompt('hey <@U-BOT>, fix this')).toBe('hey , fix this');
  });

  it('extractPrompt strips @botname mentions', () => {
    const c = makeClient({ botName: 'claude' });
    expect(c.extractPrompt('@claude write code')).toBe('write code');
  });

  it('sendTyping is a no-op and does not throw', () => {
    expect(() => makeClient().sendTyping()).not.toThrow();
  });

  it('platform identity fields reflect config', () => {
    const c = makeClient({ id: 'slack-x', displayName: 'X' });
    expect(c.platformId).toBe('slack-x');
    expect(c.displayName).toBe('X');
    expect(c.platformType).toBe('slack');
  });

  it('getFormatter returns a stable formatter instance', () => {
    const c = makeClient();
    expect(c.getFormatter()).toBe(c.getFormatter());
  });
});

describe('SlackClient API methods', () => {
  it('createPost calls chat.postMessage with channel + thread + unfurl flags', async () => {
    fetchResponder = () =>
      ok({ ts: '1000.0001', channel: 'C123', message: { text: 'hi' } });
    const post = await makeClient().createPost('hi', '999.0001');
    expect(post.id).toBe('1000.0001');
    expect(post.channelId).toBe('C123');
    expect(post.rootId).toBe('999.0001');

    const call = fetchCalls[0];
    expect(call.url).toBe('https://mock.slack.test/api/chat.postMessage');
    expect(call.method).toBe('POST');
    expect(call.headers.Authorization).toBe('Bearer xoxb-bot-token');
    const body = call.body as Record<string, unknown>;
    expect(body.channel).toBe('C123');
    expect(body.thread_ts).toBe('999.0001');
    expect(body.unfurl_links).toBe(true);
  });

  it('createPost disables unfurling for channel-level posts by default', async () => {
    fetchResponder = () => ok({ ts: '1.1', channel: 'C123', message: { text: 'ping' } });
    await makeClient().createPost('ping');
    const body = fetchCalls[0].body as Record<string, unknown>;
    expect(body.unfurl_links).toBe(false);
    expect(body.thread_ts).toBeUndefined();
  });

  it('createPost allows explicit unfurl=true for channel-level posts', async () => {
    fetchResponder = () => ok({ ts: '1.1', channel: 'C123', message: { text: 'ping' } });
    await makeClient().createPost('ping', undefined, { unfurl: true });
    const body = fetchCalls[0].body as Record<string, unknown>;
    expect(body.unfurl_links).toBe(true);
  });

  it('createPost truncates oversized messages before sending', async () => {
    fetchResponder = () => ok({ ts: '1.1', channel: 'C123', message: { text: 'truncated' } });
    const bigMessage = 'x'.repeat(20_000);
    await makeClient().createPost(bigMessage);
    const body = fetchCalls[0].body as Record<string, unknown>;
    expect((body.text as string).length).toBeLessThanOrEqual(12_200);
    expect(body.text).toContain('(truncated)');
  });

  it('updatePost calls chat.update', async () => {
    fetchResponder = () =>
      ok({ ts: '100.1', channel: 'C123', text: 'updated' });
    const post = await makeClient().updatePost('100.1', 'updated');
    expect(post.message).toBe('updated');
    expect(fetchCalls[0].url).toContain('chat.update');
  });

  it('addReaction posts to reactions.add', async () => {
    fetchResponder = () => ok();
    await makeClient().addReaction('100.1', '+1');
    expect(fetchCalls[0].url).toContain('reactions.add');
    const body = fetchCalls[0].body as Record<string, unknown>;
    expect(body.name).toBe('+1');
    expect(body.timestamp).toBe('100.1');
  });

  it('removeReaction posts to reactions.remove', async () => {
    fetchResponder = () => ok();
    await makeClient().removeReaction('100.1', '+1');
    expect(fetchCalls[0].url).toContain('reactions.remove');
  });

  it('pinPost swallows already_pinned errors', async () => {
    fetchResponder = () => notOk('already_pinned');
    await expect(makeClient().pinPost('100.1')).resolves.toBeUndefined();
  });

  it('unpinPost swallows no_pin errors', async () => {
    fetchResponder = () => notOk('no_pin');
    await expect(makeClient().unpinPost('100.1')).resolves.toBeUndefined();
  });

  it('pinPost rethrows unexpected errors', async () => {
    fetchResponder = () => notOk('something_else');
    await expect(makeClient().pinPost('100.1')).rejects.toThrow(/something_else/);
  });

  it('getPost returns null on API error', async () => {
    fetchResponder = () => notOk('channel_not_found');
    const post = await makeClient().getPost('100.1');
    expect(post).toBeNull();
  });

  it('getPinnedPosts returns timestamps from items', async () => {
    fetchResponder = () => ok({
      items: [
        { message: { ts: '1.1' } },
        { message: { ts: '2.2' } },
        { /* no message */ },
      ],
    });
    const ids = await makeClient().getPinnedPosts();
    expect(ids).toEqual(['1.1', '2.2']);
  });

  it('getThreadHistory sorts chronologically and filters bot messages', async () => {
    const c = makeClient();
    await primeBotUser(c, 'U-BOT');
    fetchResponder = (url) => {
      if (url.includes('conversations.replies')) {
        return ok({
          messages: [
            { ts: '300.0', user: 'U-ALICE', text: 'first' },
            { ts: '100.0', user: 'U-ALICE', text: 'second' },
            { ts: '200.0', user: 'U-BOT', text: 'bot reply' },
          ],
        });
      }
      if (url.includes('users.info')) {
        return ok({ user: { id: 'U-ALICE', name: 'alice', real_name: 'Alice', profile: {} } });
      }
      return ok();
    };
    const history = await c.getThreadHistory('thread-1', { excludeBotMessages: true });
    expect(history).toHaveLength(2);
    expect(history.every(m => m.username === 'alice')).toBe(true);
  });

  it('getThreadHistory returns [] on API error', async () => {
    fetchResponder = () => notOk('channel_not_found');
    const history = await makeClient().getThreadHistory('thread-1');
    expect(history).toEqual([]);
  });

  it('getUser caches by user id', async () => {
    const c = makeClient();
    let calls = 0;
    fetchResponder = (url) => {
      if (url.includes('users.info?user=U-1')) {
        calls += 1;
        return ok({ user: { id: 'U-1', name: 'alice', real_name: 'Alice', profile: {} } });
      }
      return ok();
    };
    const first = await c.getUser('U-1');
    const second = await c.getUser('U-1');
    expect(first?.username).toBe('alice');
    expect(second?.username).toBe('alice');
    expect(calls).toBe(1);
  });

  it('getUser returns null when userId is empty', async () => {
    expect(await makeClient().getUser('')).toBeNull();
  });

  it('getUser returns null on API error', async () => {
    fetchResponder = () => notOk('user_not_found');
    expect(await makeClient().getUser('U-missing')).toBeNull();
  });

  it('api() throws on HTTP non-2xx', async () => {
    fetchResponder = () => httpError(500, 'server error');
    await expect(makeClient().getPinnedPosts()).rejects.toThrow(/500/);
  });

  it('downloadFile fetches the private URL with bot token', async () => {
    let second = false;
    fetchResponder = (_url) => {
      if (!second) {
        second = true;
        return ok({
          file: {
            url_private: 'https://files.test/abc',
            id: 'F1', name: 'x', size: 3, mimetype: 'text/plain',
          },
        });
      }
      return new Response(new Uint8Array([7, 8, 9]), { status: 200 });
    };
    const buf = await makeClient().downloadFile('F1');
    expect(buf.length).toBe(3);
  });

  it('downloadFile throws when no download URL is available', async () => {
    fetchResponder = () => ok({ file: { id: 'F1', name: 'x', size: 0, mimetype: '' } });
    await expect(makeClient().downloadFile('F1')).rejects.toThrow(/No download URL/);
  });
});
