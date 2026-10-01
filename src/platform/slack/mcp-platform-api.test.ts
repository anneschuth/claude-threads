/**
 * Unit tests for the Slack McpPlatformApi implementation.
 *
 * HTTP-level coverage of the read methods and the reaction wait. Responders
 * go through `slack()`, which holds the fake to Slack's real contract: a read
 * method only reads query parameters (or a form body), so a JSON POST to one
 * gets the error Slack returns. The old fake answered anything, which is how
 * #622 (every permission reaction rejected as `user_not_found`) shipped.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { createSlackMcpPlatformApi } from './mcp-platform-api.js';
import {
  installFetchHarness,
  jsonResponse,
  type FetchResponder,
} from '../test-helpers/fetch-harness.js';

let fetchResponder: FetchResponder = () => jsonResponse({ ok: true });

/** Slack methods that read data: Slack ignores a JSON body on these. */
const READ_METHODS = new Set([
  'users.info', 'conversations.history', 'conversations.replies', 'conversations.info',
  'conversations.members', 'reactions.get',
]);

type SlackHandler = (method: string, params: URLSearchParams) => Response | Promise<Response>;

/** A responder that behaves like Slack: read methods take their arguments from the query string only. */
function slack(handler: SlackHandler): FetchResponder {
  return (url, init) => {
    const parsed = new URL(url);
    const method = parsed.pathname.split('/').pop() ?? '';
    if (READ_METHODS.has(method) && (init?.method ?? 'GET') !== 'GET') {
      // What Slack answers when the arguments it needs are not in the query.
      return jsonResponse({ ok: false, error: method === 'users.info' ? 'user_not_found' : 'invalid_arguments' });
    }
    return handler(method, parsed.searchParams);
  };
}
const { calls: fetchCalls } = installFetchHarness(() => fetchResponder);

beforeEach(() => {
  fetchResponder = () => jsonResponse({ ok: true });
});

