/**
 * Direct Slack API helpers for integration tests
 *
 * This bypasses the main PlatformClient for test orchestration,
 * allowing us to set up test data and verify results directly.
 *
 * Key differences from Mattermost:
 * - Messages are identified by channel + timestamp (ts), not ID
 * - Reactions store users array, not individual entries
 * - Bot token format: Bearer xoxb-...
 * - API responses have ok: true/false pattern
 */

// ============================================================================
// Type Definitions
// ============================================================================

export interface SlackTestUser {
  id: string;
  team_id: string;
  name: string;
  deleted: boolean;
  real_name?: string;
  profile: SlackTestUserProfile;
  is_admin?: boolean;
  is_owner?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
}

export interface SlackTestUserProfile {
  title?: string;
  phone?: string;
  real_name?: string;
  real_name_normalized?: string;
  display_name?: string;
  display_name_normalized?: string;
  status_text?: string;
  status_emoji?: string;
  email?: string;
  image_48?: string;
}

export interface SlackTestChannel {
  id: string;
  name: string;
  is_channel: boolean;
  is_private: boolean;
  is_archived: boolean;
  is_member?: boolean;
  topic?: { value: string; creator?: string; last_set?: number };
  purpose?: { value: string; creator?: string; last_set?: number };
  num_members?: number;
}

export interface SlackTestPost {
  type: 'message';
  ts: string;
  user?: string;
  bot_id?: string;
  text: string;
  thread_ts?: string;
  reply_count?: number;
  reply_users_count?: number;
  latest_reply?: string;
  reply_users?: string[];
  reactions?: SlackTestReaction[];
}

export interface SlackTestReaction {
  name: string;
  users: string[];
  count: number;
}

export interface SlackTestFile {
  id: string;
  name: string;
  title?: string;
  mimetype: string;
  filetype: string;
  size: number;
  url_private?: string;
  url_private_download?: string;
}

export interface SlackTestPin {
  type: string;
  created: number;
  created_by: string;
  message?: SlackTestPost;
  channel?: string;
}

// API Response types
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface SlackApiResponse<_T = unknown> {
  ok: boolean;
  error?: string;
  warning?: string;
  response_metadata?: {
    next_cursor?: string;
  };
  [key: string]: unknown;
}

interface AuthTestResponse extends SlackApiResponse {
  url: string;
  team: string;
  user: string;
  team_id: string;
  user_id: string;
  bot_id?: string;
}

interface UsersInfoResponse extends SlackApiResponse {
  user: SlackTestUser;
}

interface UsersListResponse extends SlackApiResponse {
  members: SlackTestUser[];
  response_metadata?: {
    next_cursor: string;
  };
}

interface PostMessageResponse extends SlackApiResponse {
  channel: string;
  ts: string;
  message: SlackTestPost;
}

interface UpdateMessageResponse extends SlackApiResponse {
  channel: string;
  ts: string;
  text: string;
}

interface ConversationsRepliesResponse extends SlackApiResponse {
  messages: SlackTestPost[];
  has_more: boolean;
}

interface ConversationsHistoryResponse extends SlackApiResponse {
  messages: SlackTestPost[];
  has_more: boolean;
  response_metadata?: {
    next_cursor: string;
  };
}

interface ReactionsGetResponse extends SlackApiResponse {
  message: SlackTestPost;
}

interface PinsListResponse extends SlackApiResponse {
  items: SlackTestPin[];
}

interface ChannelsInfoResponse extends SlackApiResponse {
  channel: SlackTestChannel;
}

// ============================================================================
// SlackTestApi Class
// ============================================================================

/**
 * Direct Slack API client for test orchestration.
 *
 * Works against both:
 * 1. Mock Slack server (for CI tests)
 * 2. Real Slack workspace (for manual testing)
 */
export class SlackTestApi {
  private channelId: string | null = null;
  private botUserId: string | null = null;

  constructor(
    private baseUrl: string = 'https://slack.com/api',
    private token?: string,
  ) {}

  /**
   * Set the authentication token (bot token: xoxb-...)
   */
  setToken(token: string): void {
    this.token = token;
  }

  /**
   * Set the channel ID for operations that require it
   */
  setChannelId(channelId: string): void {
    this.channelId = channelId;
  }

  /**
   * Get the current channel ID
   */
  getChannelId(): string | null {
    return this.channelId;
  }

  /**
   * Get the bot user ID (cached from auth.test)
   */
  getBotUserId(): string | null {
    return this.botUserId;
  }

  /**
   * Make an API request
   */
  private async api<T extends SlackApiResponse>(
    method: string,
    endpoint: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    // For GET requests with body, convert to query params
    let url = `${this.baseUrl}/${endpoint}`;
    let requestBody: string | undefined;

    if (method === 'GET' && body && typeof body === 'object') {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) {
        if (value !== undefined && value !== null) {
          params.set(key, String(value));
        }
      }
      const queryString = params.toString();
      if (queryString) {
        url += (url.includes('?') ? '&' : '?') + queryString;
      }
    } else if (body) {
      requestBody = JSON.stringify(body);
    }

