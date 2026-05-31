/**
 * Direct Mattermost API helpers for integration tests
 *
 * This bypasses the main PlatformClient for test orchestration,
 * allowing us to set up test data and verify results directly.
 */

export interface MattermostUser {
  id: string;
  username: string;
  email: string;
  first_name?: string;
  last_name?: string;
  nickname?: string;
  roles?: string;
}

export interface MattermostTeam {
  id: string;
  name: string;
  display_name: string;
  type: string;
}

export interface MattermostChannel {
  id: string;
  team_id: string;
  name: string;
  display_name: string;
  type: string;
}

export interface MattermostPost {
  id: string;
  channel_id: string;
  user_id: string;
  root_id?: string;
  message: string;
  create_at: number;
  update_at: number;
  metadata?: {
    reactions?: MattermostReaction[];
  };
}

export interface MattermostReaction {
  user_id: string;
  post_id: string;
  emoji_name: string;
  create_at: number;
}

export interface MattermostBot {
  user_id: string;
  username: string;
  display_name: string;
  description?: string;
  owner_id: string;
}

export interface MattermostAccessToken {
  id: string;
  token: string;
  user_id: string;
  description: string;
}

/**
 * Direct Mattermost API client for test orchestration
 */
export class MattermostTestApi {
  constructor(
    private baseUrl: string,
    private token?: string,
  ) {}

  /**
   * Set the authentication token
   */
  setToken(token: string): void {
    this.token = token;
  }

  /**
   * Make an API request.
   *
   * Retries on HTTP 500 with exponential backoff (500ms, 1s, 2s — same shape
   * as src/platform/mattermost/client.ts). Mattermost's CreatePost path has
   * a residual thread-write race even on 10.11.15 that surfaces as transient
   * 500s ~5 times per integration suite run; the production bot client
   * absorbs them but this test helper used to throw on the first one,
   * killing whichever test was unlucky enough to hit it.
   */
  private async api<T>(
    method: string,
    path: string,
    body?: unknown,
    retryCount = 0,
  ): Promise<T> {
    const MAX_RETRIES = 3;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(`${this.baseUrl}/api/v4${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status === 500 && retryCount < MAX_RETRIES) {
      const delay = 500 * Math.pow(2, retryCount);
      await new Promise((r) => setTimeout(r, delay));
      return this.api<T>(method, path, body, retryCount + 1);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error ${response.status}: ${errorText}`);
    }

    // Handle empty responses
    const text = await response.text();
    if (!text) return {} as T;

