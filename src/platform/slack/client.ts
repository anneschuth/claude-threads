import { EventEmitter } from 'events';
import type { SlackPlatformConfig } from '../../config/migration.js';
import { wsLogger, createLogger } from '../../utils/logger.js';

const log = createLogger('slack');

import type {
  SlackSocketModeEvent,
  SlackMessage,
  SlackUser,
  SlackFile,
  AuthTestResponse,
  AppsConnectionsOpenResponse,
  PostMessageResponse,
  UpdateMessageResponse,
  ConversationsRepliesResponse,
  ConversationsHistoryResponse,
  UsersInfoResponse,
  UsersListResponse,
  PinsListResponse,
  FilesInfoResponse,
  SlackApiResponse,
} from './types.js';
import type {
  PlatformClient,
  PlatformUser,
  PlatformPost,
  PlatformReaction,
  PlatformFile,
  ThreadMessage,
} from '../index.js';
import type { PlatformFormatter } from '../formatter.js';
import { SlackFormatter } from './formatter.js';

// Escape special regex characters to prevent regex injection
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Slack platform client implementation using Socket Mode.
 *
 * Socket Mode uses WebSocket for real-time events and Web API for REST calls.
 * This requires:
 * - App-level token (xapp-...) for Socket Mode WebSocket connection
 * - Bot token (xoxb-...) for Web API calls
 */
export class SlackClient extends EventEmitter implements PlatformClient {
  // Platform identity (required by PlatformClient)
  readonly platformId: string;
  readonly platformType = 'slack' as const;
  readonly displayName: string;

  private ws: WebSocket | null = null;
  private botToken: string;
  private appToken: string;
  private channelId: string;
  private botName: string;
  private allowedUsers: string[];
  private skipPermissions: boolean;
  private apiUrl: string;

  // Reconnection handling
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private isIntentionalDisconnect = false;
  private isReconnecting = false;

  // User caching
  private userCache: Map<string, SlackUser> = new Map();
  private usernameToIdCache: Map<string, string> = new Map();
  private botUserId: string | null = null;
  private botUser: SlackUser | null = null;
  private teamUrl: string | null = null;

  // Heartbeat / ping-pong for connection health
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = Date.now();
  private readonly HEARTBEAT_INTERVAL_MS = 30000; // Check every 30s
  private readonly HEARTBEAT_TIMEOUT_MS = 60000; // Reconnect if no message for 60s

  // Track last processed message for recovery after disconnection
  private lastProcessedTs: string | null = null;

  // Rate limiting with exponential backoff
  private rateLimitDelay = 0;
  private rateLimitRetryAfter = 0;

  private readonly formatter = new SlackFormatter();

  constructor(platformConfig: SlackPlatformConfig) {
    super();
    this.platformId = platformConfig.id;
    this.displayName = platformConfig.displayName;
    this.botToken = platformConfig.botToken;
    this.appToken = platformConfig.appToken;
    this.channelId = platformConfig.channelId;
    this.botName = platformConfig.botName;
    this.allowedUsers = platformConfig.allowedUsers;
    this.skipPermissions = platformConfig.skipPermissions;
    this.apiUrl = platformConfig.apiUrl || 'https://slack.com/api';
  }

  // ============================================================================
  // Type Normalization (Slack -> Platform)
  // ============================================================================

  private normalizePlatformUser(slackUser: SlackUser): PlatformUser {
    const displayName =
      slackUser.profile?.display_name ||
      slackUser.profile?.real_name ||
      slackUser.real_name ||
      slackUser.name;

    return {
      id: slackUser.id,
      username: slackUser.name,
      displayName,
      email: slackUser.profile?.email,
    };
  }

