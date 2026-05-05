/**
 * Mattermost implementation of McpPlatformApi
 *
 * Handles MCP-side platform operations via Mattermost API and WebSocket.
 * Bundles the minimal Mattermost REST surface the MCP child needs; the full
 * WebSocket-backed client lives in src/platform/mattermost/client.ts and is
 * only used by the main bot.
 */

import { WebSocket } from '../../utils/websocket.js';
import type {
  McpPlatformApi,
  MattermostMcpApiConfig,
  ReactionEvent,
  PostedMessage,
  McpPost,
} from '../mcp-platform-api.js';
import type { PlatformFormatter } from '../formatter.js';
import { MattermostFormatter } from './formatter.js';
import { createLogger, mcpLogger } from '../../utils/logger.js';
import { formatShortId } from '../../utils/format.js';
import { formatWebSocketError } from '../utils.js';
import { uploadFileMattermost } from './upload.js';
import { sanitizeFilename } from '../../utils/safe-filename.js';

// =============================================================================
// Mattermost REST API helpers (internal)
//
// Standalone fetch-based functions used only by the permission API. The full
// Mattermost client (src/platform/mattermost/client.ts) uses its own api()
// method with retry + silent-error options. Keep these minimal — don't extend
// without a second consumer.
// =============================================================================

const apiLog = createLogger('mm-api');

interface MattermostApiConfig {
  url: string;
  token: string;
}

interface MattermostApiPost {
  id: string;
  channel_id: string;
  message: string;
  root_id?: string;
  user_id?: string;
  create_at?: number;
}

interface MattermostApiChannel {
  id: string;
  /**
   * Channel type per Mattermost: 'O' = open/public, 'P' = private,
   * 'D' = direct message, 'G' = group message.
   */
  type: 'O' | 'P' | 'D' | 'G';
}

interface MattermostApiUser {
  id: string;
  username: string;
  email?: string;
  first_name?: string;
  last_name?: string;
}