    return JSON.parse(text) as T;
  }

  // ============================================================================
  // Authentication
  // ============================================================================

  /**
   * Login with username and password
   */
  async login(username: string, password: string): Promise<{ token: string; user: MattermostUser }> {
    const response = await fetch(`${this.baseUrl}/api/v4/users/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login_id: username, password }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Login failed: ${errorText}`);
    }

    const token = response.headers.get('Token');
    if (!token) {
      throw new Error('No token in login response');
    }

    const user = await response.json() as MattermostUser;
    this.token = token;

    return { token, user };
  }

  // ============================================================================
  // Users
  // ============================================================================

  /**
   * Create a new user
   */
  async createUser(user: {
    username: string;
    password: string;
    email: string;
    first_name?: string;
    last_name?: string;
  }): Promise<MattermostUser> {
    return this.api<MattermostUser>('POST', '/users', user);
  }

  /**
   * Get user by ID
   */
  async getUser(userId: string): Promise<MattermostUser> {
    return this.api<MattermostUser>('GET', `/users/${userId}`);
  }

  /**
   * Get user by username
   */
  async getUserByUsername(username: string): Promise<MattermostUser> {
    return this.api<MattermostUser>('GET', `/users/username/${username}`);
  }

  /**
   * Get current user (me)
   */
  async getMe(): Promise<MattermostUser> {
    return this.api<MattermostUser>('GET', '/users/me');
  }

  /**
   * Create personal access token for a user
   */
  async createUserAccessToken(
    userId: string,
    description: string,
  ): Promise<MattermostAccessToken> {
    return this.api<MattermostAccessToken>('POST', `/users/${userId}/tokens`, {
      description,
    });
  }

  // ============================================================================
  // Bots
  // ============================================================================

  /**
   * Create a bot account
   */
  async createBot(bot: {
    username: string;
    display_name: string;
    description?: string;
  }): Promise<MattermostBot> {
    return this.api<MattermostBot>('POST', '/bots', bot);
  }

  /**
   * Get bot by user ID
   */
  async getBot(botUserId: string): Promise<MattermostBot> {
    return this.api<MattermostBot>('GET', `/bots/${botUserId}`);
  }

  /**
   * Create access token for bot
   */
  async createBotAccessToken(
    botUserId: string,
    description: string,
  ): Promise<MattermostAccessToken> {
    return this.api<MattermostAccessToken>('POST', `/users/${botUserId}/tokens`, {
      description,
    });
  }

  // ============================================================================
  // Teams
  // ============================================================================

  /**
   * Create a team
   */
  async createTeam(team: {
    name: string;
    display_name: string;
    type: 'O' | 'I'; // O = open, I = invite only
  }): Promise<MattermostTeam> {
    return this.api<MattermostTeam>('POST', '/teams', team);
  }

  /**
   * Get team by name
   */
  async getTeamByName(name: string): Promise<MattermostTeam> {
    return this.api<MattermostTeam>('GET', `/teams/name/${name}`);
  }

  /**
   * Add user to team
   */
  async addUserToTeam(teamId: string, userId: string): Promise<void> {
    await this.api('POST', `/teams/${teamId}/members`, {
      team_id: teamId,
      user_id: userId,
    });
  }

  // ============================================================================
  // Channels
  // ============================================================================

  /**
   * Create a channel
   */
  async createChannel(channel: {
    team_id: string;
    name: string;
    display_name: string;
    type: 'O' | 'P'; // O = public, P = private
  }): Promise<MattermostChannel> {
    return this.api<MattermostChannel>('POST', '/channels', channel);
  }

  /**
   * Get channel by name and team name
   */
  async getChannelByName(teamId: string, channelName: string): Promise<MattermostChannel> {
    return this.api<MattermostChannel>('GET', `/teams/${teamId}/channels/name/${channelName}`);
  }

  /**
   * Add user to channel
   */
  async addUserToChannel(channelId: string, userId: string): Promise<void> {
    await this.api('POST', `/channels/${channelId}/members`, {
      user_id: userId,
    });
  }

  /**
   * Delete (archive) a channel. Used to clean up per-suite isolated channels.
   */
  async deleteChannel(channelId: string): Promise<void> {
    await this.api('DELETE', `/channels/${channelId}`);
  }

  // ============================================================================
  // Posts
  // ============================================================================

  /**
   * Create a post
   */
  async createPost(post: {
    channel_id: string;
    message: string;
    root_id?: string;
  }): Promise<MattermostPost> {
    return this.api<MattermostPost>('POST', '/posts', post);
  }

  /**
   * Get a post by ID
   */
  async getPost(postId: string): Promise<MattermostPost> {
    return this.api<MattermostPost>('GET', `/posts/${postId}`);
  }

  /**
   * Update a post
   */
  async updatePost(postId: string, message: string): Promise<MattermostPost> {
    return this.api<MattermostPost>('PUT', `/posts/${postId}`, {
      id: postId,
      message,
    });
  }

  /**
   * Delete a post
   */
  async deletePost(postId: string): Promise<void> {
    await this.api('DELETE', `/posts/${postId}`);
  }

  /**
   * Get posts in a thread
   */
  async getThreadPosts(rootId: string): Promise<{
    order: string[];
    posts: Record<string, MattermostPost>;
  }> {
    return this.api('GET', `/posts/${rootId}/thread`);
  }

  /**
   * Get posts in a channel
   */
  async getChannelPosts(
    channelId: string,
    options?: { page?: number; per_page?: number },
  ): Promise<{
    order: string[];
    posts: Record<string, MattermostPost>;
  }> {
    const params = new URLSearchParams();
    if (options?.page !== undefined) params.set('page', String(options.page));
    if (options?.per_page !== undefined) params.set('per_page', String(options.per_page));

    const query = params.toString();
    return this.api('GET', `/channels/${channelId}/posts${query ? `?${query}` : ''}`);
  }

  // ============================================================================
  // Pinned Posts
  // ============================================================================

  /**
   * Get pinned posts in a channel
   */
  async getPinnedPosts(channelId: string): Promise<MattermostPost[]> {
    const result = await this.api<{
      order: string[];
      posts: Record<string, MattermostPost>;
    }>('GET', `/channels/${channelId}/pinned`);

    // Return posts in order
    return result.order.map((id) => result.posts[id]);
  }

  /**
   * Pin a post
   */
  async pinPost(postId: string): Promise<void> {
    await this.api('POST', `/posts/${postId}/pin`);
  }

  /**
   * Unpin a post
   */
  async unpinPost(postId: string): Promise<void> {
    await this.api('POST', `/posts/${postId}/unpin`);
  }

  // ============================================================================
  // Reactions
  // ============================================================================

  /**
   * Add a reaction to a post
   */
  async addReaction(postId: string, emojiName: string, userId: string): Promise<MattermostReaction> {
    return this.api<MattermostReaction>('POST', '/reactions', {
      user_id: userId,
      post_id: postId,
      emoji_name: emojiName,
    });
  }

  /**
   * Remove a reaction from a post
   */
  async removeReaction(postId: string, emojiName: string, userId: string): Promise<void> {
    await this.api('DELETE', `/users/${userId}/posts/${postId}/reactions/${emojiName}`);
  }

  /**
   * Get all reactions for a post
   */
  async getReactions(postId: string): Promise<MattermostReaction[]> {
    const reactions = await this.api<MattermostReaction[] | null>('GET', `/posts/${postId}/reactions`);
    // API returns null when there are no reactions
    return reactions ?? [];
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  /**
   * Delete all posts in a channel (for cleanup)
   */
  async deleteAllPostsInChannel(channelId: string): Promise<number> {
    const { posts } = await this.getChannelPosts(channelId, { per_page: 200 });
    let count = 0;

    for (const postId of Object.keys(posts)) {
      try {
        await this.deletePost(postId);
        count++;
      } catch {
        // Ignore errors (post may already be deleted)
      }
    }

    return count;
  }
}
