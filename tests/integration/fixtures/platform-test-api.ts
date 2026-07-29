/**
 * Abstract Platform Test API Interface
 *
 * This interface abstracts platform-specific test APIs so that integration
 * tests can be platform-agnostic.
 *
 * Each platform provides an adapter that implements this interface, allowing
 * the same test code to run against different chat platforms.
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Platform-agnostic user representation
 */
export interface PlatformTestUser {
  /** Unique user identifier (on Mattermost, the user ID) */
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
  /** Unique post identifier (on Mattermost, the post ID) */
  id: string;
  /** Channel where the post was created */
  channelId: string;
  /** User who created the post */
  userId: string;
  /** Message content (text/markdown) */
  message: string;
  /** Thread root ID (Mattermost root_id) - undefined for root posts */
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
    /** User ID to attribute the post to */
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
export type PlatformType = 'mattermost';

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
 * @param platformType - The type of platform ('mattermost')
 * @param config - Platform connection configuration
 * @returns A PlatformTestApi implementation for the specified platform
 *
 * @example
 * ```typescript
 * const api = createPlatformTestApi('mattermost', {
 *   baseUrl: 'http://localhost:8065',
 *   token: 'my-bot-token',
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
// Re-export for convenience
// =============================================================================

export { MattermostTestApi } from './mattermost/api-helpers.js';
