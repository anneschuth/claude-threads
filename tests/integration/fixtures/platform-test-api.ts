/**
 * Abstract Platform Test API Interface
 *
 * This interface abstracts the differences between Mattermost and Slack test APIs
 * so that integration tests can be platform-agnostic.
 *
 * Each platform (Mattermost, Slack) provides an adapter that implements this interface,
 * allowing the same test code to run against different chat platforms.
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Platform-agnostic user representation
 */
export interface PlatformTestUser {
  /** Unique user identifier (Mattermost user ID or Slack user ID) */
  id: string;
  /** Username (e.g., "alice", "bob") */
  username: string;
  /** Display name (optional, may be first+last name or nickname) */
  displayName?: string;
  /** Email address (optional) */
  email?: string;
}

/**
 * Platform-agnostic post/message representation
 */
export interface PlatformTestPost {
  /** Unique post identifier (Mattermost post ID or Slack message ts) */
  id: string;
  /** Channel where the post was created */
  channelId: string;
  /** User who created the post */
  userId: string;
  /** Message content (text/markdown) */
  message: string;
  /** Thread root ID (Mattermost root_id or Slack thread_ts) - undefined for root posts */
  rootId?: string;
  /** Creation timestamp in milliseconds since epoch */
  createAt: number;
}

/**
 * Platform-agnostic reaction representation
 */
export interface PlatformTestReaction {
  /** Post ID the reaction is on */
  postId: string;
  /** User who added the reaction */
  userId: string;
  /** Emoji name without colons (e.g., "thumbsup", "+1", "white_check_mark") */
  emojiName: string;
  /** Creation timestamp in milliseconds (optional) */
  createAt?: number;
}

// =============================================================================
// Interface
// =============================================================================

/**
 * Platform-agnostic test API interface
 *
 * Implementations of this interface provide the ability to:
 * - Authenticate and manage users
 * - Create, read, update, and delete messages
 * - Manage threads and channel posts
 * - Add and remove reactions
 * - Clean up test data
 */
export interface PlatformTestApi {
  // ===========================================================================
  // Connection / Authentication
  // ===========================================================================

  /**
   * Set the authentication token for API calls
   * @param token - Bot token or user access token
   */
  setToken(token: string): void;

  // ===========================================================================
  // Users
  // ===========================================================================

  /**
   * Get a user by their ID
   * @param userId - The user's unique identifier
   * @returns The user object
   */
  getUser(userId: string): Promise<PlatformTestUser>;

  /**
   * Get a user by their username
   * @param username - The user's username (without @ prefix)
   * @returns The user object
   */
  getUserByUsername(username: string): Promise<PlatformTestUser>;

  // ===========================================================================
  // Messages / Posts
  // ===========================================================================

  /**
   * Create a new post/message
   * @param params.channelId - Channel to post in
   * @param params.message - Message content
   * @param params.rootId - Thread root ID for threaded replies (optional)
   * @param params.userId - User ID to attribute the post to (for mock servers)
   * @returns The created post
   */
  createPost(params: {
    channelId: string;
    message: string;
    rootId?: string;
    /** User ID to attribute the post to (for Slack mock server testing) */
    userId?: string;
  }): Promise<PlatformTestPost>;

  /**
   * Get a post by its ID
   * @param postId - The post's unique identifier
   * @returns The post object
   */
  getPost(postId: string): Promise<PlatformTestPost>;

  /**
   * Update a post's message content
   * @param postId - The post's unique identifier
   * @param message - New message content
   * @returns The updated post
   */
  updatePost(postId: string, message: string): Promise<PlatformTestPost>;

  /**
   * Delete a post
   * @param postId - The post's unique identifier
   */
  deletePost(postId: string): Promise<void>;

  // ===========================================================================
  // Threads and Channel Posts
  // ===========================================================================

  /**
   * Get all posts in a thread
   * @param rootId - The thread root post ID
   * @returns Array of posts in the thread (including the root post)
   */
  getThreadPosts(rootId: string): Promise<PlatformTestPost[]>;

