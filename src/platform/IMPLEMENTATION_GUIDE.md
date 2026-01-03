# Platform Implementation Guide

This guide explains how to add support for a new chat platform to claude-threads.

## Overview

claude-threads uses a platform abstraction layer that normalizes differences between chat platforms. Each platform implements the `PlatformClient` interface, which provides a common API for:

- Sending and receiving messages
- Managing reactions
- User management
- File uploads
- WebSocket connections for real-time events

## Quick Start

To add a new platform (e.g., Slack):

1. Create the platform directory: `src/platform/slack/`
2. Implement the required files (see structure below)
3. Add platform type to config schema
4. Register in onboarding wizard

## Directory Structure

```
src/platform/{platform-name}/
├── client.ts         # Main PlatformClient implementation
├── types.ts          # Platform-specific types
├── formatter.ts      # Markdown formatting for this platform
├── permission-api.ts # Permission API for MCP server
└── index.ts          # Public exports
```

## Step-by-Step Implementation

### Step 1: Create Platform Types (`types.ts`)

Define types for platform-specific data structures:

```typescript
// src/platform/slack/types.ts

/**
 * Slack-specific API response types
 */
export interface SlackMessage {
  ts: string;           // Message timestamp (used as ID)
  channel: string;
  user: string;
  text: string;
  thread_ts?: string;   // Parent thread timestamp
  // ... other Slack-specific fields
}

export interface SlackUser {
  id: string;
  name: string;
  real_name: string;
  // ... other Slack-specific fields
}

export interface SlackReaction {
  name: string;
  users: string[];
  count: number;
}
```

### Step 2: Implement PlatformClient (`client.ts`)

The main implementation. Must extend `EventEmitter` and implement `PlatformClient`:

```typescript
// src/platform/slack/client.ts
import { EventEmitter } from 'events';
import type {
  PlatformClient,
  PlatformPost,
  PlatformUser,
  PlatformReaction,
  PlatformFile,
} from '../client.js';
import type { PlatformFormatter } from '../formatter.js';
import { SlackFormatter } from './formatter.js';

export class SlackClient extends EventEmitter implements PlatformClient {
  readonly platformId: string;
  readonly platformType = 'slack';
  readonly displayName: string;
  readonly formatter: PlatformFormatter;

  private token: string;
  private channelId: string;
  private allowedUsers: Set<string>;
  private botUserId: string | null = null;

  constructor(config: SlackPlatformConfig) {
    super();
    this.platformId = config.id;
    this.displayName = config.displayName ?? config.id;
    this.token = config.token;
    this.channelId = config.channelId;
    this.allowedUsers = new Set(config.allowedUsers ?? []);
    this.formatter = new SlackFormatter();
  }

  // =========================================================================
  // Connection Management
  // =========================================================================

  async connect(): Promise<void> {
    // 1. Authenticate with Slack API
    // 2. Get bot user info
    // 3. Open WebSocket connection for real-time events
    // 4. Start listening for messages and reactions
  }

  // =========================================================================
  // Message Operations
  // =========================================================================

  async createPost(message: string, threadId?: string): Promise<PlatformPost> {
    // POST to Slack's chat.postMessage API
    // Return normalized PlatformPost
  }

  async updatePost(postId: string, message: string): Promise<PlatformPost> {
    // POST to Slack's chat.update API
    // Return normalized PlatformPost
  }

  async deletePost(postId: string): Promise<void> {
    // POST to Slack's chat.delete API
  }

  async getPost(postId: string): Promise<PlatformPost> {
    // GET from Slack's conversations.history API
    // Return normalized PlatformPost
  }

  // =========================================================================
  // Reactions
  // =========================================================================

  async addReaction(postId: string, emojiName: string): Promise<void> {
    // POST to Slack's reactions.add API
  }

  async removeReaction(postId: string, emojiName: string): Promise<void> {
    // POST to Slack's reactions.remove API
  }

  // =========================================================================
  // Users
  // =========================================================================

  async getUser(userId: string): Promise<PlatformUser> {
    // GET from Slack's users.info API
    // Return normalized PlatformUser
  }

  async getUserByUsername(username: string): Promise<PlatformUser> {
    // Search for user by username
    // Return normalized PlatformUser
  }

  async getBotUser(): Promise<PlatformUser> {
    // Return cached bot user info
  }

  isUserAllowed(username: string): boolean {
    return this.allowedUsers.has(username);
  }

  // =========================================================================
  // Thread Operations
  // =========================================================================

  async getThreadHistory(threadId: string): Promise<PlatformPost[]> {
    // GET from Slack's conversations.replies API
    // Return array of normalized PlatformPosts
  }

  // =========================================================================
  // Files
  // =========================================================================

  async uploadFile(
    filename: string,
    content: Buffer,
    channelId: string
  ): Promise<string> {
    // POST to Slack's files.upload API
    // Return file URL
  }

  // =========================================================================
  // Typing Indicators
  // =========================================================================

  async setTyping(channelId: string, typing: boolean): Promise<void> {
    // Slack doesn't have a direct typing API
    // This can be a no-op or implemented via custom solution
  }

  // =========================================================================
  // Event Handling (from WebSocket)
  // =========================================================================

  private handleIncomingMessage(event: SlackMessage): void {
    // Convert to PlatformPost
    const post = this.normalizeMessage(event);
    const user = await this.getUser(event.user);

    // Emit for SessionManager
    this.emit('message', post, user);
  }

  private handleReactionAdded(event: SlackReactionEvent): void {
    const reaction: PlatformReaction = {
      userId: event.user,
      postId: event.item.ts,
      emojiName: event.reaction,
    };
    const user = await this.getUser(event.user);

    // Emit for SessionManager
    this.emit('reaction', reaction, user);
  }
}
```

