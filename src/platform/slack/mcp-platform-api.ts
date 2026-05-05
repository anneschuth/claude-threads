/**
 * Slack implementation of McpPlatformApi
 *
 * Handles MCP-side platform operations via Slack Web API and Socket Mode.
 *
 * Key differences from Mattermost:
 * - Uses two tokens: botToken (xoxb-) for API calls, appToken (xapp-) for Socket Mode
 * - Socket Mode uses a different WebSocket protocol with envelope acknowledgments
 * - Messages are identified by channel + timestamp (ts), not by ID
 * - User mentions use <@USER_ID> format, not @username
 */

import { WebSocket } from '../../utils/websocket.js';
import type {
  McpPlatformApi,
  ReactionEvent,
  PostedMessage,
  McpPost,
} from '../mcp-platform-api.js';
import type { PlatformFormatter } from '../formatter.js';
import type {
  AuthTestResponse,
  AppsConnectionsOpenResponse,
  PostMessageResponse,
  UpdateMessageResponse,
  UsersInfoResponse,
  ConversationsHistoryResponse,
  ConversationsInfoResponse,
  ConversationsRepliesResponse,
  SlackMessage,
  SlackSocketModeEvent,
} from './types.js';
import { mcpLogger } from '../../utils/logger.js';
import { SlackFormatter } from './formatter.js';
import { formatWebSocketError } from '../utils.js';
import { uploadFileSlack } from './upload.js';
import { sanitizeFilename } from '../../utils/safe-filename.js';

// =============================================================================
// Slack MCP API Configuration
// =============================================================================

/**
 * Configuration for the Slack MCP platform API
 */
export interface SlackMcpApiConfig {
  botToken: string;      // xoxb-... token for Web API
  appToken: string;      // xapp-... token for Socket Mode
  channelId: string;
  threadTs?: string;     // Thread timestamp if posting in a thread
  allowedUsers: string[];
  debug?: boolean;
}

// =============================================================================
// Slack API Helpers
// =============================================================================

const SLACK_API_BASE = 'https://slack.com/api';

/**
 * Make a Slack API request
 */