  /**
   * Get posts in a channel
   * @param channelId - The channel ID
   * @param options.limit - Maximum number of posts to return (optional)
   * @returns Array of posts, ordered by creation time (newest first typically)
   */
  getChannelPosts(
    channelId: string,
    options?: { limit?: number }
  ): Promise<PlatformTestPost[]>;

  // ===========================================================================
  // Reactions
  // ===========================================================================

  /**
   * Add a reaction to a post
   * @param postId - The post to react to
   * @param emojiName - Emoji name without colons (e.g., "thumbsup")
   * @param userId - The user adding the reaction
   * @returns The created reaction
   */
  addReaction(
    postId: string,
    emojiName: string,
    userId: string
  ): Promise<PlatformTestReaction>;

  /**
   * Remove a reaction from a post
   * @param postId - The post to remove reaction from
   * @param emojiName - Emoji name without colons
   * @param userId - The user who added the reaction
   */
  removeReaction(
    postId: string,
    emojiName: string,
    userId: string
  ): Promise<void>;

  /**
   * Get all reactions on a post
   * @param postId - The post to get reactions for
   * @returns Array of reactions
   */
  getReactions(postId: string): Promise<PlatformTestReaction[]>;

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  /**
   * Delete all posts in a channel (for test cleanup)
   * @param channelId - The channel to clean
   * @returns Number of posts deleted
   */
  deleteAllPostsInChannel(channelId: string): Promise<number>;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Supported platform types
 */
export type PlatformType = 'mattermost' | 'slack';

/**
 * Configuration for creating a platform test API
 */
export interface PlatformTestApiConfig {
  /** Base URL of the platform API (e.g., "http://localhost:8065" for Mattermost) */
  baseUrl: string;
  /** Authentication token (optional, can be set later via setToken) */
  token?: string;
  /** Default channel ID for operations (optional, platform-specific usage) */
  channelId?: string;
}

/**
 * Create a platform-specific test API adapter
 *
 * @param platformType - The type of platform ('mattermost' or 'slack')
 * @param config - Platform connection configuration
 * @returns A PlatformTestApi implementation for the specified platform
 *
 * @example
 * ```typescript
 * // Create a Mattermost test API
 * const api = createPlatformTestApi('mattermost', {
 *   baseUrl: 'http://localhost:8065',
 *   token: 'my-bot-token',
 * });
 *
 * // Create a Slack test API
 * const api = createPlatformTestApi('slack', {
 *   baseUrl: 'https://slack.com',
 *   token: 'xoxb-my-bot-token',
 * });
 * ```
 */
export function createPlatformTestApi(
  platformType: PlatformType,
  config: PlatformTestApiConfig
): PlatformTestApi {
  switch (platformType) {
    case 'mattermost':
      return new MattermostTestApiAdapter(config);
    case 'slack':
      return new SlackTestApiAdapter(config);
    default:
      throw new Error(`Unknown platform type: ${platformType}`);
  }
}

// =============================================================================
// Mattermost Adapter
// =============================================================================

import {
  MattermostTestApi,
  type MattermostPost,
  type MattermostUser,
  type MattermostReaction,
} from './mattermost/api-helpers.js';

/**
 * Mattermost implementation of PlatformTestApi
 *
 * Wraps the existing MattermostTestApi to conform to the platform-agnostic interface.
 */
class MattermostTestApiAdapter implements PlatformTestApi {
  private api: MattermostTestApi;

  constructor(config: PlatformTestApiConfig) {
    this.api = new MattermostTestApi(config.baseUrl, config.token);
  }

  setToken(token: string): void {
    this.api.setToken(token);
  }

  async getUser(userId: string): Promise<PlatformTestUser> {
    const user = await this.api.getUser(userId);
    return this.mapUser(user);
  }

  async getUserByUsername(username: string): Promise<PlatformTestUser> {
    const user = await this.api.getUserByUsername(username);
    return this.mapUser(user);
  }

