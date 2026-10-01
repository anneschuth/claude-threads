/**
 * Slack implementation of McpPlatformApi
 *
 * Handles MCP-side platform operations via the Slack Web API.
 *
 * Key differences from Mattermost:
 * - No WebSocket of its own: the main bot already holds the app's Socket Mode
 *   connection, and Slack round-robins events across every open connection of
 *   an app, so a second one here missed about half the reactions and stole
 *   that half of the bot's events (#622). Reactions are polled instead.
 * - Messages are identified by channel + timestamp (ts), not by ID
 * - User mentions use <@USER_ID> format, not @username
 */

import type {
  McpPlatformApi,
  ReactionEvent,
  PostedMessage,
  McpPost,
} from '../mcp-platform-api.js';
import type { PlatformFormatter } from '../formatter.js';
import type {
  AuthTestResponse,
  PostMessageResponse,
  UpdateMessageResponse,
  UsersInfoResponse,
  ConversationsHistoryResponse,
  ConversationsInfoResponse,
  ConversationsMembersResponse,
  ConversationsOpenResponse,
  ConversationsRepliesResponse,
  ReactionsGetResponse,
  SlackMessage,
} from './types.js';
import { mcpLogger } from '../../utils/logger.js';
import { SlackFormatter } from './formatter.js';
import { resolvePostThreadId, getEmojiName } from '../utils.js';
import { uploadFileSlack } from './upload.js';
import { sanitizeFilename } from '../../utils/safe-filename.js';

// =============================================================================
// Slack MCP API Configuration
// =============================================================================

// The config shape is the canonical one from mcp-platform-api.ts — a local
// shadow copy (without platformType) used to hide behind the factory's cast.
export type { SlackMcpApiConfig } from '../mcp-platform-api.js';
import type { SlackMcpApiConfig } from '../mcp-platform-api.js';

// =============================================================================
// Slack API Helpers
// =============================================================================

const SLACK_API_BASE = 'https://slack.com/api';

/**
 * Methods that read data. Slack takes a JSON body only on write methods; on
 * these it ignores one and answers as if no arguments were given (users.info
 * says `user_not_found`, which rejected every permission reaction, #622).
 * They go out as a GET with query parameters, as the main SlackClient does.
 */
const READ_METHODS = new Set([
  'users.info',
  'conversations.history',
  'conversations.replies',
  'conversations.info',
  'conversations.members',
  'reactions.get',
]);