async function mattermostApi<T>(
  config: MattermostApiConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${config.url}/api/v4${path}`;
  apiLog.debug(`API ${method} ${path}`);
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    apiLog.warn(`API ${method} ${path} failed: ${response.status} ${text.substring(0, 100)}`);
    throw new Error(`Mattermost API error ${response.status}: ${text}`);
  }

  apiLog.debug(`API ${method} ${path} → ${response.status}`);
  return response.json() as Promise<T>;
}

async function getMe(config: MattermostApiConfig): Promise<MattermostApiUser> {
  return mattermostApi<MattermostApiUser>(config, 'GET', '/users/me');
}

async function getUser(
  config: MattermostApiConfig,
  userId: string,
): Promise<MattermostApiUser | null> {
  try {
    return await mattermostApi<MattermostApiUser>(config, 'GET', `/users/${userId}`);
  } catch (err) {
    apiLog.debug(`Failed to get user ${userId}: ${err}`);
    return null;
  }
}

async function createPost(
  config: MattermostApiConfig,
  channelId: string,
  message: string,
  rootId?: string,
): Promise<MattermostApiPost> {
  return mattermostApi<MattermostApiPost>(config, 'POST', '/posts', {
    channel_id: channelId,
    message,
    root_id: rootId,
  });
}

async function updatePostRaw(
  config: MattermostApiConfig,
  postId: string,
  message: string,
): Promise<MattermostApiPost> {
  return mattermostApi<MattermostApiPost>(config, 'PUT', `/posts/${postId}`, {
    id: postId,
    message,
  });
}

interface MattermostThreadResponse {
  order: string[];
  posts: Record<string, MattermostApiPost>;
}

async function getPostRaw(
  config: MattermostApiConfig,
  postId: string,
): Promise<MattermostApiPost | null> {
  try {
    return await mattermostApi<MattermostApiPost>(config, 'GET', `/posts/${postId}`);
  } catch (err) {
    apiLog.debug(`Failed to get post ${postId}: ${err}`);
    return null;
  }
}

async function getChannelRaw(
  config: MattermostApiConfig,
  channelId: string,
): Promise<MattermostApiChannel | null> {
  try {
    return await mattermostApi<MattermostApiChannel>(config, 'GET', `/channels/${channelId}`);
  } catch (err) {
    apiLog.debug(`Failed to get channel ${channelId}: ${err}`);
    return null;
  }
}

async function getThreadRaw(
  config: MattermostApiConfig,
  threadRootId: string,
): Promise<MattermostThreadResponse | null> {
  try {
    return await mattermostApi<MattermostThreadResponse>(
      config,
      'GET',
      `/posts/${threadRootId}/thread`,
    );
  } catch (err) {
    apiLog.debug(`Failed to get thread ${threadRootId}: ${err}`);
    return null;
  }
}

async function addReaction(
  config: MattermostApiConfig,
  postId: string,
  userId: string,
  emojiName: string,
): Promise<void> {
  await mattermostApi(config, 'POST', '/reactions', {
    user_id: userId,
    post_id: postId,
    emoji_name: emojiName,
  });
}

function isUserInAllowList(username: string, allowList: string[]): boolean {
  if (allowList.length === 0) return true;
  return allowList.includes(username);
}

/**
 * Create a post and add one reaction per option, continuing if individual
 * reactions fail.
 */
async function createInteractivePostInternal(
  config: MattermostApiConfig,
  channelId: string,
  message: string,
  reactions: string[],
  rootId: string | undefined,
  botUserId: string,
): Promise<MattermostApiPost> {
  const post = await createPost(config, channelId, message, rootId);
  for (const emoji of reactions) {
    try {
      await addReaction(config, post.id, botUserId, emoji);
    } catch (err) {
      apiLog.warn(`Failed to add reaction ${emoji}: ${err}`);
    }
  }
  return post;
}

/**
 * Mattermost MCP platform API implementation
 */
class MattermostMcpPlatformApi implements McpPlatformApi {
  private readonly apiConfig: MattermostApiConfig;
  private readonly config: MattermostMcpApiConfig;
  private readonly formatter = new MattermostFormatter();
  private botUserIdCache: string | null = null;
  // Channel-type lookups are cached for the lifetime of the MCP child:
  // visibility flips are rare and a stale "public" decision only widens
  // the read_post guard for a public→private transition (operationally
  // safe because the bot still needs token-side access to fetch the post
  // contents in the first place).
  private channelTypeCache = new Map<string, 'public' | 'private'>();

  constructor(config: MattermostMcpApiConfig) {
    this.config = config;
    this.apiConfig = {
      url: config.url,
      token: config.token,
    };
  }

  getFormatter(): PlatformFormatter {
    return this.formatter;
  }

  async getBotUserId(): Promise<string> {
    if (this.botUserIdCache) {
      mcpLogger.debug(`Bot user ID from cache: ${this.botUserIdCache}`);
      return this.botUserIdCache;
    }
    mcpLogger.debug('Fetching bot user ID...');
    const me = await getMe(this.apiConfig);
    this.botUserIdCache = me.id;
    mcpLogger.debug(`Bot user ID: ${me.id}`);
    return me.id;
  }

  async getUsername(userId: string): Promise<string | null> {
    try {
      mcpLogger.debug(`Looking up username for user ${userId}`);
      const user = await getUser(this.apiConfig, userId);
      if (user?.username) {
        mcpLogger.debug(`User ${userId} is @${user.username}`);
      }
      return user?.username ?? null;
    } catch (err) {
      mcpLogger.warn(`Failed to get username for ${userId}: ${err}`);
      return null;
    }
  }

  isUserAllowed(username: string): boolean {
    return isUserInAllowList(username, this.config.allowedUsers);
  }

  async createInteractivePost(
    message: string,
    reactions: string[],
    threadId?: string
  ): Promise<PostedMessage> {
    mcpLogger.debug(`Creating interactive post with ${reactions.length} reaction options`);
    const botUserId = await this.getBotUserId();
    const post = await createInteractivePostInternal(
      this.apiConfig,
      this.config.channelId,
      message,
      reactions,
      threadId,
      botUserId
    );
    mcpLogger.debug(`Created post ${formatShortId(post.id)}`);
    return { id: post.id };
  }

  async updatePost(postId: string, message: string): Promise<void> {
    mcpLogger.debug(`Updating post ${postId.substring(0, 8)}`);
    await updatePostRaw(this.apiConfig, postId, message);
  }

  async waitForReaction(
    postId: string,
    botUserId: string,
    timeoutMs: number
  ): Promise<ReactionEvent | null> {
    return new Promise((resolve) => {
      // Parse WebSocket URL from HTTP URL
      const wsUrl = this.config.url.replace(/^http/, 'ws') + '/api/v4/websocket';
      mcpLogger.debug(`Connecting to WebSocket: ${wsUrl}`);

      const ws = new WebSocket(wsUrl);
      let resolved = false;

      const cleanup = () => {
        if (ws.readyState === WebSocket.OPEN) {
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

      ws.onopen = () => {
        mcpLogger.debug('WebSocket connected, sending auth...');
        ws.send(
          JSON.stringify({
            seq: 1,
            action: 'authentication_challenge',
            data: { token: this.config.token },
          })
        );
      };

      ws.onmessage = (event) => {
        if (resolved) return;

        try {
          const data = typeof event.data === 'string' ? event.data : event.data.toString();
          const wsEvent = JSON.parse(data);
          mcpLogger.debug(`WebSocket event: ${wsEvent.event}`);

          if (wsEvent.event === 'reaction_added') {
            // Mattermost sends reaction as JSON string
            const reaction = typeof wsEvent.data.reaction === 'string'
              ? JSON.parse(wsEvent.data.reaction)
              : wsEvent.data.reaction;

            // Must be on our post
            if (reaction.post_id !== postId) return;

            // Must not be the bot's own reaction (adding the options)
            if (reaction.user_id === botUserId) return;

            mcpLogger.debug(`Reaction received: ${reaction.emoji_name} from user: ${reaction.user_id}`);

            // Got a valid reaction
            resolved = true;
            clearTimeout(timeout);
            cleanup();

            resolve({
              postId: reaction.post_id,
              userId: reaction.user_id,
              emojiName: reaction.emoji_name,
            });
          }
        } catch (err) {
          mcpLogger.debug(`Error parsing WebSocket message: ${err}`);
        }
      };

      ws.onerror = (event) => {
        mcpLogger.error(`WebSocket error: ${formatWebSocketError(event)}`);
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(null);
        }
      };

      ws.onclose = () => {
        mcpLogger.debug('WebSocket closed');
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(null);
        }
      };
    });
  }

  async uploadFile(
    filePath: string,
    threadId: string,
    options?: { caption?: string; filename?: string },
  ): Promise<{ postId: string }> {
    const filename = sanitizeFilename(options?.filename ?? filePath);
    mcpLogger.debug(`uploadFile: ${filename} → thread ${formatShortId(threadId)}`);
    const result = await uploadFileMattermost({
      url: this.config.url,
      token: this.config.token,
      channelId: this.config.channelId,
      threadId,
      filePath,
      filename,
      caption: options?.caption,
    });
    return { postId: result.postId };
  }

  async readPost(postId: string): Promise<McpPost | null> {
    mcpLogger.debug(`readPost: ${formatShortId(postId)}`);
    const post = await getPostRaw(this.apiConfig, postId);
    if (!post) return null;
    const username = post.user_id ? await this.getUsername(post.user_id) : null;
    const channelType = await this.getChannelType(post.channel_id);
    return toMcpPost(post, username, channelType);
  }

  private async getChannelType(channelId: string): Promise<'public' | 'private' | undefined> {
    const cached = this.channelTypeCache.get(channelId);
    if (cached) return cached;
    const channel = await getChannelRaw(this.apiConfig, channelId);
    if (!channel) return undefined;
    const visibility: 'public' | 'private' = channel.type === 'O' ? 'public' : 'private';
    this.channelTypeCache.set(channelId, visibility);
    return visibility;
  }

  async readThread(
    threadRootId: string,
    options?: { limit?: number },
  ): Promise<McpPost[]> {
    mcpLogger.debug(`readThread: ${formatShortId(threadRootId)}`);
    const thread = await getThreadRaw(this.apiConfig, threadRootId);
    if (!thread) return [];

    // Sort by create_at ascending so the oldest post comes first.
    const ordered = thread.order
      .map(id => thread.posts[id])
      .filter((p): p is MattermostApiPost => Boolean(p))
      .sort((a, b) => (a.create_at ?? 0) - (b.create_at ?? 0));

    const limited = options?.limit !== undefined ? ordered.slice(-options.limit) : ordered;

    // Resolve usernames once per unique user to avoid N round-trips for a
    // chatty thread.
    const usernameByUserId = new Map<string, string | null>();
    for (const p of limited) {
      if (p.user_id && !usernameByUserId.has(p.user_id)) {
        usernameByUserId.set(p.user_id, await this.getUsername(p.user_id));
      }
    }

    // All replies share the thread root's channel; one lookup is enough.
    const channelType = limited[0]
      ? await this.getChannelType(limited[0].channel_id)
      : undefined;

    return limited.map(p =>
      toMcpPost(
        p,
        p.user_id ? usernameByUserId.get(p.user_id) ?? null : null,
        channelType,
      ),
    );
  }
}

function toMcpPost(
  post: MattermostApiPost,
  username: string | null,
  channelType?: 'public' | 'private',
): McpPost {
  return {
    id: post.id,
    channelId: post.channel_id,
    userId: post.user_id ?? '',
    username,
    message: post.message,
    createAt: post.create_at ?? 0,
    threadRootId: post.root_id || undefined,
    channelType,
  };
}

/**
 * Create a Mattermost MCP platform API instance
 */
export function createMattermostMcpPlatformApi(config: MattermostMcpApiConfig): McpPlatformApi {
  return new MattermostMcpPlatformApi(config);
}