  async createPost(params: {
    channelId: string;
    message: string;
    rootId?: string;
    userId?: string; // Ignored for Mattermost - uses token-based auth
  }): Promise<PlatformTestPost> {
    const post = await this.api.createPost({
      channel_id: params.channelId,
      message: params.message,
      root_id: params.rootId,
    });
    return this.mapPost(post);
  }

  async getPost(postId: string): Promise<PlatformTestPost> {
    const post = await this.api.getPost(postId);
    return this.mapPost(post);
  }

  async updatePost(postId: string, message: string): Promise<PlatformTestPost> {
    const post = await this.api.updatePost(postId, message);
    return this.mapPost(post);
  }

  async deletePost(postId: string): Promise<void> {
    await this.api.deletePost(postId);
  }

  async getThreadPosts(rootId: string): Promise<PlatformTestPost[]> {
    const result = await this.api.getThreadPosts(rootId);
    // Return posts in order
    return result.order.map((id: string) => this.mapPost(result.posts[id]));
  }

  async getChannelPosts(
    channelId: string,
    options?: { limit?: number }
  ): Promise<PlatformTestPost[]> {
    const result = await this.api.getChannelPosts(channelId, {
      per_page: options?.limit,
    });
    // Return posts in order
    return result.order.map((id: string) => this.mapPost(result.posts[id]));
  }

  async addReaction(
    postId: string,
    emojiName: string,
    userId: string
  ): Promise<PlatformTestReaction> {
    const reaction = await this.api.addReaction(postId, emojiName, userId);
    return this.mapReaction(reaction);
  }

  async removeReaction(
    postId: string,
    emojiName: string,
    userId: string
  ): Promise<void> {
    await this.api.removeReaction(postId, emojiName, userId);
  }

  async getReactions(postId: string): Promise<PlatformTestReaction[]> {
    const reactions = await this.api.getReactions(postId);
    return reactions.map((r: MattermostReaction) => this.mapReaction(r));
  }

  async deleteAllPostsInChannel(channelId: string): Promise<number> {
    return this.api.deleteAllPostsInChannel(channelId);
  }

  // ===========================================================================
  // Private mapping helpers
  // ===========================================================================

  private mapUser(user: MattermostUser): PlatformTestUser {
    const displayName = [user.first_name, user.last_name]
      .filter(Boolean)
      .join(' ');

    return {
      id: user.id,
      username: user.username,
      displayName: displayName || user.nickname || undefined,
      email: user.email,
    };
  }

  private mapPost(post: MattermostPost): PlatformTestPost {
    return {
      id: post.id,
      channelId: post.channel_id,
      userId: post.user_id,
      message: post.message,
      rootId: post.root_id || undefined,
      createAt: post.create_at,
    };
  }

  private mapReaction(reaction: MattermostReaction): PlatformTestReaction {
    return {
      postId: reaction.post_id,
      userId: reaction.user_id,
      emojiName: reaction.emoji_name,
      createAt: reaction.create_at,
    };
  }
}

// =============================================================================
// Slack Adapter
// =============================================================================

import {
  SlackTestApi,
  type SlackTestPost,
  type SlackTestUser,
  type SlackTestReaction,
} from './slack/api-helpers.js';

/**
 * Slack implementation of PlatformTestApi
 *
 * Wraps the SlackTestApi to conform to the platform-agnostic interface.
 *
 * Key differences from Mattermost:
 * - Messages are identified by channel + ts (timestamp), not ID
 * - Reactions store users array, not individual entries
 * - getPost requires channelId (stored in config)
 */
class SlackTestApiAdapter implements PlatformTestApi {
  private api: SlackTestApi;
  private channelId: string;

  constructor(config: PlatformTestApiConfig) {
    this.api = new SlackTestApi(config.baseUrl, config.token);
    this.channelId = config.channelId || '';
  }

  setToken(token: string): void {
    this.api.setToken(token);
  }

  async getUser(userId: string): Promise<PlatformTestUser> {
    const user = await this.api.getUser(userId);
    return this.mapUser(user);
  }

