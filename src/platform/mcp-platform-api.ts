/**
 * MCP Platform API interface
 *
 * The platform-side surface exposed to the MCP child process. Covers what
 * the MCP server needs to do on behalf of Claude: post permission prompts
 * and wait for reactions, send files, read posts and thread history. Each
 * platform implements this interface with its specific API.
 */

import type { PlatformFormatter } from './formatter.js';

/**
 * Reaction event from WebSocket
 */
export interface ReactionEvent {
  postId: string;
  userId: string;
  emojiName: string;
}

/**
 * Posted message with ID
 */
export interface PostedMessage {
  id: string;
}

/**
 * A minimal view of a post used by the MCP `read_post` tool. The author's
 * username is resolved server-side so the tool result is human-readable
 * without forcing Claude to chain user lookups.
 */
export interface McpPost {
  /**
   * Platform-native post identifier. For Mattermost this is the 26-char
   * post id; for Slack it's the message timestamp string (`ts`,
   * "seconds.microseconds"). Use this when re-fetching, never compute
   * from `createAt`.
   */
  id: string;
  /**
   * Channel the post lives in. Used by the resolver to scope read_post
   * to the bot's own channel and surface "wrong channel" as a distinct
   * error. Mattermost: the 26-char channel id. Slack: the channel id
   * (`C…`/`G…`/`D…`).
   */
  channelId: string;
  userId: string;
  username: string | null;
  message: string;
  /**
   * Creation time in milliseconds since the Unix epoch.
   *
   * Best-effort across platforms: Mattermost stores ms natively, Slack
   * stores `seconds.microseconds` and we floor to ms (microsecond
   * precision is lost). Safe for sorting *within* a single platform's
   * results, but do not assume round-trippable: re-fetching by
   * `id` is the only stable reference.
   */
  createAt: number;
  /** Empty / undefined for top-level posts. */
  threadRootId?: string;
  /**
   * Visibility of the channel the post lives in. The Mattermost resolver
   * uses this to allow cross-channel reads when the target channel is a
   * public channel on the same instance — anyone in the thread could
   * already navigate there themselves, so the channel-scope guard adds no
   * privacy value. Slack does not currently set this field: its
   * MCP-side `readPost` is hard-scoped to the bot's configured channel
   * via `conversations.history`, so cross-channel reads aren't possible
   * on Slack regardless of channel visibility.
   *
   * Optional: implementations that don't classify channels (or older
   * sessions persisted before this field existed) leave it undefined,
   * which the resolver treats as "private" — fail-safe.
   */
  channelType?: 'public' | 'private';
}

/**
 * Platform-side API surface used by the MCP child process.
 */
export interface McpPlatformApi {
  /**
   * Get the markdown formatter for this platform
   */
  getFormatter(): PlatformFormatter;

  /**
   * Get the bot's user ID
   */
  getBotUserId(): Promise<string>;

  /**
   * Get a username from a user ID
   */
  getUsername(userId: string): Promise<string | null>;

  /**
   * Check if a username is in the allowed users list
   */
  isUserAllowed(username: string): boolean;

  /**
   * Create a post with reaction options
   */
  createInteractivePost(
    message: string,
    reactions: string[],
    threadId?: string
  ): Promise<PostedMessage>;

  /**
   * Update an existing post
   */
  updatePost(postId: string, message: string): Promise<void>;

  /**
   * Wait for a reaction on a post
   * Returns the reaction event or null on timeout
   */
  waitForReaction(
    postId: string,
    botUserId: string,
    timeoutMs: number
  ): Promise<ReactionEvent | null>;

  /**
   * Upload a file from disk and post it into a thread.
   *
   * Optional — implementations that don't support uploads omit it. Path
   * validation must be done by the caller (see src/mcp/path-validator.ts).
   *
   * @param filePath - Absolute path of the file to upload
   * @param threadId - Thread parent id (root_id on MM, thread_ts on Slack)
   * @param options.caption - Optional message body / initial comment
   * @param options.filename - Display filename
   */
  uploadFile?(
    filePath: string,
    threadId: string,
    options?: { caption?: string; filename?: string },
  ): Promise<{ postId: string }>;

  /**
   * Read a single post by id. Returns null if the post does not exist
   * or the bot's token cannot see it. Channel scoping is the resolver's
   * job: the returned McpPost includes `channelId` so the caller can
   * distinguish "wrong channel" from "not found" itself.
   *
   * Optional — implementations that don't support post reads omit it.
   */
  readPost?(postId: string): Promise<McpPost | null>;

