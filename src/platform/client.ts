import { EventEmitter } from 'events';
import type {
  PlatformUser,
  PlatformPost,
  PlatformReaction,
  PlatformFile,
  ThreadMessage,
  DeliveryTarget,
} from './types.js';
import type { PlatformFormatter } from './formatter.js';

/**
 * Events emitted by PlatformClient
 */
export interface PlatformClientEvents {
  connected: () => void;
  disconnected: () => void;
  reconnecting: (attempt: number) => void;
  error: (error: Error) => void;
  message: (post: PlatformPost, user: PlatformUser | null) => void;
  /** Emitted when a reaction is added */
  reaction: (reaction: PlatformReaction, user: PlatformUser | null) => void;
  /** Emitted when a reaction is removed */
  reaction_removed: (reaction: PlatformReaction, user: PlatformUser | null) => void;
  /** Emitted when someone posts at channel level (not in a thread) */
  channel_post: (post: PlatformPost, user: PlatformUser | null) => void;
}

/**
 * Platform-agnostic client interface
 *
 * Every platform implementation must implement this interface. This allows
 * SessionManager and other code to work with any platform without knowing
 * the specific implementation details.
 */
export interface PlatformClient extends EventEmitter {
  // ============================================================================
  // Identity
  // ============================================================================

  /**
   * Unique identifier for this platform instance
   * e.g., 'mattermost-internal', 'mattermost-eng'
   */
  readonly platformId: string;

  /**
   * Platform type
   * e.g., 'mattermost'
   */
  readonly platformType: string;

  /**
   * Human-readable display name
   * e.g., 'Internal Team', 'Engineering'
   */
  readonly displayName: string;

  // ============================================================================
  // Connection Management
  // ============================================================================

  /**
   * Connect to the platform (WebSocket, Socket Mode, etc.)
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the platform.
   *
   * Returns a Promise that resolves when the underlying socket has fully
   * closed. Production callers may fire-and-forget; tests should `await`.
   */
  disconnect(): Promise<void>;

  /**
   * Prepare for reconnection after intentional disconnect
   * Resets internal state (intentionalDisconnect flag, reconnect attempts)
   * so that connect() will work again.
   */
  prepareForReconnect(): void;

  // ============================================================================
  // User Management
  // ============================================================================

  /**
   * Get the bot's own user info
   */
  getBotUser(): Promise<PlatformUser>;

  /**
   * Get a user by their ID
   */
  getUser(userId: string): Promise<PlatformUser | null>;

  /**
   * Get a user by their username
   * @param username - Username to look up (without @ prefix)
   * @returns The user, or null if not found
   */
  getUserByUsername(username: string): Promise<PlatformUser | null>;

  /**
   * Check if a username is in the allowed users list
   */
  isUserAllowed(username: string): boolean;

  /**
   * Get the bot's mention name (e.g., 'claude-code')
   */
  getBotName(): string;

  /**
   * Get platform config for MCP permission server
   */
  getMcpConfig(): {
    type: string;
    url: string;
    token: string;
    channelId: string;
    allowedUsers: string[];
    outboundFiles?: { enabled?: boolean; maxBytes?: number };
    /**
     * Teammate registry and who else holds sessions in this channel. Rides on
     * the MCP config so the agent's `send_to_teammate` and the bot's own docs
     * ping route through one rule instead of each deciding for itself.
     */
    teammates?: Array<{ name: string; channelId: string }>;
    teammatesPresent?: string[];
  };

  /**
   * Get the platform-specific markdown formatter
   * Use this to format bold, code, etc. in a platform-appropriate way.
   */
  getFormatter(): PlatformFormatter;

  /**
   * Get a clickable link to a thread
   * @param threadId - Thread/root post ID
   * @param lastMessageId - Optional: ID of the last message to jump to bottom
   * @returns URL that links to the thread (platform-specific format)
   */
  getThreadLink(threadId: string, lastMessageId?: string): string;

  // ============================================================================
  // Messaging
  // ============================================================================

  /**
   * Create a new post/message
   * @param message - Message text
   * @param threadId - Optional thread parent ID
   * @returns The created post
   */
  createPost(message: string, threadId?: string): Promise<PlatformPost>;

  /**
   * Resolve a chat permalink to the thread a reply must land in.
   *
   * Unlike the `read_post` MCP tool this is NOT scoped to the bot's own
   * channel: the whole point is answering a teammate whose thread lives in
   * their channel. Access is still bounded by the bot's membership — the
   * platform API rejects channels it isn't in.
   *
   * @param url - Candidate permalink (may be any URL; non-permalinks return null)
   * @returns Delivery target, or null if the URL isn't a permalink for this platform
   */
  resolveDeliveryTarget?(url: string): Promise<DeliveryTarget | null>;

  /**
   * Post a message into an arbitrary thread, possibly in another channel.
   * An empty `target.rootId` posts at channel level instead of in a thread —
   * that's the cold-start case (e.g. first contact with a teammate bot).
   * @param target - Channel + thread root to post into
   * @param message - Message text
   */
  deliverToThread?(target: DeliveryTarget, message: string): Promise<PlatformPost>;