  async getUserByUsername(username: string): Promise<PlatformTestUser> {
    const user = await this.api.getUserByUsername(username);
    if (!user) {
      throw new Error(`User not found: ${username}`);
    }
    return this.mapUser(user);
  }

  async createPost(params: {
    channelId: string;
    message: string;
    rootId?: string;
    userId?: string;
  }): Promise<PlatformTestPost> {
    const post = await this.api.createPost({
      channel: params.channelId,
      text: params.message,
      thread_ts: params.rootId,
      // Pass user ID to mock server for proper test user attribution
      _test_user_id: params.userId,
    });
    return this.mapPost(post, params.channelId);
  }

  async getPost(postId: string): Promise<PlatformTestPost> {
    // In Slack, postId is the timestamp (ts)
    // We need the channelId from config
    const post = await this.api.getPost(this.channelId, postId);
    if (!post) {
      throw new Error(`Post not found: ${postId}`);
    }
    return this.mapPost(post, this.channelId);
  }

  async updatePost(postId: string, message: string): Promise<PlatformTestPost> {
    const post = await this.api.updatePost(this.channelId, postId, message);
    return this.mapPost(post, this.channelId);
  }

  async deletePost(postId: string): Promise<void> {
    await this.api.deletePost(this.channelId, postId);
  }

  async getThreadPosts(rootId: string): Promise<PlatformTestPost[]> {
    const messages = await this.api.getThreadPosts(this.channelId, rootId);
    return messages.map((m: SlackTestPost) => this.mapPost(m, this.channelId));
  }

  async getChannelPosts(
    channelId: string,
    options?: { limit?: number }
  ): Promise<PlatformTestPost[]> {
    const result = await this.api.getChannelPosts(channelId, {
      limit: options?.limit,
    });
    return result.messages.map((m: SlackTestPost) => this.mapPost(m, channelId));
  }

  async addReaction(
    postId: string,
    emojiName: string,
    userId: string
  ): Promise<PlatformTestReaction> {
    // Pass userId to mock server for proper test user attribution
    await this.api.addReaction(this.channelId, postId, emojiName, userId);
    // Return a synthetic reaction since Slack doesn't return the created reaction
    return {
      postId,
      userId,
      emojiName,
    };
  }

  async removeReaction(
    postId: string,
    emojiName: string,
    userId: string
  ): Promise<void> {
    // Pass userId to mock server for proper test user attribution
    await this.api.removeReaction(this.channelId, postId, emojiName, userId);
  }

  async getReactions(postId: string): Promise<PlatformTestReaction[]> {
    const reactions = await this.api.getReactions(this.channelId, postId);
    return this.flattenReactions(reactions, postId);
  }

  async deleteAllPostsInChannel(channelId: string): Promise<number> {
    return this.api.deleteAllPostsInChannel(channelId);
  }

  // ===========================================================================
  // Private mapping helpers
  // ===========================================================================

  private mapUser(user: SlackTestUser): PlatformTestUser {
    return {
      id: user.id,
      username: user.name,
      displayName: user.profile?.display_name || user.real_name,
      email: user.profile?.email,
    };
  }

  private mapPost(post: SlackTestPost, channelId: string): PlatformTestPost {
    return {
      id: post.ts,
      channelId,
      userId: post.user || post.bot_id || '',
      message: post.text,
      rootId: post.thread_ts !== post.ts ? post.thread_ts : undefined,
      createAt: SlackTestApi.tsToDate(post.ts).getTime(),
    };
  }

  /**
   * Flatten Slack reactions (which store users array) into individual entries
   */
  private flattenReactions(
    reactions: SlackTestReaction[],
    postId: string
  ): PlatformTestReaction[] {
    const result: PlatformTestReaction[] = [];

    for (const reaction of reactions) {
      for (const userId of reaction.users) {
        result.push({
          postId,
          userId,
          emojiName: reaction.name,
        });
      }
    }

    return result;
  }
}

// =============================================================================
// Re-export for convenience
// =============================================================================

export { MattermostTestApi } from './mattermost/api-helpers.js';
export { SlackTestApi } from './slack/api-helpers.js';