  /**
   * Read posts in the thread rooted at `threadRootId`. Returns posts in
   * chronological order (oldest first). Implementations should respect the
   * `limit` cap; callers must still defend against runaway thread sizes.
   *
   * Optional — implementations that don't support thread reads omit it.
   */
  readThread?(threadRootId: string, options?: { limit?: number }): Promise<McpPost[]>;

  /**
   * Add a reaction to a post on behalf of the bot. The platform's emoji
   * vocabulary applies — if the platform rejects the emoji name, this
   * method should let the error propagate (the caller surfaces it). The
   * caller is responsible for any scope checks; this method just attaches
   * the reaction.
   *
   * Optional — implementations that don't support reactions omit it.
   */
  addReaction?(postId: string, emojiName: string): Promise<void>;

  /**
   * Read recent top-level messages from a channel, newest-first ordering
   * normalized to oldest-first on output (matching readThread). The
   * caller is responsible for scope checks: this method just hits the
   * platform API for the given channel.
   *
   * On Slack the bot must be a member of the channel; otherwise the
   * implementation returns null so the caller can map that to a clean
   * error. Mattermost returns null when the bot's token can't see the
   * channel for any reason.
   *
   * Optional — implementations that don't support channel reads omit it.
   */
  readChannelHistory?(
    channelId: string,
    options?: { limit?: number },
  ): Promise<McpPost[] | null>;

  /**
   * Look up a channel by its identifier and return basic metadata. Used
   * by tools that need to apply the in-scope predicate (bot's channel ∪
   * public channels) before fetching history. Returns null when the
   * channel isn't visible to the bot's token.
   *
   * `name` is the human-readable channel name when available (used in
   * the send_dm attribution prefix so recipients see "#general" instead
   * of a 26-char id). Best-effort: implementations may omit it.
   *
   * Optional — implementations that don't support channel introspection
   * omit it.
   */
  getChannelInfo?(channelId: string): Promise<{
    id: string;
    channelType: 'public' | 'private';
    name?: string;
  } | null>;

  /**
   * Return the user IDs of members in a channel. Used by send_dm to
   * verify the recipient is a member of the bot's channel before
   * sending. Implementations should cache for a short TTL since
   * membership rarely changes within a session.
   *
   * Optional — implementations that don't expose channel members omit it.
   */
  getChannelMembers?(channelId: string): Promise<string[] | null>;

  /**
   * Resolve a recipient identifier to a user ID. The shape of `recipient`
   * is platform-specific:
   *   - Mattermost: a username (`@anne` or `anne`)
   *   - Slack: a user id (`U…`) — Slack's bot tokens can't reverse-look up
   *     usernames cheaply, so this method takes the id as-is and
   *     verifies it exists.
   *
   * Returns null when the recipient can't be found.
   *
   * Optional — implementations omit when DMs aren't supported.
   */
  resolveRecipient?(recipient: string): Promise<{ id: string; username: string | null } | null>;

  /**
   * Send a direct message to a user. Returns the post id of the sent
   * message on success. The caller is responsible for membership checks,
   * attribution prefixes, and rate limits — this method just sends.
   *
   * Optional — implementations omit when DMs aren't supported.
   */
  sendDirectMessage?(recipientUserId: string, message: string): Promise<{ postId: string }>;

  /**
   * Search messages on the platform. Returns posts in unspecified order
   * (the caller should sort if it cares). The caller is responsible for
   * filtering results to the in-scope predicate — this method just runs
   * the platform's search and surfaces what it gets.
   *
   * Returns `null` when search can't be run at all (e.g., the bot
   * channel has no team to scope the search to, the search backend is
   * disabled, the platform threw). Empty array means "search ran, no
   * matches" — the handler MUST distinguish these.
   *
   * Optional — Slack does not currently support this from a bot token
   * (search.messages requires a user token), so the Slack implementation
   * omits the method.
   */
  searchMessages?(
    query: string,
    options?: { limit?: number },
  ): Promise<McpPost[] | null>;
}

/**
 * Configuration for the Mattermost MCP platform API
 */
export interface MattermostMcpApiConfig {
  platformType: 'mattermost';
  url: string;
  token: string;
  channelId: string;
  threadId?: string;
  allowedUsers: string[];
  debug?: boolean;
}

/**
 * Configuration for the Slack MCP platform API
 */
export interface SlackMcpApiConfig {
  platformType: 'slack';
  botToken: string;    // xoxb-... for Web API
  appToken: string;    // xapp-... for Socket Mode
  channelId: string;
  threadTs?: string;   // Thread timestamp
  allowedUsers: string[];
  debug?: boolean;
}