async function slackApi<T>(
  method: string,
  token: string,
  body?: Record<string, unknown>
): Promise<T> {
  const url = `${SLACK_API_BASE}/${method}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

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
    const response = await slackApi<AuthTestResponse>(
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
      const response = await slackApi<UsersInfoResponse>(
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
    const response = await slackApi<PostMessageResponse>(
      'chat.postMessage',
      this.config.botToken,
      {
        channel: this.config.channelId,
        text: message,
        thread_ts: threadTs || this.config.threadTs,
        mrkdwn: true,
      }
    );

    const messageTs = response.ts;
    mcpLogger.debug(`Created post with ts ${messageTs}`);

    // Add reaction emojis as options
    for (const emoji of reactions) {
      try {
        // Slack reaction names don't include colons
        const emojiName = emoji.replace(/:/g, '');
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

    await slackApi<UpdateMessageResponse>(
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

  async waitForReaction(
    postId: string,
    botUserId: string,
    timeoutMs: number
  ): Promise<ReactionEvent | null> {
    return new Promise((resolve) => {
      let resolved = false;
      let ws: WebSocket | null = null;

      const cleanup = () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      };

      const timeout = setTimeout(() => {
        if (!resolved) {
          mcpLogger.debug(`Reaction wait timed out after ${timeoutMs}ms`);
          resolved = true;
          cleanup();
          resolve(null);
        }
      }, timeoutMs);

      // First, get Socket Mode WebSocket URL
      this.getSocketModeUrl()
        .then((wsUrl) => {
          if (resolved) return;

          mcpLogger.debug(`Connecting to Socket Mode: ${wsUrl.substring(0, 50)}...`);
          ws = new WebSocket(wsUrl);

          ws.onopen = () => {
            mcpLogger.debug('Socket Mode WebSocket connected');
          };

          ws.onmessage = (event) => {
            if (resolved) return;

            try {
              const data = typeof event.data === 'string' ? event.data : event.data.toString();
              const socketEvent = JSON.parse(data) as SlackSocketModeEvent;

              // Acknowledge the envelope immediately
              if (socketEvent.envelope_id) {
                ws?.send(JSON.stringify({ envelope_id: socketEvent.envelope_id }));
              }

              mcpLogger.debug(`Socket Mode event type: ${socketEvent.type}`);

              // Handle events_api type (contains the actual event)
              if (socketEvent.type === 'events_api' && socketEvent.payload?.event) {
                const slackEvent = socketEvent.payload.event;

                // Check for reaction_added event
                if (slackEvent.type === 'reaction_added') {
                  const item = slackEvent.item;

                  // Must be on our message (matching timestamp and channel)
                  if (
                    item?.type !== 'message' ||
                    item.ts !== postId ||
                    item.channel !== this.config.channelId
                  ) {
                    return;
                  }

                  // Must not be the bot's own reaction
                  if (slackEvent.user === botUserId) {
                    mcpLogger.debug('Ignoring bot\'s own reaction');
                    return;
                  }

                  const emojiName = slackEvent.reaction || '';
                  const userId = slackEvent.user || '';

                  mcpLogger.debug(`Reaction received: :${emojiName}: from user: ${userId}`);

                  // Got a valid reaction
                  resolved = true;
                  clearTimeout(timeout);
                  cleanup();

                  resolve({
                    postId: item.ts,
                    userId,
                    emojiName,
                  });
                }
              }

              // Handle hello event (connection successful)
              if (socketEvent.type === 'hello') {
                mcpLogger.debug('Socket Mode hello received, connection established');
              }

              // Handle disconnect event
              if (socketEvent.type === 'disconnect') {
                mcpLogger.debug('Socket Mode disconnect requested');
                if (!resolved) {
                  resolved = true;
                  clearTimeout(timeout);
                  cleanup();
                  resolve(null);
                }
              }
            } catch (err) {
              mcpLogger.debug(`Error parsing Socket Mode message: ${err}`);
            }
          };

          ws.onerror = (event) => {
            mcpLogger.error(`Socket Mode WebSocket error: ${formatWebSocketError(event)}`);
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              cleanup();
              resolve(null);
            }
          };

          ws.onclose = () => {
            mcpLogger.debug('Socket Mode WebSocket closed');
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              resolve(null);
            }
          };
        })
        .catch((err) => {
          mcpLogger.error(`Failed to get Socket Mode URL: ${err}`);
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve(null);
          }
        });
    });
  }

  /**
   * Get Socket Mode WebSocket URL
   *
   * Calls apps.connections.open to get a fresh WebSocket URL.
   * The URL is single-use and expires after connection.
   */
  private async getSocketModeUrl(): Promise<string> {
    mcpLogger.debug('Getting Socket Mode WebSocket URL...');

    const response = await slackApi<AppsConnectionsOpenResponse>(
      'apps.connections.open',
      this.config.appToken
    );

    mcpLogger.debug('Got Socket Mode URL');
    return response.url;
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
    });
    return { postId: result.postId };
  }

  async readPost(postId: string): Promise<McpPost | null> {
    mcpLogger.debug(`readPost: ts ${postId}`);
    try {
      const response = await slackApi<ConversationsHistoryResponse>(
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
    // Slack reaction names never include the surrounding colons in the API.
    const name = emojiName.replace(/:/g, '');
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
      const response = await slackApi<ConversationsRepliesResponse>(
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
      const response = await slackApi<ConversationsHistoryResponse>(
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
  ): Promise<{ id: string; channelType: 'public' | 'private' } | null> {
    mcpLogger.debug(`getChannelInfo: ${channelId}`);
    try {
      const response = await slackApi<ConversationsInfoResponse>(
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
      };
    } catch (err) {
      mcpLogger.debug(`getChannelInfo ${channelId} failed: ${err}`);
      return null;
    }
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
