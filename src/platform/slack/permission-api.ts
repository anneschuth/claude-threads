/**
 * Slack implementation of Permission API
 *
 * Handles permission requests via Slack Web API and Socket Mode.
 *
 * Key differences from Mattermost:
 * - Uses two tokens: botToken (xoxb-) for API calls, appToken (xapp-) for Socket Mode
 * - Socket Mode uses a different WebSocket protocol with envelope acknowledgments
 * - Messages are identified by channel + timestamp (ts), not by ID
 * - User mentions use <@USER_ID> format, not @username
 */

import type {
  PermissionApi,
  ReactionEvent,
  PostedMessage,
} from '../permission-api.js';
import type { PlatformFormatter } from '../formatter.js';
import type {
  AuthTestResponse,
  AppsConnectionsOpenResponse,
  PostMessageResponse,
  UpdateMessageResponse,
  UsersInfoResponse,
  SlackSocketModeEvent,
} from './types.js';
import { mcpLogger } from '../../utils/logger.js';

// =============================================================================
// Slack Formatter (inline since no separate file exists yet)
// =============================================================================

/**
 * Slack mrkdwn formatter
 *
 * Slack uses a variant called "mrkdwn" which differs from standard markdown:
 * - Bold: *text* (not **text**)
 * - Links: <url|text> (not [text](url))
 * - User mentions: <@U123456> (requires user ID)
 */
class SlackFormatter implements PlatformFormatter {
  formatBold(text: string): string {
    return `*${text}*`;
  }

  formatItalic(text: string): string {
    return `_${text}_`;
  }

  formatCode(text: string): string {
    return `\`${text}\``;
  }

  formatCodeBlock(code: string, language?: string): string {
    // Slack doesn't support language hints in code blocks
    void language;
    return `\`\`\`\n${code}\n\`\`\``;
  }

  formatUserMention(username: string, userId?: string): string {
    // Slack requires user ID for proper mentions
    if (userId) {
      return `<@${userId}>`;
    }
    // Fallback to @username (won't notify but is readable)
    return `@${username}`;
  }

  formatLink(text: string, url: string): string {
    return `<${url}|${text}>`;
  }

  formatListItem(text: string): string {
    return `- ${text}`;
  }

  formatNumberedListItem(number: number, text: string): string {
    return `${number}. ${text}`;
  }

  formatBlockquote(text: string): string {
    return `> ${text}`;
  }

  formatHorizontalRule(): string {
    return '---';
  }

  formatHeading(text: string, level: number): string {
    // Slack doesn't have heading syntax, use bold for emphasis
    void level;
    return `*${text}*`;
  }

  escapeText(text: string): string {
    // Escape Slack special characters: &, <, >
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

// =============================================================================
// Slack Permission API Configuration
// =============================================================================

/**
 * Configuration for Slack permission API
 */
export interface SlackPermissionApiConfig {
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
// Slack Permission API Implementation
// =============================================================================

/**
 * Slack Permission API implementation
 */
class SlackPermissionApi implements PermissionApi {
  private readonly config: SlackPermissionApiConfig;
  private readonly formatter = new SlackFormatter();
  private botUserIdCache: string | null = null;

  constructor(config: SlackPermissionApiConfig) {
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
    const allowed = this.config.allowedUsers.includes(username.toLowerCase());
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
            mcpLogger.error(`Socket Mode WebSocket error: ${event}`);
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
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a Slack permission API instance
 */
export function createSlackPermissionApi(config: SlackPermissionApiConfig): PermissionApi {
  return new SlackPermissionApi(config);
}
