/**
 * Base Platform Client
 *
 * Abstract base class that provides shared functionality for all platform
 * client implementations. This eliminates ~400-500 lines of duplicated code
 * between Mattermost and Slack clients.
 *
 * Shared functionality:
 * - Connection state management (isConnected, isIntentionalDisconnect, isReconnecting)
 * - Heartbeat monitoring for dead connection detection
 * - Reconnection with exponential backoff
 * - User allowlist checking
 * - Interactive post creation pattern
 *
 * Platform-specific functionality (implemented by subclasses):
 * - API request methods (different rate limiting, error handling)
 * - Event handling (WebSocket vs Socket Mode)
 * - User lookup strategies
 * - Message normalization
 */

import { EventEmitter } from 'events';
import { wsLogger, createLogger } from '../utils/logger.js';
import type { PlatformClient } from './client.js';
import type {
  PlatformUser,
  PlatformPost,
  PlatformFile,
  ThreadMessage,
} from './types.js';
import type { PlatformFormatter } from './formatter.js';

const log = createLogger('base-client');

/**
 * MCP configuration returned by getMcpConfig().
 * Extended by platform-specific configs.
 */
export interface BaseMcpConfig {
  type: string;
  url: string;
  token: string;
  channelId: string;
  allowedUsers: string[];
}

/**
 * Abstract base class for platform clients.
 *
 * Provides shared implementation for:
 * - Heartbeat monitoring
 * - Reconnection logic
 * - User allowlist
 * - Interactive post creation
 */
export abstract class BasePlatformClient extends EventEmitter implements PlatformClient {
  // ============================================================================
  // Identity (from PlatformClient interface)
  // ============================================================================

  abstract readonly platformId: string;
  abstract readonly platformType: string;
  abstract readonly displayName: string;

  // ============================================================================
  // Shared State
  // ============================================================================

  protected allowedUsers: string[] = [];
  protected botName: string = '';

  // Connection state
  protected isIntentionalDisconnect = false;
  protected isReconnecting = false;

  // Heartbeat monitoring
  protected heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  protected lastMessageAt = Date.now();
  protected readonly HEARTBEAT_INTERVAL_MS = 30000; // Check every 30s
  protected readonly HEARTBEAT_TIMEOUT_MS = 60000; // Reconnect if no message for 60s

  // Reconnection
  protected reconnectAttempts = 0;
  protected maxReconnectAttempts = 10;
  protected reconnectDelay = 1000;
  protected reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  // ============================================================================
  // Abstract Methods (must be implemented by subclasses)
  // ============================================================================

  /**
   * Connect to the platform.
   */
  abstract connect(): Promise<void>;

  /**
   * Get the bot's own user info.
   */
  abstract getBotUser(): Promise<PlatformUser>;

  /**
   * Get a user by their ID.
   */
  abstract getUser(userId: string): Promise<PlatformUser | null>;

  /**
   * Get a user by their username.
   */
  abstract getUserByUsername(username: string): Promise<PlatformUser | null>;

  /**
   * Create a new post/message.
   */
  abstract createPost(message: string, threadId?: string): Promise<PlatformPost>;

  /**
   * Update an existing post/message.
   */
  abstract updatePost(postId: string, message: string): Promise<PlatformPost>;

  /**
   * Get a post by ID.
   */
  abstract getPost(postId: string): Promise<PlatformPost | null>;

  /**
   * Delete a post.
   */
  abstract deletePost(postId: string): Promise<void>;

  /**
   * Add a reaction to a post.
   */
  abstract addReaction(postId: string, emojiName: string): Promise<void>;

  /**
   * Remove a reaction from a post.
   */
  abstract removeReaction(postId: string, emojiName: string): Promise<void>;

  /**
   * Pin a post to the channel.
   */
  abstract pinPost(postId: string): Promise<void>;

  /**
   * Unpin a post from the channel.
   */
  abstract unpinPost(postId: string): Promise<void>;

  /**
   * Get all pinned posts in the channel.
   */
  abstract getPinnedPosts(): Promise<string[]>;

  /**
   * Get platform-specific message size limits.
   */
  abstract getMessageLimits(): { maxLength: number; hardThreshold: number };

  /**
   * Get thread history (messages in a thread).
   */
  abstract getThreadHistory(
    threadId: string,
    options?: { limit?: number; excludeBotMessages?: boolean }
  ): Promise<ThreadMessage[]>;

  /**
   * Check if a message mentions the bot.
   */
  abstract isBotMentioned(message: string): boolean;

  /**
   * Extract the prompt from a message (remove bot mention).
   */
  abstract extractPrompt(message: string): string;

  /**
   * Send typing indicator.
   */
  abstract sendTyping(threadId?: string): void;

  /**
   * Get a clickable link to a thread.
   */
  abstract getThreadLink(threadId: string, lastMessageId?: string, lastMessageTs?: string): string;

  /**
   * Get MCP config for permission server.
   */
  abstract getMcpConfig(): BaseMcpConfig;