  private normalizePlatformPost(
    slackMessage: SlackMessage,
    channelId: string
  ): PlatformPost {
    // Normalize files if present
    const files = slackMessage.files?.map((f) => this.normalizePlatformFile(f));

    return {
      id: slackMessage.ts,
      platformId: this.platformId,
      channelId,
      userId: slackMessage.user || slackMessage.bot_id || '',
      message: slackMessage.text,
      rootId: slackMessage.thread_ts !== slackMessage.ts ? slackMessage.thread_ts : undefined,
      createAt: Math.floor(parseFloat(slackMessage.ts) * 1000),
      metadata: files ? { files } : undefined,
    };
  }

  private normalizePlatformFile(slackFile: SlackFile): PlatformFile {
    // Extract extension from filename or filetype
    const extension = slackFile.name?.split('.').pop() || slackFile.filetype;

    return {
      id: slackFile.id,
      name: slackFile.name,
      size: slackFile.size,
      mimeType: slackFile.mimetype,
      extension,
    };
  }

  // ============================================================================
  // Slack Web API Helpers
  // ============================================================================

  // Maximum number of rate limit retries before giving up
  private readonly MAX_RATE_LIMIT_RETRIES = 5;

  /**
   * Make a Slack Web API request with rate limiting and error handling.
   * @param expectedErrors - Array of error codes that are expected and shouldn't be logged as warnings
   */
  private async api<T extends SlackApiResponse>(
    method: string,
    endpoint: string,
    body?: Record<string, unknown>,
    retryCount = 0,
    expectedErrors: string[] = []
  ): Promise<T> {
    // Apply rate limit delay if needed
    if (this.rateLimitDelay > 0) {
      const now = Date.now();
      if (now < this.rateLimitRetryAfter) {
        const waitTime = this.rateLimitRetryAfter - now;
        log.debug(`Rate limited, waiting ${waitTime}ms`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
      this.rateLimitDelay = 0;
    }

    const url = `${this.apiUrl}/${endpoint}`;
    log.debug(`API ${method} ${endpoint}`);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.botToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    // Handle rate limiting with max retries
    if (response.status === 429) {
      if (retryCount >= this.MAX_RATE_LIMIT_RETRIES) {
        log.error(`Rate limit max retries (${this.MAX_RATE_LIMIT_RETRIES}) exceeded for ${endpoint}`);
        throw new Error(`Slack API rate limit exceeded after ${this.MAX_RATE_LIMIT_RETRIES} retries`);
      }

      const retryAfter = parseInt(response.headers.get('Retry-After') || '5', 10);
      this.rateLimitDelay = retryAfter * 1000;
      this.rateLimitRetryAfter = Date.now() + this.rateLimitDelay;
      log.warn(`Rate limited by Slack, retrying after ${retryAfter}s (attempt ${retryCount + 1}/${this.MAX_RATE_LIMIT_RETRIES})`);

      // Retry after delay
      await new Promise((resolve) => setTimeout(resolve, this.rateLimitDelay));
      return this.api<T>(method, endpoint, body, retryCount + 1);
    }

    if (!response.ok) {
      const text = await response.text();
      log.warn(`API ${method} ${endpoint} failed: ${response.status} ${text.substring(0, 100)}`);
      throw new Error(`Slack API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as T;

    if (!data.ok) {
      // Only log warning for unexpected errors
      if (!expectedErrors.includes(data.error || '')) {
        log.warn(`API ${method} ${endpoint} error: ${data.error}`);
      }
      throw new Error(`Slack API error: ${data.error}`);
    }

    log.debug(`API ${method} ${endpoint} -> ok`);
    return data;
  }

  /**
   * Make a request using the app token (for apps.connections.open).
   */
  private async appApi<T extends SlackApiResponse>(
    method: string,
    endpoint: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = `${this.apiUrl}/${endpoint}`;
    log.debug(`App API ${method} ${endpoint}`);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.appToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Slack App API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as T;

    if (!data.ok) {
      throw new Error(`Slack App API error: ${data.error}`);
    }

    return data;
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  /**
   * Connect to Slack using Socket Mode.
   *
   * Socket Mode flow:
   * 1. Call apps.connections.open with app token to get WebSocket URL
   * 2. Connect to WebSocket URL
   * 3. Receive 'hello' event to confirm connection
   * 4. Receive events and ACK within 3 seconds
   */
  async connect(): Promise<void> {
    // First, get bot user info
    await this.fetchBotUser();
    wsLogger.debug(`Slack bot user ID: ${this.botUserId}`);

    // Get WebSocket URL from apps.connections.open
    const response = await this.appApi<AppsConnectionsOpenResponse>(
      'POST',
      'apps.connections.open'
    );

    const wsUrl = response.url;
    wsLogger.info('Socket Mode: Got WebSocket URL, connecting...');

    return new Promise((resolve, reject) => {
      // Track whether promise has been settled to avoid double-resolve/reject
      let settled = false;

      const doResolve = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      const doReject = (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      // Connection timeout - if we don't get 'hello' within 30 seconds, fail
      const connectionTimeout = setTimeout(() => {
        const err = new Error('Socket Mode connection timeout: no hello received within 30 seconds');
        wsLogger.warn(`${err.message}`);
        doReject(err);
        if (this.ws) {
          this.ws.close();
        }
      }, 30000);

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        wsLogger.info('Socket Mode: WebSocket connected, waiting for hello...');
      };

      this.ws.onmessage = (event) => {
        this.lastMessageAt = Date.now();

        try {
          const data = typeof event.data === 'string' ? event.data : event.data.toString();
          const envelope = JSON.parse(data) as SlackSocketModeEvent;

          // Handle different envelope types
          this.handleSocketModeEvent(envelope);

          // Connection established on 'hello'
          if (envelope.type === 'hello') {
            clearTimeout(connectionTimeout);
            this.reconnectAttempts = 0;
            this.startHeartbeat();
            this.emit('connected');

            // Recover missed messages if reconnecting
            if (this.isReconnecting && this.lastProcessedTs) {
              this.recoverMissedMessages().catch((err) => {
                log.warn(`Failed to recover missed messages: ${err}`);
              });
            }
            this.isReconnecting = false;

            doResolve();
          }
        } catch (err) {
          wsLogger.warn(`Failed to parse Socket Mode message: ${err}`);
        }
      };

      this.ws.onclose = (event) => {
        clearTimeout(connectionTimeout);
        wsLogger.info(
          `Socket Mode: WebSocket disconnected (code: ${event.code}, reason: ${event.reason || 'none'}, clean: ${event.wasClean})`
        );
        this.stopHeartbeat();
        this.emit('disconnected');

        // If we haven't received 'hello' yet, reject the promise
        // This handles cases where the WebSocket closes before authentication completes
        if (!settled) {
          wsLogger.warn(`WebSocket closed before hello event (code: ${event.code}, reason: ${event.reason || 'none'})`);
        }
        doReject(new Error(`Socket Mode WebSocket closed before connection established (code: ${event.code})`));

        // Only reconnect if not intentional
        if (!this.isIntentionalDisconnect) {
          wsLogger.debug('Scheduling reconnect...');
          this.scheduleReconnect();
        } else {
          wsLogger.debug('Intentional disconnect, not reconnecting');
        }
      };

      this.ws.onerror = (event) => {
        clearTimeout(connectionTimeout);
        wsLogger.warn(`Socket Mode: WebSocket error: ${event}`);
        this.emit('error', new Error('Socket Mode WebSocket error'));
        doReject(new Error('Socket Mode WebSocket error'));
      };
    });
  }

  /**
   * Handle Socket Mode events.
   * Must ACK events within 3 seconds.
   */
  private handleSocketModeEvent(envelope: SlackSocketModeEvent): void {
    // ACK the envelope immediately (required within 3 seconds)
    if (envelope.envelope_id && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      wsLogger.debug(`ACKed envelope ${envelope.envelope_id}`);
    }

    // Handle disconnect request from Slack
    if (envelope.type === 'disconnect') {
      wsLogger.info('Socket Mode: Received disconnect request, reconnecting...');
      this.isReconnecting = true;
      if (this.ws) {
        this.ws.close();
      }
      return;
    }

    // Handle events_api envelopes
    if (envelope.type === 'events_api' && envelope.payload?.event) {
      this.handleSlackEvent(envelope.payload.event);
    }
  }

  /**
   * Handle Slack events (messages, reactions, etc.)
   */
  private handleSlackEvent(event: {
    type: string;
    subtype?: string;
    user?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    text?: string;
    reaction?: string;
    item?: { type: string; channel: string; ts: string };
    item_user?: string;
    bot_id?: string;
    files?: SlackFile[];
  }): void {
    // Handle message events
    if (event.type === 'message' && !event.subtype) {
      // Ignore messages from ourselves
      if (event.user === this.botUserId || event.bot_id) {
        return;
      }

      // Only handle messages in our channel
      if (event.channel !== this.channelId) {
        return;
      }

      // Track for message recovery
      if (event.ts) {
        this.lastProcessedTs = event.ts;
      }

      // Build a SlackMessage-like object
      const message: SlackMessage = {
        type: 'message',
        ts: event.ts || '',
        user: event.user,
        text: event.text || '',
        thread_ts: event.thread_ts,
        files: event.files,
      };

      const post = this.normalizePlatformPost(message, event.channel || this.channelId);

      // Get user info and emit
      this.getUser(event.user || '')
        .then((user) => {
          this.emit('message', post, user);

          // Also emit channel_post for top-level posts (not thread replies)
          if (!event.thread_ts || event.thread_ts === event.ts) {
            this.emit('channel_post', post, user);
          }
        })
        .catch((err) => {
          log.warn(`Failed to get user for message event: ${err}`);
          // Emit anyway with null user
          this.emit('message', post, null);
        });
    }

    // Handle reaction_added events
    if (event.type === 'reaction_added' && event.item?.type === 'message') {
      // Ignore reactions from ourselves
      if (event.user === this.botUserId) {
        return;
      }

      // Only handle reactions on messages in our channel
      if (event.item.channel !== this.channelId) {
        return;
      }

      const reaction: PlatformReaction = {
        userId: event.user || '',
        postId: event.item.ts,
        emojiName: event.reaction || '',
        createAt: Date.now(),
      };

      this.getUser(event.user || '')
        .then((user) => {
          this.emit('reaction', reaction, user);
        })
        .catch((err) => {
          log.warn(`Failed to get user for reaction event: ${err}`);
          this.emit('reaction', reaction, null);
        });
    }

    // Handle reaction_removed events
    if (event.type === 'reaction_removed' && event.item?.type === 'message') {
      // Ignore reactions from ourselves
      if (event.user === this.botUserId) {
        return;
      }

      // Only handle reactions on messages in our channel
      if (event.item.channel !== this.channelId) {
        return;
      }

      const reaction: PlatformReaction = {
        userId: event.user || '',
        postId: event.item.ts,
        emojiName: event.reaction || '',
        createAt: Date.now(),
      };

      this.getUser(event.user || '')
        .then((user) => {
          this.emit('reaction_removed', reaction, user);
        })
        .catch((err) => {
          log.warn(`Failed to get user for reaction_removed event: ${err}`);
          this.emit('reaction_removed', reaction, null);
        });
    }
  }

  /**
   * Schedule a reconnection with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.error('Max reconnection attempts reached');
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    log.info(`Reconnecting... (attempt ${this.reconnectAttempts})`);
    this.emit('reconnecting', this.reconnectAttempts);

    setTimeout(() => {
      this.connect().catch((err) => {
        log.error(`Reconnection failed: ${err}`);
      });
    }, delay);
  }

  /**
   * Start heartbeat to detect dead connections.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastMessageAt = Date.now();

    this.heartbeatInterval = setInterval(() => {
      const silentFor = Date.now() - this.lastMessageAt;

      if (silentFor > this.HEARTBEAT_TIMEOUT_MS) {
        log.warn(`Connection dead (no activity for ${Math.round(silentFor / 1000)}s), reconnecting...`);
        this.stopHeartbeat();
        if (this.ws) {
          this.ws.close();
        }
        return;
      }

      wsLogger.debug(`Heartbeat check (last activity ${Math.round(silentFor / 1000)}s ago)`);
    }, this.HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Stop heartbeat interval.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Recover messages that were posted while disconnected.
   */
  private async recoverMissedMessages(): Promise<void> {
    if (!this.lastProcessedTs) {
      return;
    }

    log.info(`Recovering missed messages after ts ${this.lastProcessedTs}...`);

    try {
      const response = await this.api<ConversationsHistoryResponse>(
        'GET',
        `conversations.history?channel=${this.channelId}&oldest=${this.lastProcessedTs}&inclusive=false&limit=100`
      );

      const messages = response.messages || [];

      if (messages.length === 0) {
        log.info('No missed messages to recover');
        return;
      }

      log.info(`Recovered ${messages.length} missed message(s)`);

      // Process in chronological order (oldest first)
      const sortedMessages = messages.sort(
        (a, b) => parseFloat(a.ts) - parseFloat(b.ts)
      );

      for (const message of sortedMessages) {
        // Skip bot messages
        if (message.user === this.botUserId || message.bot_id) {
          continue;
        }

        this.lastProcessedTs = message.ts;

        const post = this.normalizePlatformPost(message, this.channelId);
        const user = await this.getUser(message.user || '');

        this.emit('message', post, user);

        // Also emit channel_post for top-level posts
        if (!message.thread_ts || message.thread_ts === message.ts) {
          this.emit('channel_post', post, user);
        }
      }
    } catch (err) {
      log.warn(`Failed to recover missed messages: ${err}`);
    }
  }

  /**
   * Disconnect from Socket Mode.
   */
  disconnect(): void {
    wsLogger.info('Disconnecting Socket Mode WebSocket (intentional)');
    this.isIntentionalDisconnect = true;
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ============================================================================
  // User Management
  // ============================================================================

  /**
   * Fetch and cache the bot's own user info.
   */
  private async fetchBotUser(): Promise<void> {
    const response = await this.api<AuthTestResponse>('POST', 'auth.test');
    this.botUserId = response.user_id;
    this.teamUrl = response.url.replace(/\/$/, ''); // Remove trailing slash

    // Also fetch full user info
    const userResponse = await this.api<UsersInfoResponse>(
      'GET',
      `users.info?user=${response.user_id}`
    );
    this.botUser = userResponse.user;
    this.userCache.set(this.botUserId, this.botUser);
  }

  /**
   * Get the bot's own user info.
   */
  async getBotUser(): Promise<PlatformUser> {
    if (!this.botUser) {
      await this.fetchBotUser();
    }
    // After fetchBotUser(), botUser is guaranteed to be set
    const user = this.botUser as SlackUser;
    return this.normalizePlatformUser(user);
  }

  /**
   * Get a user by ID (cached).
   */
  async getUser(userId: string): Promise<PlatformUser | null> {
    if (!userId) {
      return null;
    }

    const cached = this.userCache.get(userId);
    if (cached) {
      log.debug(`User ${userId} found in cache: @${cached.name}`);
      return this.normalizePlatformUser(cached);
    }

    try {
      const response = await this.api<UsersInfoResponse>('GET', `users.info?user=${userId}`);
      this.userCache.set(userId, response.user);
      this.usernameToIdCache.set(response.user.name, userId);
      log.debug(`User ${userId} fetched: @${response.user.name}`);
      return this.normalizePlatformUser(response.user);
    } catch (err) {
      log.warn(`Failed to get user ${userId}: ${err}`);
      return null;
    }
  }

  /**
   * Get a user by username.
   */
  async getUserByUsername(username: string): Promise<PlatformUser | null> {
    // Check cache first
    const cachedId = this.usernameToIdCache.get(username);
    if (cachedId) {
      return this.getUser(cachedId);
    }

    try {
      log.debug(`Looking up user by username: @${username}`);

      // Slack doesn't have a direct username lookup API
      // We need to list users and find the matching one
      // For efficiency, we'll paginate through the user list
      let cursor: string | undefined;

      do {
        const params = cursor ? `cursor=${cursor}&limit=200` : 'limit=200';
        const response = await this.api<UsersListResponse>('GET', `users.list?${params}`);

        for (const user of response.members || []) {
          // Cache all users we see
          this.userCache.set(user.id, user);
          this.usernameToIdCache.set(user.name, user.id);

          if (user.name === username) {
            log.debug(`User @${username} found: ${user.id}`);
            return this.normalizePlatformUser(user);
          }
        }

        cursor = response.response_metadata?.next_cursor;
      } while (cursor);

      log.warn(`User @${username} not found`);
      return null;
    } catch (err) {
      log.warn(`Failed to lookup user @${username}: ${err}`);
      return null;
    }
  }

  /**
   * Check if a username is in the allowed users list.
   */
  isUserAllowed(username: string): boolean {
    if (this.allowedUsers.length === 0) {
      // If no allowlist configured, allow all
      return true;
    }
    return this.allowedUsers.includes(username);
  }

  /**
   * Get the bot's mention name.
   */
  getBotName(): string {
    return this.botName;
  }

  /**
   * Get MCP config for permission server.
   */
  getMcpConfig(): {
    type: string;
    url: string;
    token: string;
    channelId: string;
    allowedUsers: string[];
    appToken?: string;
  } {
    return {
      type: 'slack',
      url: 'https://slack.com', // Not really used for Slack
      token: this.botToken,
      channelId: this.channelId,
      allowedUsers: this.allowedUsers,
      appToken: this.appToken, // Required for Socket Mode in permission server
    };
  }

  /**
   * Get the platform-specific markdown formatter.
   */
  getFormatter(): PlatformFormatter {
    return this.formatter;
  }

  /**
   * Get a clickable link to a thread.
   * Slack permalink format: {team_url}/archives/{channel_id}/p{timestamp_without_dot}
   */
  getThreadLink(threadId: string): string {
    // Convert "1767690059.430179" to "1767690059430179"
    const permalinkTs = threadId.replace('.', '');
    if (this.teamUrl) {
      return `${this.teamUrl}/archives/${this.channelId}/p${permalinkTs}`;
    }
    // Fallback - won't be a proper link but won't break
    return `#${threadId}`;
  }

  // ============================================================================
  // Messaging
  // ============================================================================

  /**
   * Create a new post/message.
   */
  async createPost(message: string, threadId?: string): Promise<PlatformPost> {
    const body: Record<string, unknown> = {
      channel: this.channelId,
      text: message,
    };

    if (threadId) {
      body.thread_ts = threadId;
    }

    const response = await this.api<PostMessageResponse>('POST', 'chat.postMessage', body);

    return {
      id: response.ts,
      platformId: this.platformId,
      channelId: response.channel,
      userId: this.botUserId || '',
      message: response.message.text,
      rootId: threadId,
      createAt: Math.floor(parseFloat(response.ts) * 1000),
    };
  }

  /**
   * Update an existing post/message.
   */
  async updatePost(postId: string, message: string): Promise<PlatformPost> {
    const response = await this.api<UpdateMessageResponse>('POST', 'chat.update', {
      channel: this.channelId,
      ts: postId,
      text: message,
    });

    return {
      id: response.ts,
      platformId: this.platformId,
      channelId: response.channel,
      userId: this.botUserId || '',
      message: response.text,
      createAt: Math.floor(parseFloat(response.ts) * 1000),
    };
  }

  /**
   * Create a post with reaction options for user interaction.
   */
  async createInteractivePost(
    message: string,
    reactions: string[],
    threadId?: string
  ): Promise<PlatformPost> {
    const post = await this.createPost(message, threadId);

    // Add each reaction option, continuing even if some fail
    for (const emoji of reactions) {
      try {
        await this.addReaction(post.id, emoji);
      } catch (err) {
        log.warn(`Failed to add reaction ${emoji}: ${err}`);
      }
    }

    return post;
  }

  /**
   * Get a post by ID.
   */
  async getPost(postId: string): Promise<PlatformPost | null> {
    try {
      log.debug(`Fetching post ${postId.substring(0, 12)}`);

      // Use conversations.history with latest/oldest to get a specific message
      const response = await this.api<ConversationsHistoryResponse>(
        'GET',
        `conversations.history?channel=${this.channelId}&latest=${postId}&oldest=${postId}&inclusive=true&limit=1`
      );

      if (response.messages && response.messages.length > 0) {
        return this.normalizePlatformPost(response.messages[0], this.channelId);
      }

      return null;
    } catch (err) {
      log.debug(`Post ${postId.substring(0, 12)} not found: ${err}`);
      return null;
    }
  }

  /**
   * Delete a post.
   */
  async deletePost(postId: string): Promise<void> {
    log.debug(`Deleting post ${postId.substring(0, 12)}`);
    await this.api('POST', 'chat.delete', {
      channel: this.channelId,
      ts: postId,
    });
  }

  /**
   * Pin a post to the channel.
   */
  async pinPost(postId: string): Promise<void> {
    log.debug(`Pinning post ${postId.substring(0, 12)}`);
    try {
      await this.api('POST', 'pins.add', {
        channel: this.channelId,
        timestamp: postId,
      }, 0, ['already_pinned']);
    } catch (err) {
      // Ignore "already_pinned" - this is expected when re-pinning
      if (err instanceof Error && err.message.includes('already_pinned')) {
        log.debug(`Post ${postId.substring(0, 12)} already pinned`);
        return;
      }
      throw err;
    }
  }

  /**
   * Unpin a post from the channel.
   */
  async unpinPost(postId: string): Promise<void> {
    log.debug(`Unpinning post ${postId.substring(0, 12)}`);
    try {
      await this.api('POST', 'pins.remove', {
        channel: this.channelId,
        timestamp: postId,
      }, 0, ['no_pin']);
    } catch (err) {
      // Ignore "no_pin" - post wasn't pinned
      if (err instanceof Error && err.message.includes('no_pin')) {
        log.debug(`Post ${postId.substring(0, 12)} was not pinned`);
        return;
      }
      throw err;
    }
  }

  /**
   * Get all pinned posts in the channel.
   */
  async getPinnedPosts(): Promise<string[]> {
    const response = await this.api<PinsListResponse>('GET', `pins.list?channel=${this.channelId}`);

    return (response.items || [])
      .filter((item): item is typeof item & { message: NonNullable<typeof item.message> } => !!item.message)
      .map((item) => item.message.ts);
  }

  /**
   * Get thread history (messages in a thread).
   */
  async getThreadHistory(
    threadId: string,
    options?: { limit?: number; excludeBotMessages?: boolean }
  ): Promise<ThreadMessage[]> {
    try {
      const limit = options?.limit || 100;
      const response = await this.api<ConversationsRepliesResponse>(
        'GET',
        `conversations.replies?channel=${this.channelId}&ts=${threadId}&limit=${limit}`
      );

      const messages: ThreadMessage[] = [];

      for (const msg of response.messages || []) {
        // Skip bot messages if requested
        if (options?.excludeBotMessages && (msg.user === this.botUserId || msg.bot_id)) {
          continue;
        }

        // Get username from cache or fetch
        const user = await this.getUser(msg.user || '');
        const username = user?.username || 'unknown';

        messages.push({
          id: msg.ts,
          userId: msg.user || '',
          username,
          message: msg.text,
          createAt: Math.floor(parseFloat(msg.ts) * 1000),
        });
      }

      // Sort by timestamp (oldest first) - API returns newest first
      messages.sort((a, b) => a.createAt - b.createAt);

      return messages;
    } catch (err) {
      log.warn(`Failed to get thread history for ${threadId}: ${err}`);
      return [];
    }
  }

  // ============================================================================
  // Reactions
  // ============================================================================

  /**
   * Add a reaction to a post.
   */
  async addReaction(postId: string, emojiName: string): Promise<void> {
    log.debug(`Adding reaction :${emojiName}: to post ${postId.substring(0, 12)}`);
    await this.api('POST', 'reactions.add', {
      channel: this.channelId,
      timestamp: postId,
      name: emojiName,
    });
  }

  /**
   * Remove a reaction from a post.
   */
  async removeReaction(postId: string, emojiName: string): Promise<void> {
    log.debug(`Removing reaction :${emojiName}: from post ${postId.substring(0, 12)}`);
    await this.api('POST', 'reactions.remove', {
      channel: this.channelId,
      timestamp: postId,
      name: emojiName,
    });
  }

  // ============================================================================
  // Bot Mentions
  // ============================================================================

  /**
   * Check if a message mentions the bot.
   *
   * In Slack, mentions look like <@U12345> where U12345 is the user ID.
   * We also check for @botname for convenience.
   */
  isBotMentioned(message: string): boolean {
    // Check for user ID mention format: <@U12345>
    if (this.botUserId && message.includes(`<@${this.botUserId}>`)) {
      return true;
    }

    // Also check for @botname (case-insensitive)
    const botName = escapeRegExp(this.botName);
    const mentionPattern = new RegExp(`(^|\\s)@${botName}\\b`, 'i');
    return mentionPattern.test(message);
  }

  /**
   * Extract the prompt from a message (remove bot mention).
   */
  extractPrompt(message: string): string {
    let prompt = message;

    // Remove user ID mention format: <@U12345>
    if (this.botUserId) {
      prompt = prompt.replace(new RegExp(`<@${this.botUserId}>`, 'g'), '').trim();
    }

    // Remove @botname mentions
    const botName = escapeRegExp(this.botName);
    prompt = prompt.replace(new RegExp(`(^|\\s)@${botName}\\b`, 'gi'), ' ').trim();

    return prompt;
  }

  // ============================================================================
  // Typing Indicator
  // ============================================================================

  /**
   * Send typing indicator.
   *
   * Note: Slack doesn't have a typing indicator API for bots.
   * This is a no-op but matches the PlatformClient interface.
   */
  sendTyping(_threadId?: string): void {
    // Slack doesn't support typing indicators for bots
    // This is intentionally a no-op
  }

  // ============================================================================
  // Files
  // ============================================================================

  /**
   * Download a file attachment.
   */
  async downloadFile(fileId: string): Promise<Buffer> {
    log.debug(`Downloading file ${fileId}`);

    // First, get file info to get the download URL
    const fileInfo = await this.api<FilesInfoResponse>('GET', `files.info?file=${fileId}`);
    const downloadUrl = fileInfo.file.url_private_download || fileInfo.file.url_private;

    if (!downloadUrl) {
      throw new Error(`No download URL available for file ${fileId}`);
    }

    // Download with bot token authorization
    const response = await fetch(downloadUrl, {
      headers: {
        Authorization: `Bearer ${this.botToken}`,
      },
    });

    if (!response.ok) {
      log.warn(`Failed to download file ${fileId}: ${response.status}`);
      throw new Error(`Failed to download file ${fileId}: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    log.debug(`Downloaded file ${fileId}: ${arrayBuffer.byteLength} bytes`);
    return Buffer.from(arrayBuffer);
  }

  /**
   * Get file metadata.
   */
  async getFileInfo(fileId: string): Promise<PlatformFile> {
    const response = await this.api<FilesInfoResponse>('GET', `files.info?file=${fileId}`);
    return this.normalizePlatformFile(response.file);
  }
}