### Step 3: Implement Formatter (`formatter.ts`)

Handle platform-specific markdown dialects:

```typescript
// src/platform/slack/formatter.ts
import type { PlatformFormatter } from '../formatter.js';

export class SlackFormatter implements PlatformFormatter {
  /**
   * Format code blocks for Slack
   */
  codeBlock(code: string, language?: string): string {
    // Slack uses triple backticks but doesn't support language hints
    return '```\n' + code + '\n```';
  }

  /**
   * Format inline code
   */
  inlineCode(code: string): string {
    return '`' + code + '`';
  }

  /**
   * Format a user mention
   */
  mention(userId: string): string {
    // Slack uses <@USER_ID> format
    return `<@${userId}>`;
  }

  /**
   * Format bold text
   */
  bold(text: string): string {
    return `*${text}*`;
  }

  /**
   * Format italic text
   */
  italic(text: string): string {
    return `_${text}_`;
  }

  /**
   * Format a link
   */
  link(url: string, text?: string): string {
    // Slack uses <URL|text> format
    return text ? `<${url}|${text}>` : `<${url}>`;
  }

  /**
   * Get max message length for this platform
   */
  get maxMessageLength(): number {
    return 40000; // Slack's limit
  }
}
```

### Step 4: Implement Permission API (`permission-api.ts`)

For the MCP permission server to communicate with this platform:

```typescript
// src/platform/slack/permission-api.ts
import type { PermissionApi } from '../permission-api.js';
import type { PlatformReaction, PlatformUser } from '../types.js';

export class SlackPermissionApi implements PermissionApi {
  private token: string;
  private baseUrl = 'https://slack.com/api';

  constructor(token: string) {
    this.token = token;
  }

  async createPost(message: string, threadId: string): Promise<{ id: string }> {
    // POST to chat.postMessage
    const response = await fetch(`${this.baseUrl}/chat.postMessage`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: threadId,
        text: message,
        thread_ts: threadId,
      }),
    });
    const data = await response.json();
    return { id: data.ts };
  }

  async addReaction(postId: string, channel: string, emoji: string): Promise<void> {
    // POST to reactions.add
  }

  async waitForReaction(
    postId: string,
    channel: string,
    allowedUsers: string[],
    timeoutMs: number
  ): Promise<PlatformReaction | null> {
    // Open WebSocket connection
    // Wait for reaction event on this post
    // Filter by allowed users
    // Return on match or timeout
  }

  async getUser(userId: string): Promise<PlatformUser> {
    // GET users.info
  }
}
```

### Step 5: Add Config Type

Update the configuration schema:

```typescript
// In src/config/migration.ts or config types file

export interface SlackPlatformConfig {
  id: string;
  type: 'slack';
  displayName?: string;
  token: string;        // Bot User OAuth Token
  channelId: string;    // Channel to listen in
  allowedUsers?: string[];
  skipPermissions?: boolean;
}

// Add to PlatformInstanceConfig union
export type PlatformInstanceConfig =
  | MattermostPlatformConfig
  | SlackPlatformConfig;
```