  /**
   * Update an existing post/message
   * @param postId - Post ID to update
   * @param message - New message text
   * @returns The updated post
   */
  updatePost(postId: string, message: string): Promise<PlatformPost>;

  /**
   * Create a post with reaction options (for interactive prompts)
   * @param message - Message text
   * @param reactions - Array of emoji names to add as options
   * @param threadId - Optional thread parent ID
   * @returns The created post
   */
  createInteractivePost(
    message: string,
    reactions: string[],
    threadId?: string
  ): Promise<PlatformPost>;

  /**
   * Get a post by ID
   * @param postId - Post ID
   * @returns The post, or null if not found/deleted
   */
  getPost(postId: string): Promise<PlatformPost | null>;

  /**
   * Delete a post
   * @param postId - Post ID to delete
   */
  deletePost(postId: string): Promise<void>;

  /**
   * Pin a post to the channel
   * @param postId - Post ID to pin
   */
  pinPost(postId: string): Promise<void>;

  /**
   * Unpin a post from the channel
   * @param postId - Post ID to unpin
   */
  unpinPost(postId: string): Promise<void>;

  /**
   * Get all pinned posts in the channel
   * @returns Array of pinned post IDs
   */
  getPinnedPosts(): Promise<string[]>;

  /**
   * Get platform-specific message size limits
   * @returns maxLength: absolute max chars, hardThreshold: when to force continuation
   */
  getMessageLimits(): { maxLength: number; hardThreshold: number };

  /**
   * Get thread history (messages in a thread)
   * @param threadId - Thread/root post ID
   * @param options - Optional filtering/limiting options
   * @returns Array of messages in chronological order (oldest first)
   */
  getThreadHistory(
    threadId: string,
    options?: { limit?: number; excludeBotMessages?: boolean }
  ): Promise<ThreadMessage[]>;

  // ============================================================================
  // Reactions
  // ============================================================================

  /**
   * Add a reaction to a post
   * @param postId - Post ID
   * @param emojiName - Emoji name (e.g., '+1', 'white_check_mark')
   */
  addReaction(postId: string, emojiName: string): Promise<void>;

  /**
   * Remove a reaction from a post
   * @param postId - Post ID
   * @param emojiName - Emoji name (e.g., '+1', 'white_check_mark')
   */
  removeReaction(postId: string, emojiName: string): Promise<void>;

  // ============================================================================
  // Bot Mentions
  // ============================================================================

  /**
   * Check if a message mentions the bot
   * @param message - Message text
   */
  isBotMentioned(message: string): boolean;

  /**
   * Extract the prompt from a message (remove bot mention)
   * @param message - Message text
   * @returns The message with bot mention removed
   */
  extractPrompt(message: string): string;

  // ============================================================================
  // Typing Indicator
  // ============================================================================

  /**
   * Send typing indicator to show bot is "thinking"
   * @param threadId - Optional thread ID
   */
  sendTyping(threadId?: string): void;

  // ============================================================================
  // Files (Optional - may not be supported by all platforms)
  // ============================================================================

  /**
   * Download a file attachment
   * @param fileId - File ID
   * @returns File contents as Buffer
   */
  downloadFile?(fileId: string): Promise<Buffer>;

  /**
   * Get file metadata
   * @param fileId - File ID
   * @returns File metadata
   */
  getFileInfo?(fileId: string): Promise<PlatformFile>;

  /**
   * Upload a file from disk and post it into a thread.
   *
   * Optional — implementations that don't support outbound uploads omit it,
   * and callers must check before invoking. Path validation is the caller's
   * responsibility (see src/mcp/path-validator.ts).
   *
   * Returns just the ids, not a full `PlatformPost`. The narrow shape is
   * deliberate: an upload API need not return a usable post id, so a
   * synthesized `PlatformPost.id` could be a file id pretending to be a
   * post id — a footgun for any caller that later passes it to
   * `updatePost` or `addReaction`. Callers that genuinely need a
   * `PlatformPost` should synthesize it deliberately at the call site.
   *
   * @param filePath - Absolute path of the file to upload
   * @param threadId - Thread parent id (`root_id` on Mattermost)
   * @param options.caption - Optional message body / initial comment
   * @param options.filename - Display filename (defaults to basename of filePath)
   */
  uploadFile?(
    filePath: string,
    threadId: string,
    options?: { caption?: string; filename?: string },
  ): Promise<{ postId: string; fileId?: string }>;

  // ============================================================================
  // Event Emitter Methods (inherited from EventEmitter)
  // ============================================================================

  on<K extends keyof PlatformClientEvents>(
    event: K,
    listener: PlatformClientEvents[K]
  ): this;

  emit<K extends keyof PlatformClientEvents>(
    event: K,
    ...args: Parameters<PlatformClientEvents[K]>
  ): boolean;
}