function makeApi() {
  return createSlackMcpPlatformApi({
    platformType: 'slack',
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
  it('GETs conversations.history with channel + ts and resolves the username', async () => {
    fetchResponder = slack((method) => {
      if (method === 'conversations.history') {
        return jsonResponse({
          ok: true,
          messages: [{ type: 'message', ts: '1234567890.123456', user: 'U-1', text: 'hi' }],
        });
      }
      if (method === 'users.info') {
        return jsonResponse({ ok: true, user: { id: 'U-1', name: 'alice' } });
      }
      return jsonResponse({ ok: false, error: 'not_found' });
    });
    const api = makeApi();
    const post = await api.readPost!('1234567890.123456');
    expect(post).not.toBeNull();
    expect(post!.id).toBe('1234567890.123456');
    expect(post!.userId).toBe('U-1');
    expect(post!.username).toBe('alice');
    expect(post!.message).toBe('hi');
    // Slack ts is seconds.microseconds — createAt is ms.
    expect(post!.createAt).toBe(1234567890123);

    const historyCall = fetchCalls.find(c => c.url.includes('/conversations.history'));
    expect(historyCall?.method).toBe('GET');
    const params = new URL(historyCall!.url).searchParams;
    expect(params.get('channel')).toBe('C0123456789');
    expect(params.get('latest')).toBe('1234567890.123456');
    expect(params.get('oldest')).toBe('1234567890.123456');
    expect(params.get('inclusive')).toBe('true');
    expect(params.get('limit')).toBe('1');
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
    fetchResponder = slack((method) => {
      if (method === 'conversations.history') {
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
    });
    const post = await makeApi().readPost!('1234567890.123457');
    expect(post?.threadRootId).toBe('1234567890.123456');
  });

  it('omits threadRootId for top-level posts (thread_ts equals ts)', async () => {
    fetchResponder = slack((method) => {
      if (method === 'conversations.history') {
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
    });
    const post = await makeApi().readPost!('1234567890.123456');
    expect(post?.threadRootId).toBeUndefined();
  });
});

// =============================================================================
// readThread
// =============================================================================

describe('SlackMcpPlatformApi.readThread', () => {
  it('GETs conversations.replies, sorts by ts, resolves usernames', async () => {
    fetchResponder = slack((method, params) => {
      if (method === 'conversations.replies') {
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
      if (method === 'users.info') {
        const user = params.get('user');
        return jsonResponse({ ok: true, user: { id: user, name: user === 'U-1' ? 'alice' : 'bob' } });
      }
      return jsonResponse({ ok: false });
    });
    const messages = await makeApi().readThread!('1234567890.000100');
    expect(messages.map(m => m.message)).toEqual(['first', 'second']);
    expect(messages.map(m => m.username)).toEqual(['alice', 'bob']);
  });

  it('caches per-user lookup so repeated authors are fetched once', async () => {
    fetchResponder = slack((method) => {
      if (method === 'conversations.replies') {
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
    });
    await makeApi().readThread!('1.1');
    const userCalls = fetchCalls.filter(c => c.url.includes('/users.info'));
    expect(userCalls).toHaveLength(1);
  });

  it('forwards the limit option to the API', async () => {
    fetchResponder = () => jsonResponse({ ok: true, messages: [] });
    await makeApi().readThread!('1.1', { limit: 7 });
    const repliesCall = fetchCalls.find(c => c.url.includes('/conversations.replies'));
    expect(new URL(repliesCall!.url).searchParams.get('limit')).toBe('7');
  });

  it('returns [] when the API errors', async () => {
    fetchResponder = () => jsonResponse({ ok: false, error: 'thread_not_found' });
    expect(await makeApi().readThread!('1.1')).toEqual([]);
  });
});

// =============================================================================
// getUsername and the other read methods (#622)
// =============================================================================

describe('SlackMcpPlatformApi read methods use GET (#622)', () => {
  it('getUsername resolves the user, where a JSON POST got user_not_found', async () => {
    fetchResponder = slack((method, params) => (method === 'users.info'
      ? jsonResponse({ ok: true, user: { id: params.get('user'), name: 'alice' } })
      : jsonResponse({ ok: false, error: 'unexpected' })));

    expect(await makeApi().getUsername('U-1')).toBe('alice');
    const call = fetchCalls.find((c) => c.url.includes('/users.info'));
    expect(call?.method).toBe('GET');
    expect(new URL(call!.url).searchParams.get('user')).toBe('U-1');
  });

  it('every read method reaches Slack as a GET', async () => {
    fetchResponder = slack((method) => {
      switch (method) {
        case 'conversations.history': return jsonResponse({ ok: true, messages: [] });
        case 'conversations.info': return jsonResponse({ ok: true, channel: { id: 'C1', is_private: false, name: 'general' } });
        case 'conversations.members': return jsonResponse({ ok: true, members: ['U-1'], response_metadata: { next_cursor: '' } });
        case 'users.info': return jsonResponse({ ok: true, user: { id: 'U0123ALICE', name: 'alice' } });
        default: return jsonResponse({ ok: true });
      }
    });
    const api = makeApi();
    expect(await api.readChannelHistory!('C1')).toEqual([]);
    expect(await api.getChannelInfo!('C1')).toMatchObject({ id: 'C1' });
    expect(await api.getChannelMembers!('C1')).toEqual(['U-1']);
    expect(await api.resolveRecipient!('U0123ALICE')).toMatchObject({ id: 'U0123ALICE', username: 'alice' });

    const reads = fetchCalls.filter((c) => READ_METHODS.has(new URL(c.url).pathname.split('/').pop() ?? ''));
    expect(reads.length).toBeGreaterThanOrEqual(4);
    expect(reads.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});

// =============================================================================
// waitForReaction (#622)
// =============================================================================

describe('SlackMcpPlatformApi.waitForReaction polls reactions.get (#622)', () => {
  // A second Socket Mode connection on the bot's app token shares Slack's
  // round-robin with the main bot, so it saw about half the reactions and
  // stole that half of the bot's events. The wait polls the post instead.
  function fastApi() {
    const api = makeApi();
    (api as unknown as { reactionPollMs: number }).reactionPollMs = 5;
    return api;
  }
  const reactions = (list: Array<{ name: string; users: string[] }>) => jsonResponse({ ok: true, type: 'message', message: { reactions: list } });

  it('returns the first reaction by someone other than the bot, without opening a socket', async () => {
    let polls = 0;
    fetchResponder = slack((method, params) => {
      if (method !== 'reactions.get') return jsonResponse({ ok: false, error: 'unexpected' });
      expect(params.get('channel')).toBe('C0123456789');
      expect(params.get('timestamp')).toBe('1.5');
      polls++;
      // The bot's own option reactions are there from the start; the user's
      // reaction arrives on the third poll.
      return reactions(polls < 3
        ? [{ name: '+1', users: ['U-BOT'] }]
        : [{ name: '+1', users: ['U-BOT'] }, { name: '-1', users: ['U-BOT', 'U-ALICE'] }]);
    });

    const event = await fastApi().waitForReaction('1.5', 'U-BOT', 2000);
    expect(event).toEqual({ postId: '1.5', userId: 'U-ALICE', emojiName: '-1' });
    expect(fetchCalls.some((c) => c.url.includes('apps.connections.open'))).toBe(false);
  });

  it('does not hand back the same reaction twice', async () => {
    // The caller loops when a reaction is not authorized; returning the same
    // (user, emoji) again would spin on it until the timeout.
    fetchResponder = slack(() => reactions([{ name: '+1', users: ['U-BOT', 'U-MALLORY'] }]));
    const api = fastApi();
    expect(await api.waitForReaction('1.5', 'U-BOT', 2000)).toMatchObject({ userId: 'U-MALLORY' });
    expect(await api.waitForReaction('1.5', 'U-BOT', 60)).toBeNull();
  });

  it('times out with null when nobody reacts', async () => {
    fetchResponder = slack(() => reactions([{ name: '+1', users: ['U-BOT'] }]));
    const started = Date.now();
    expect(await fastApi().waitForReaction('1.5', 'U-BOT', 80)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('backs off on a rate limit instead of hammering Slack', async () => {
    let calls = 0;
    fetchResponder = slack(() => {
      calls++;
      if (calls === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '1' } });
      return reactions([{ name: '+1', users: ['U-ALICE'] }]);
    });
    const started = Date.now();
    const event = await fastApi().waitForReaction('1.5', 'U-BOT', 5000);
    expect(event).toMatchObject({ userId: 'U-ALICE' });
    // Retry-After: 1 second, not the 5 ms poll interval.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(calls).toBe(2);
  });
});

describe('SlackMcpPlatformApi.waitForReaction after review (#622)', () => {
  const reactions = (list: Array<{ name: string; users: string[] }>) => jsonResponse({ ok: true, type: 'message', message: { reactions: list } });

  it('offers a reaction again once the seen window has passed', async () => {
    // A reaction is marked seen before the caller checks the user. When that
    // check failed for a passing reason (a 429 on users.info), the reaction
    // must come back later, or a valid approval is lost for good.
    fetchResponder = slack(() => reactions([{ name: '+1', users: ['U-ALICE'] }]));
    const api = makeApi();
    Object.assign(api as object, { reactionPollMs: 5, seenTtlMs: 40 });
    expect(await api.waitForReaction('1.5', 'U-BOT', 2000)).toMatchObject({ userId: 'U-ALICE' });
    expect(await api.waitForReaction('1.5', 'U-BOT', 20)).toBeNull(); // inside the window
    expect(await api.waitForReaction('1.5', 'U-BOT', 2000)).toMatchObject({ userId: 'U-ALICE' }); // after it
  });

  it('polls less often once a prompt has waited a while', async () => {
    // Every open prompt polls reactions.get; several at once approach
    // Slack's per-app rate limit, so a long wait slows down.
    let calls = 0;
    fetchResponder = slack(() => { calls++; return reactions([]); });
    const api = makeApi();
    Object.assign(api as object, { reactionPollMs: 5, reactionSlowPollMs: 60, reactionSlowAfterMs: 0 });
    await api.waitForReaction('1.5', 'U-BOT', 150);
    expect(calls).toBeLessThanOrEqual(4);
  });
});

describe('SlackMcpPlatformApi honours the configured API base (#622 review)', () => {
  it('sends every call there, including the option reactions', async () => {
    // Two calls still went to the hardcoded slack.com: the 👍 ✅ 👎 option
    // reactions and addReaction. Against the test mock (or any apiUrl
    // override) the prompt then had no buttons.
    fetchResponder = slack((method) => {
      if (method === 'chat.postMessage') return jsonResponse({ ok: true, ts: '1.5', channel: 'C0123456789' });
      if (method === 'auth.test') return jsonResponse({ ok: true, user_id: 'U-BOT' });
      return jsonResponse({ ok: true });
    });
    const api = createSlackMcpPlatformApi({
      platformType: 'slack', botToken: 'xoxb-bot', appToken: '', channelId: 'C0123456789',
      threadTs: '1.0', allowedUsers: ['alice'], debug: false, apiUrl: 'http://slack-mock.test/api',
    });
    await api.createInteractivePost('Permission requested', ['+1', 'white_check_mark', '-1'], '1.0');
    await api.addReaction!('1.5', 'eyes');

    expect(fetchCalls.length).toBeGreaterThanOrEqual(4);
    expect(fetchCalls.filter((c) => !c.url.startsWith('http://slack-mock.test/api/')).map((c) => c.url)).toEqual([]);
  });
});