/** Slack answered 429; `retryAfterMs` is its Retry-After. */
class SlackRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Slack API error: 429 rate limited, retry after ${retryAfterMs} ms`);
  }
}

/**
 * Make a Slack API request
 */
async function slackApi<T>(
  method: string,
  token: string,
  args?: Record<string, unknown>,
  apiBase: string = SLACK_API_BASE,
): Promise<T> {
  let response: Response;
  if (READ_METHODS.has(method)) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(args ?? {})) {
      if (value !== undefined && value !== null) query.set(key, String(value));
    }
    const qs = query.toString();
    response = await fetch(`${apiBase}/${method}${qs ? `?${qs}` : ''}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });
  } else {
    response = await fetch(`${apiBase}/${method}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: args ? JSON.stringify(args) : undefined,
    });
  }

  if (response.status === 429) {
    const seconds = Number(response.headers.get('retry-after'));
    throw new SlackRateLimitError(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5000);
  }
  if (!response.ok) {
    throw new Error(`Slack API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as T & { ok: boolean; error?: string };

  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error || 'Unknown error'}`);
  }

  return data;
}

// =============================================================================
// Slack MCP Platform API Implementation
// =============================================================================

/**
 * Slack MCP platform API implementation
 */
class SlackMcpPlatformApi implements McpPlatformApi {
  /**
   * The Web API, at the configured base. The MCP child used to hardcode
   * slack.com, so against the integration suite's Slack mock it never reached
   * the mock at all, and #622 had no test that could see it.
   */
  private slackApi<T>(method: string, token: string, args?: Record<string, unknown>): Promise<T> {
    return slackApi<T>(method, token, args, this.config.apiUrl || SLACK_API_BASE);
  }

  private readonly config: SlackMcpApiConfig;
  private readonly formatter = new SlackFormatter();
  private botUserIdCache: string | null = null;

  constructor(config: SlackMcpApiConfig) {
    this.config = config;
  }

  getFormatter(): PlatformFormatter {
    return this.formatter;
  }

  async getBotUserId(): Promise<string> {
    if (this.botUserIdCache) {
      mcpLogger.debug(`Bot user ID from cache: ${this.botUserIdCache}`);
      return this.botUserIdCache;
    }

    mcpLogger.debug('Fetching bot user ID via auth.test...');
    const response = await this.slackApi<AuthTestResponse>(
      'auth.test',
      this.config.botToken
    );

    this.botUserIdCache = response.user_id;
    mcpLogger.debug(`Bot user ID: ${response.user_id}`);
    return response.user_id;
  }

  async getUsername(userId: string): Promise<string | null> {
    try {
      mcpLogger.debug(`Looking up username for user ${userId}`);
      const response = await this.slackApi<UsersInfoResponse>(
        'users.info',
        this.config.botToken,
        { user: userId }
      );

      const username = response.user?.name;
      if (username) {
        mcpLogger.debug(`User ${userId} is @${username}`);
      }
      return username ?? null;
    } catch (err) {
      mcpLogger.warn(`Failed to get username for ${userId}: ${err}`);
      return null;
    }
  }

  isUserAllowed(username: string): boolean {
    // Empty allowlist means everyone is allowed (same as Mattermost)
    if (this.config.allowedUsers.length === 0) {
      mcpLogger.debug(`User ${username} allowed: true (empty allowlist)`);
      return true;
    }
    const allowed = this.config.allowedUsers.includes(username);
    mcpLogger.debug(`User ${username} allowed: ${allowed}`);
    return allowed;
  }

  async createInteractivePost(
    message: string,
    reactions: string[],
    threadTs?: string
  ): Promise<PostedMessage> {
    mcpLogger.debug(`Creating interactive post with ${reactions.length} reaction options`);

    // Post the message
    const response = await this.slackApi<PostMessageResponse>(
      'chat.postMessage',
      this.config.botToken,
      {
        channel: this.config.channelId,
        text: message,
        // A synthetic DCM thread id resolves to a top-level channel post.
        thread_ts: resolvePostThreadId(threadTs || this.config.threadTs),
        mrkdwn: true,
      }
    );

    const messageTs = response.ts;
    mcpLogger.debug(`Created post with ts ${messageTs}`);

    // Add reaction emojis as options
    for (const emoji of reactions) {
      try {
        // Normalize like the client does: strips colons AND maps literal
        // Unicode emoji to their shortcode (reactions.add rejects raw 👍).
        const emojiName = getEmojiName(emoji);
        await slackApi(
          'reactions.add',
          this.config.botToken,
          {
            channel: this.config.channelId,
            timestamp: messageTs,
            name: emojiName,
          }
        );
        mcpLogger.debug(`Added reaction :${emojiName}:`);
      } catch (err) {
        // Ignore errors from adding reactions (might already exist)
        mcpLogger.debug(`Failed to add reaction ${emoji}: ${err}`);
      }
    }

    // Use timestamp as the ID (Slack uses channel + ts to identify messages)
    return { id: messageTs };
  }

  async updatePost(postId: string, message: string): Promise<void> {
    mcpLogger.debug(`Updating post ${postId}`);

    await this.slackApi<UpdateMessageResponse>(
      'chat.update',
      this.config.botToken,
      {
        channel: this.config.channelId,
        ts: postId,
        text: message,
        mrkdwn: true,
      }
    );
  }

  /** How often a pending permission post is polled for reactions. Tests shorten it. */
  reactionPollMs = 2000;
  /** (post, user, emoji) already handed out, so a repeat poll does not return the same reaction twice. */
  private readonly seenReactions = new Set<string>();

  async waitForReaction(
    postId: string,
    botUserId: string,
    timeoutMs: number
  ): Promise<ReactionEvent | null> {
    // Poll the post rather than open a Socket Mode connection of our own:
    // the main bot holds the app's connection, and Slack round-robins events
    // across all of them (#622). reactions.get is Tier 3, comfortably above
    // one call every two seconds per pending prompt; a 429 waits as told.
    const deadline = Date.now() + timeoutMs;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(ms, deadline - Date.now()))));
    while (Date.now() < deadline) {
      let wait = this.reactionPollMs;
      try {
        const response = await this.slackApi<ReactionsGetResponse>(
          'reactions.get',
          this.config.botToken,
          { channel: this.config.channelId, timestamp: postId, full: true },
        );
        for (const reaction of response.message?.reactions ?? []) {
          for (const userId of reaction.users ?? []) {
            if (userId === botUserId) continue;
            const key = `${postId}|${userId}|${reaction.name}`;
            if (this.seenReactions.has(key)) continue;
            this.seenReactions.add(key);
            mcpLogger.debug(`Reaction received: :${reaction.name}: from user: ${userId}`);
            return { postId, userId, emojiName: reaction.name };
          }
        }
      } catch (err) {
        if (err instanceof SlackRateLimitError) {
          wait = err.retryAfterMs;
        } else {
          mcpLogger.debug(`reactions.get failed, retrying: ${err}`);
        }
      }
      await sleep(wait);
    }
    mcpLogger.debug(`Reaction wait timed out after ${timeoutMs}ms`);
    return null;
  }

  async uploadFile(
    filePath: string,
    threadId: string,
    options?: { caption?: string; filename?: string },
  ): Promise<{ postId: string }> {
    const filename = sanitizeFilename(options?.filename ?? filePath);
    mcpLogger.debug(`uploadFile: ${filename} → thread_ts ${threadId}`);
    const result = await uploadFileSlack({
      botToken: this.config.botToken,
      channelId: this.config.channelId,
      threadTs: threadId,
      filePath,
      filename,
      caption: options?.caption,
      apiUrl: this.config.apiUrl,
    });
    return { postId: result.postId };
  }

  async readPost(postId: string): Promise<McpPost | null> {
    mcpLogger.debug(`readPost: ts ${postId}`);
    try {
      const response = await this.slackApi<ConversationsHistoryResponse>(
        'conversations.history',
        this.config.botToken,
        {
          channel: this.config.channelId,
          latest: postId,
          oldest: postId,
          inclusive: true,
          limit: 1,
        },
      );
      const message = response.messages?.[0];
      if (!message || message.ts !== postId) return null;
      const username = message.user ? await this.getUsername(message.user) : null;
      return slackMessageToMcpPost(message, this.config.channelId, username);
    } catch (err) {
      mcpLogger.debug(`readPost ${postId} failed: ${err}`);
      return null;
    }
  }

  async addReaction(postId: string, emojiName: string): Promise<void> {
    // Normalize like the client does: strips colons AND maps literal
    // Unicode emoji to their shortcode (reactions.add rejects raw 👍).
    const name = getEmojiName(emojiName);
    mcpLogger.debug(`addReaction: :${name}: on ts ${postId}`);
    // Implicit channel scope: Slack identifies messages by (channel, ts), so
    // we always pass the bot's configured channel here. The interface
    // contract says the caller is responsible for scope checks, but on
    // Slack we can't react outside the bot's channel even if asked: there
    // is no other channel the bot is reachable in. Callers that resolve
    // permalinks for other channels will hit `wrong-channel` in
    // resolveSlackPermalink before reaching this method.
    await slackApi(
      'reactions.add',
      this.config.botToken,
      {
        channel: this.config.channelId,
        timestamp: postId,
        name,
      },
    );
  }

  async readThread(
    threadRootId: string,
    options?: { limit?: number },
  ): Promise<McpPost[]> {
    mcpLogger.debug(`readThread: ts ${threadRootId}`);
    try {
      const response = await this.slackApi<ConversationsRepliesResponse>(
        'conversations.replies',
        this.config.botToken,
        {
          channel: this.config.channelId,
          ts: threadRootId,
          limit: options?.limit ?? 100,
        },
      );

      const messages = response.messages ?? [];
      // conversations.replies returns messages in chronological order, but
      // sort defensively in case Slack changes the contract.
      const ordered = [...messages].sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

      // Resolve usernames once per unique user.
      const usernameByUserId = new Map<string, string | null>();
      for (const m of ordered) {
        if (m.user && !usernameByUserId.has(m.user)) {
          usernameByUserId.set(m.user, await this.getUsername(m.user));
        }
      }

      return ordered.map(m =>
        slackMessageToMcpPost(
          m,
          this.config.channelId,
          m.user ? usernameByUserId.get(m.user) ?? null : null,
        ),
      );
    } catch (err) {
      mcpLogger.debug(`readThread ${threadRootId} failed: ${err}`);
      return [];
    }
  }

  async readChannelHistory(
    channelId: string,
    options?: { limit?: number },
  ): Promise<McpPost[] | null> {
    const limit = options?.limit ?? 20;
    mcpLogger.debug(`readChannelHistory: ${channelId} (limit=${limit})`);
    try {
      const response = await this.slackApi<ConversationsHistoryResponse>(
        'conversations.history',
        this.config.botToken,
        {
          channel: channelId,
          limit,
        },
      );

      // Slack returns newest-first; normalize to oldest-first to match the
      // Mattermost output and readThread.
      const messages = [...(response.messages ?? [])].sort(
        (a, b) => parseFloat(a.ts) - parseFloat(b.ts),
      );

      const usernameByUserId = new Map<string, string | null>();
      for (const m of messages) {
        if (m.user && !usernameByUserId.has(m.user)) {
          usernameByUserId.set(m.user, await this.getUsername(m.user));
        }
      }

      return messages.map(m =>
        slackMessageToMcpPost(
          m,
          channelId,
          m.user ? usernameByUserId.get(m.user) ?? null : null,
        ),
      );
    } catch (err) {
      // Slack returns `not_in_channel` / `channel_not_found` as a thrown
      // error from slackApi. Map both to null so the caller can distinguish
      // "in scope but inaccessible" from "out of scope" itself.
      mcpLogger.debug(`readChannelHistory ${channelId} failed: ${err}`);
      return null;
    }
  }

  async getChannelInfo(
    channelId: string,
  ): Promise<{ id: string; channelType: 'public' | 'private'; name?: string } | null> {
    mcpLogger.debug(`getChannelInfo: ${channelId}`);
    try {
      const response = await this.slackApi<ConversationsInfoResponse>(
        'conversations.info',
        this.config.botToken,
        { channel: channelId },
      );
      const ch = response.channel;
      // DMs / group DMs are not "channels" for the purposes of the scope
      // predicate. Treat them as private (the conservative default).
      const isPrivate = ch.is_private || ch.is_im || ch.is_mpim || false;
      return {
        id: ch.id,
        channelType: isPrivate ? 'private' : 'public',
        name: ch.name,
      };
    } catch (err) {
      mcpLogger.debug(`getChannelInfo ${channelId} failed: ${err}`);
      return null;
    }
  }

  async getChannelMembers(channelId: string): Promise<string[] | null> {
    // Slack paginates channel members. Iterate cursor until exhausted.
    // Bounded by `maxPages` so a runaway 100k-member channel can't pin
    // the MCP child indefinitely; in practice bot channels are small.
    const maxPages = 20; // 20 * 1000 = 20k members ceiling
    const all: string[] = [];
    let cursor: string | undefined = undefined;
    try {
      for (let i = 0; i < maxPages; i++) {
        const params: Record<string, unknown> = {
          channel: channelId,
          limit: 1000,
        };
        if (cursor) params.cursor = cursor;
        const response: ConversationsMembersResponse = await this.slackApi<ConversationsMembersResponse>(
          'conversations.members',
          this.config.botToken,
          params,
        );
        all.push(...(response.members ?? []));
        cursor = response.response_metadata?.next_cursor;
        if (!cursor) return all;
      }
      mcpLogger.warn(`getChannelMembers ${channelId} hit page cap of ${maxPages}`);
      return all;
    } catch (err) {
      mcpLogger.debug(`getChannelMembers ${channelId} failed: ${err}`);
      return null;
    }
  }

  async resolveRecipient(
    recipient: string,
  ): Promise<{ id: string; username: string | null } | null> {
    // Slack: recipient is a user ID. Strip surrounding `<@...>` markers
    // if Claude included them (they appear in chat as "<@U123>").
    const id = recipient.replace(/^<@/, '').replace(/>$/, '');
    if (!/^[UW][A-Z0-9]{8,}$/.test(id)) {
      return null;
    }
    try {
      const response = await this.slackApi<UsersInfoResponse>(
        'users.info',
        this.config.botToken,
        { user: id },
      );
      return { id: response.user.id, username: response.user.name ?? null };
    } catch (err) {
      mcpLogger.debug(`resolveRecipient ${id} failed: ${err}`);
      return null;
    }
  }

  async sendDirectMessage(
    recipientUserId: string,
    message: string,
  ): Promise<{ postId: string }> {
    // Open (or fetch existing) DM channel with the recipient.
    const opened = await this.slackApi<ConversationsOpenResponse>(
      'conversations.open',
      this.config.botToken,
      { users: recipientUserId },
    );
    const dmChannelId = opened.channel.id;
    const post = await this.slackApi<PostMessageResponse>(
      'chat.postMessage',
      this.config.botToken,
      {
        channel: dmChannelId,
        text: message,
        mrkdwn: true,
      },
    );
    return { postId: post.ts };
  }
}

function slackMessageToMcpPost(
  message: SlackMessage,
  channelId: string,
  username: string | null,
): McpPost {
  // Slack uses ts as the post id, and seconds-since-epoch for create time.
  // We expose milliseconds for parity with Mattermost's create_at.
  const createAt = Math.floor(parseFloat(message.ts) * 1000);
  return {
    id: message.ts,
    channelId,
    userId: message.user ?? '',
    username,
    message: message.text ?? '',
    createAt: Number.isFinite(createAt) ? createAt : 0,
    threadRootId: message.thread_ts && message.thread_ts !== message.ts ? message.thread_ts : undefined,
  };
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a Slack MCP platform API instance
 */
export function createSlackMcpPlatformApi(config: SlackMcpApiConfig): McpPlatformApi {
  return new SlackMcpPlatformApi(config);
}