### Step 6: Register in Onboarding

Update `src/onboarding.ts` to support the new platform:

```typescript
// Add platform type choice
const platformType = await prompts({
  type: 'select',
  name: 'type',
  message: 'Platform type:',
  choices: [
    { title: 'Mattermost', value: 'mattermost' },
    { title: 'Slack', value: 'slack' },
  ],
});

// Add Slack-specific prompts when type === 'slack'
if (platformType.type === 'slack') {
  const slackConfig = await prompts([
    {
      type: 'password',
      name: 'token',
      message: 'Slack Bot Token (xoxb-...):',
    },
    {
      type: 'text',
      name: 'channelId',
      message: 'Channel ID:',
    },
  ]);
  // ...
}
```

## Required Interface Methods

Your `PlatformClient` implementation must include all these methods:

### Connection
- `connect(): Promise<void>`

### Messages
- `createPost(message: string, threadId?: string): Promise<PlatformPost>`
- `updatePost(postId: string, message: string): Promise<PlatformPost>`
- `deletePost(postId: string): Promise<void>`
- `getPost(postId: string): Promise<PlatformPost>`

### Reactions
- `addReaction(postId: string, emojiName: string): Promise<void>`
- `removeReaction(postId: string, emojiName: string): Promise<void>`

### Users
- `getUser(userId: string): Promise<PlatformUser>`
- `getUserByUsername(username: string): Promise<PlatformUser>`
- `getBotUser(): Promise<PlatformUser>`
- `isUserAllowed(username: string): boolean`

### Thread
- `getThreadHistory(threadId: string): Promise<PlatformPost[]>`

### Files
- `uploadFile(filename: string, content: Buffer, channelId: string): Promise<string>`

### Typing
- `setTyping(channelId: string, typing: boolean): Promise<void>`

### Properties
- `platformId: string` (read-only)
- `platformType: string` (read-only)
- `displayName: string` (read-only)
- `formatter: PlatformFormatter` (read-only)

### Events to Emit
- `'message'`: `(post: PlatformPost, user: PlatformUser) => void`
- `'reaction'`: `(reaction: PlatformReaction, user: PlatformUser) => void`
- `'channel_post'`: `() => void` (for sticky message bumping)

## Type Normalization

All platform-specific types must be converted to normalized types:

```typescript
// Convert Slack message to PlatformPost
function normalizeMessage(slack: SlackMessage): PlatformPost {
  return {
    id: slack.ts,
    platformId: this.platformId,
    channelId: slack.channel,
    userId: slack.user,
    message: slack.text,
    rootId: slack.thread_ts,
    createdAt: new Date(parseFloat(slack.ts) * 1000),
  };
}

// Convert Slack user to PlatformUser
function normalizeUser(slack: SlackUser): PlatformUser {
  return {
    id: slack.id,
    username: slack.name,
    displayName: slack.real_name,
  };
}
```

## Testing Your Implementation

1. **Unit tests**: Create `src/platform/slack/__tests__/` directory
2. **Integration tests**: Test with a real Slack workspace (sandbox)
3. **Manual testing**:
   - Start a session: `@bot help me with X`
   - Test reactions: 👍 👎 on approval prompts
   - Test commands: `!cd`, `!invite`, `!stop`
   - Test file uploads
   - Test thread context

## Common Pitfalls

1. **Rate limiting**: Implement exponential backoff for API calls
2. **Emoji names**: Different platforms use different emoji names (`:+1:` vs `+1`)
3. **Message length**: Check platform limits (Slack: 40k, Mattermost: 16k)
4. **Thread IDs**: Some platforms use different IDs for threads vs messages
5. **WebSocket reconnection**: Handle disconnects gracefully
6. **Bot user filtering**: Filter out bot's own messages to avoid loops

## Platform-Specific Considerations

### Slack
- Uses timestamp (`ts`) as message ID
- Threads are based on `thread_ts`
- Bot tokens start with `xoxb-`
- Socket Mode for WebSocket events

### Discord (future)
- Uses snowflake IDs
- Threads are separate channel types
- Requires Gateway for real-time events
- Different rate limits per route

### Microsoft Teams (future)
- Uses Azure AD authentication
- Activity IDs for messages
- Requires Bot Framework

## Need Help?

- Check existing implementations in `src/platform/mattermost/`
- Open an issue with questions
- See the main `CLAUDE.md` for architecture overview