  /**
   * Get the platform-specific markdown formatter.
   */
  abstract getFormatter(): PlatformFormatter;

  /**
   * Download a file attachment (optional).
   */
  abstract downloadFile(fileId: string): Promise<Buffer>;

  /**
   * Get file metadata (optional).
   */
  abstract getFileInfo(fileId: string): Promise<PlatformFile>;

  /**
   * Force close the connection (called by heartbeat when connection is dead).
   * Subclasses should close their WebSocket/connection here.
   */
  protected abstract forceCloseConnection(): void;

  /**
   * Recover messages that were posted while disconnected.
   */
  protected abstract recoverMissedMessages(): Promise<void>;

  // ============================================================================
  // Shared Implementations
  // ============================================================================

  /**
   * Check if a username is in the allowed users list.
   * If no allowlist is configured, allows all users.
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
   * Create a post with reaction options for user interaction.
   *
   * This is a common pattern for interactive posts that need user response
   * via reactions (e.g., approval prompts, questions, permission requests).
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
   * Disconnect from the platform.
   * Can be overridden by subclasses to add platform-specific cleanup.
   */
  disconnect(): void {
    wsLogger.info('Disconnecting (intentional)');
    this.isIntentionalDisconnect = true;
    this.stopHeartbeat();
    // Cancel any pending reconnect timeout to prevent reconnection after intentional disconnect
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.forceCloseConnection();
  }

  /**
   * Prepare for reconnection after intentional disconnect.
   * Resets the intentional disconnect flag and reconnect attempts
   * so that connect() will work again.
   */
  prepareForReconnect(): void {
    wsLogger.debug('Preparing for reconnect (resetting intentional disconnect flag)');
    this.isIntentionalDisconnect = false;
    this.reconnectAttempts = 0;
  }

  /**
   * Start heartbeat monitoring to detect dead connections.
   * If no activity is detected for HEARTBEAT_TIMEOUT_MS, forces a reconnect.
   */
  protected startHeartbeat(): void {
    this.stopHeartbeat(); // Clear any existing
    this.lastMessageAt = Date.now();

    this.heartbeatInterval = setInterval(() => {
      const silentFor = Date.now() - this.lastMessageAt;

      // If no message received for too long, connection is dead
      if (silentFor > this.HEARTBEAT_TIMEOUT_MS) {
        log.warn(`Connection dead (no activity for ${Math.round(silentFor / 1000)}s), reconnecting...`);
        this.stopHeartbeat();
        // Don't just close - actually trigger reconnection!
        // forceCloseConnection() removes the onclose handler, so we must call scheduleReconnect() explicitly
        this.scheduleReconnect();
        return;
      }

      wsLogger.debug(`Heartbeat check (last activity ${Math.round(silentFor / 1000)}s ago)`);
    }, this.HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Stop heartbeat monitoring.
   */
  protected stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Schedule a reconnection with exponential backoff.
   * Can be overridden by subclasses to add platform-specific behavior.
   */
  protected scheduleReconnect(): void {
    // Clear any existing reconnect timeout to prevent duplicate attempts
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.error('Max reconnection attempts reached');
      return;
    }

    // Clean up any existing connection before reconnecting
    // This is critical for recovery after long idle periods where the socket may be stale
    this.forceCloseConnection();

    // Mark that we're reconnecting (to trigger message recovery)
    this.isReconnecting = true;

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    wsLogger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    this.emit('reconnecting', this.reconnectAttempts);

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      // Check if disconnect was called while we were waiting
      if (this.isIntentionalDisconnect) {
        wsLogger.debug('Skipping reconnect: intentional disconnect was called');
        return;
      }
      this.connect().catch((err) => {
        wsLogger.error(`Reconnection failed: ${err}`);
        // Auto-retry: schedule another reconnect attempt on failure
        this.scheduleReconnect();
      });
    }, delay);
  }

  /**
   * Handle successful connection.
   * Call this from connect() after authentication is complete.
   */
  protected onConnectionEstablished(): void {
    this.reconnectAttempts = 0;
    this.startHeartbeat();
    this.emit('connected');

    // Recover missed messages after reconnection
    if (this.isReconnecting) {
      this.recoverMissedMessages().catch((err) => {
        log.warn(`Failed to recover missed messages: ${err}`);
      });
    }
    this.isReconnecting = false;
  }

  /**
   * Handle connection closed.
   * Call this from WebSocket onclose handler.
   */
  protected onConnectionClosed(): void {
    this.stopHeartbeat();
    this.emit('disconnected');

    // Only reconnect if this wasn't an intentional disconnect
    if (!this.isIntentionalDisconnect) {
      wsLogger.debug('Scheduling reconnect...');
      this.scheduleReconnect();
    } else {
      wsLogger.debug('Intentional disconnect, not reconnecting');
    }
  }

  /**
   * Update last message timestamp (call on every incoming message).
   */
  protected updateLastMessageTime(): void {
    this.lastMessageAt = Date.now();
  }
}
