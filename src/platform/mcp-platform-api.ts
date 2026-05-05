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