    const response = await fetch(url, {
      method,
      headers,
      body: requestBody,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Slack API HTTP error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as T;

    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error || 'Unknown error'}`);
    }

    return data;
  }

  // ============================================================================
  // Authentication
  // ============================================================================

  /**
   * Test authentication and get bot info
   */
  async authTest(): Promise<{
    userId: string;
    botId?: string;
    teamId: string;
    team: string;
    user: string;
  }> {
    const response = await this.api<AuthTestResponse>('POST', 'auth.test');
    this.botUserId = response.user_id;

    return {
      userId: response.user_id,
      botId: response.bot_id,
      teamId: response.team_id,
      team: response.team,
      user: response.user,
    };
  }

  // ============================================================================
  // Users
  // ============================================================================

  /**
   * Get user by ID
   */
  async getUser(userId: string): Promise<SlackTestUser> {
    const response = await this.api<UsersInfoResponse>('GET', 'users.info', {
      user: userId,
    });
    return response.user;
  }

  /**
   * Get user by username (name field in Slack)
   *
   * Note: Slack doesn't have a direct username lookup API.
   * This iterates through the user list to find a match.
   */
  async getUserByUsername(username: string): Promise<SlackTestUser | null> {
    let cursor: string | undefined;

    do {
      const params: Record<string, string> = { limit: '200' };
      if (cursor) {
        params.cursor = cursor;
      }

      const response = await this.api<UsersListResponse>('GET', 'users.list', params);

      for (const user of response.members || []) {
        if (user.name === username) {
          return user;
        }
      }

      cursor = response.response_metadata?.next_cursor;
    } while (cursor);

    return null;
  }

  /**
   * List all users in the workspace
   */
  async listUsers(options?: { limit?: number }): Promise<SlackTestUser[]> {
    const allUsers: SlackTestUser[] = [];
    let cursor: string | undefined;
    const limit = options?.limit || 200;

    do {
      const params: Record<string, string> = { limit: String(limit) };
      if (cursor) {
        params.cursor = cursor;
      }

      const response = await this.api<UsersListResponse>('GET', 'users.list', params);
      allUsers.push(...(response.members || []));

      cursor = response.response_metadata?.next_cursor;
    } while (cursor);

    return allUsers;
  }

  // ============================================================================
  // Channels
  // ============================================================================

  /**
   * Get channel info
   */
  async getChannel(channelId: string): Promise<SlackTestChannel> {
    const response = await this.api<ChannelsInfoResponse>('GET', 'conversations.info', {
      channel: channelId,
    });
    return response.channel;
  }

  /**
   * Join a channel
   */
  async joinChannel(channelId: string): Promise<void> {
    await this.api('POST', 'conversations.join', {
      channel: channelId,
    });
  }

  // ============================================================================
  // Posts (Messages)
  // ============================================================================

  /**
   * Create a post (message)
   *
   * @param channelId - Channel to post to
   * @param text - Message text
   * @param threadTs - Thread timestamp (for replies)
   * @returns The created post with its timestamp (ts)
   */
  async createPost(params: {
    channel: string;
    text: string;
    thread_ts?: string;
  }): Promise<SlackTestPost> {
    const response = await this.api<PostMessageResponse>('POST', 'chat.postMessage', params);
    return response.message;
  }

  /**
   * Get a post by timestamp
   *
   * Note: Slack identifies messages by channel + timestamp.
   * Uses conversations.history with inclusive bounds to get a single message.
   */
  async getPost(channelId: string, ts: string): Promise<SlackTestPost | null> {
    try {
      const response = await this.api<ConversationsHistoryResponse>(
        'GET',
        'conversations.history',
        {
          channel: channelId,
          latest: ts,
          oldest: ts,
          inclusive: 'true',
          limit: '1',
        },
      );

      if (response.messages && response.messages.length > 0) {
        return response.messages[0];
      }

      return null;
    } catch (err) {
      // Handle "message_not_found" error
      if (err instanceof Error && err.message.includes('message_not_found')) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Update a post
   */
  async updatePost(channelId: string, ts: string, text: string): Promise<SlackTestPost> {
    const response = await this.api<UpdateMessageResponse>('POST', 'chat.update', {
      channel: channelId,
      ts,
      text,
    });

    // Return a minimal post object since chat.update doesn't return full message
    return {
      type: 'message',
      ts: response.ts,
      text: response.text,
    };
  }

  /**
   * Delete a post
   */
  async deletePost(channelId: string, ts: string): Promise<void> {
    await this.api('POST', 'chat.delete', {
      channel: channelId,
      ts,
    });
  }

  /**
   * Get posts in a thread
   */
  async getThreadPosts(
    channelId: string,
    threadTs: string,
    options?: { limit?: number },
  ): Promise<SlackTestPost[]> {
    const response = await this.api<ConversationsRepliesResponse>(
      'GET',
      'conversations.replies',
      {
        channel: channelId,
        ts: threadTs,
        limit: String(options?.limit || 100),
      },
    );

    return response.messages || [];
  }

  /**
   * Get posts in a channel
   */
  async getChannelPosts(
    channelId: string,
    options?: { limit?: number; cursor?: string },
  ): Promise<{
    messages: SlackTestPost[];
    has_more: boolean;
    next_cursor?: string;
  }> {
    const response = await this.api<ConversationsHistoryResponse>(
      'GET',
      'conversations.history',
      {
        channel: channelId,
        limit: String(options?.limit || 100),
        cursor: options?.cursor,
      },
    );

    return {
      messages: response.messages || [],
      has_more: response.has_more,
      next_cursor: response.response_metadata?.next_cursor,
    };
  }

  // ============================================================================
  // Pinned Posts
  // ============================================================================

  /**
   * Pin a post
   */
  async pinPost(channelId: string, ts: string): Promise<void> {
    await this.api('POST', 'pins.add', {
      channel: channelId,
      timestamp: ts,
    });
  }

  /**
   * Unpin a post
   */
  async unpinPost(channelId: string, ts: string): Promise<void> {
    await this.api('POST', 'pins.remove', {
      channel: channelId,
      timestamp: ts,
    });
  }

  /**
   * Get pinned posts in a channel
   */
  async getPinnedPosts(channelId: string): Promise<SlackTestPin[]> {
    const response = await this.api<PinsListResponse>('GET', 'pins.list', {
      channel: channelId,
    });
    return response.items || [];
  }

  // ============================================================================
  // Reactions
  // ============================================================================

  /**
   * Add a reaction to a post
   *
   * Note: In Slack, reaction names don't include colons.
   * e.g., use "thumbsup" not ":thumbsup:"
   */
  async addReaction(channelId: string, ts: string, name: string): Promise<void> {
    // Remove colons if present (for consistency with Mattermost API)
    const cleanName = name.replace(/^:|:$/g, '');

    await this.api('POST', 'reactions.add', {
      channel: channelId,
      timestamp: ts,
      name: cleanName,
    });
  }

  /**
   * Remove a reaction from a post
   */
  async removeReaction(channelId: string, ts: string, name: string): Promise<void> {
    const cleanName = name.replace(/^:|:$/g, '');

    await this.api('POST', 'reactions.remove', {
      channel: channelId,
      timestamp: ts,
      name: cleanName,
    });
  }

  /**
   * Get reactions on a post
   */
  async getReactions(channelId: string, ts: string): Promise<SlackTestReaction[]> {
    try {
      const response = await this.api<ReactionsGetResponse>('GET', 'reactions.get', {
        channel: channelId,
        timestamp: ts,
      });

      return response.message?.reactions || [];
    } catch (err) {
      // Handle "no_item_specified" or other errors
      if (err instanceof Error && err.message.includes('no_reaction')) {
        return [];
      }
      throw err;
    }
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  /**
   * Delete all posts in a channel (for cleanup)
   *
   * Note: This is slow for large channels. Use with caution.
   * Some messages may not be deletable (e.g., from other apps).
   */
  async deleteAllPostsInChannel(channelId: string): Promise<number> {
    let count = 0;
    let hasMore = true;
    let cursor: string | undefined;

    while (hasMore) {
      const result = await this.getChannelPosts(channelId, { limit: 100, cursor });

      for (const message of result.messages) {
        try {
          await this.deletePost(channelId, message.ts);
          count++;
        } catch {
          // Ignore errors (message may already be deleted or not deletable)
        }
      }

      hasMore = result.has_more;
      cursor = result.next_cursor;

      // Safety limit to prevent infinite loops
      if (count > 1000) {
        break;
      }
    }

    return count;
  }

  /**
   * Wait for a message to appear in a channel/thread
   *
   * Useful for waiting for bot responses in tests.
   */
  async waitForMessage(
    channelId: string,
    options: {
      threadTs?: string;
      containsText?: string;
      fromUser?: string;
      timeout?: number;
      pollInterval?: number;
    } = {},
  ): Promise<SlackTestPost | null> {
    const timeout = options.timeout || 10000;
    const pollInterval = options.pollInterval || 500;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const messages = options.threadTs
        ? await this.getThreadPosts(channelId, options.threadTs)
        : (await this.getChannelPosts(channelId, { limit: 20 })).messages;

      for (const message of messages) {
        // Check filters
        if (options.containsText && !message.text.includes(options.containsText)) {
          continue;
        }
        if (options.fromUser && message.user !== options.fromUser) {
          continue;
        }

        return message;
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return null;
  }

  /**
   * Convert a Slack timestamp to a Date object
   */
  static tsToDate(ts: string): Date {
    const [seconds] = ts.split('.');
    return new Date(parseInt(seconds, 10) * 1000);
  }

  /**
   * Convert a Date object to a Slack timestamp format
   */
  static dateToTs(date: Date): string {
    return `${Math.floor(date.getTime() / 1000)}.000000`;
  }
}
