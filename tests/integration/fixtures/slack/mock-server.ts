/**
 * Mock Slack Server for Integration Tests
 *
 * This mock server simulates Slack's APIs for testing without needing a real Slack workspace.
 * It provides:
 * - Socket Mode WebSocket endpoint for real-time events
 * - Web API endpoints for REST operations
 * - In-memory state management
 * - Methods to inject test data and trigger events
 *
 * Usage:
 *   const server = new SlackMockServer({ port: 3457 });
 *   await server.start();
 *   // ... run tests ...
 *   await server.stop();
 */

import type { Server, ServerWebSocket } from 'bun';
import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export interface SlackUser {
  id: string;
  team_id: string;
  name: string;
  real_name?: string;
  is_bot: boolean;
  is_admin?: boolean;
  profile?: {
    display_name?: string;
    email?: string;
    image_48?: string;
  };
}

export interface SlackChannel {
  id: string;
  name: string;
  is_channel: boolean;
  is_private: boolean;
  is_member: boolean;
  topic?: { value: string };
  purpose?: { value: string };
}

export interface SlackMessage {
  type: 'message';
  subtype?: string;
  ts: string;
  channel: string;
  user: string;
  text: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: SlackReaction[];
  edited?: { ts: string; user: string };
  files?: SlackFile[];
  blocks?: unknown[];
}

export interface SlackReaction {
  name: string;
  count: number;
  users: string[];
}

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private?: string;
}

export interface SlackPin {
  channel: string;
  message: SlackMessage;
  created: number;
  created_by: string;
}

export interface SlackTeam {
  id: string;
  name: string;
  domain: string;
}

export interface SocketModeEvent {
  envelope_id: string;
  type: 'events_api' | 'interactive' | 'slash_commands';
  accepts_response_payload?: boolean;
  payload: {
    type: string;
    event?: unknown;
    [key: string]: unknown;
  };
}

export interface SlackMockState {
  users: Map<string, SlackUser>;
  channels: Map<string, SlackChannel>;
  messages: Map<string, SlackMessage>; // key: channel:ts
  pins: Map<string, SlackPin>; // key: channel:ts
  team: SlackTeam;
  botUser: SlackUser;
  botToken: string;
  appToken: string;
}

export interface SlackMockServerOptions {
  port?: number;
  debug?: boolean;
}

// ============================================================================
// Default Test Data
// ============================================================================

function generateId(prefix: string): string {
  return `${prefix}${Date.now()}${Math.random().toString(36).substring(2, 8)}`;
}

// Counter to ensure unique timestamps even for rapid calls
let tsCounter = 0;

function generateTs(): string {
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  // Use milliseconds + counter for microsecond portion to ensure uniqueness
  const microseconds = ((now % 1000) * 1000) + (tsCounter++ % 1000);
  return `${seconds}.${microseconds.toString().padStart(6, '0')}`;
}

export function createDefaultTestData(): Omit<SlackMockState, 'messages' | 'pins'> {
  const teamId = 'T_TEST_TEAM';

  const botUser: SlackUser = {
    id: 'U_BOT_USER',
    team_id: teamId,
    name: 'claude-code',
    real_name: 'Claude Code Bot',
    is_bot: true,
    profile: {
      display_name: 'Claude Code',
    },
  };

  const testUser1: SlackUser = {
    id: 'U_TEST_USER1',
    team_id: teamId,
    name: 'testuser1',
    real_name: 'Test User 1',
    is_bot: false,
    is_admin: true,
    profile: {
      display_name: 'Test User 1',
      email: 'testuser1@test.local',
    },
  };

  const testUser2: SlackUser = {
    id: 'U_TEST_USER2',
    team_id: teamId,
    name: 'testuser2',
    real_name: 'Test User 2',
    is_bot: false,
    is_admin: false,
    profile: {
      display_name: 'Test User 2',
      email: 'testuser2@test.local',
    },
  };

  const testChannel: SlackChannel = {
    id: 'C_TEST_CHANNEL',
    name: 'test-channel',
    is_channel: true,
    is_private: false,
    is_member: true,
  };

  const users = new Map<string, SlackUser>();
  users.set(botUser.id, botUser);
  users.set(testUser1.id, testUser1);
  users.set(testUser2.id, testUser2);

  const channels = new Map<string, SlackChannel>();
  channels.set(testChannel.id, testChannel);

  const team: SlackTeam = {
    id: teamId,
    name: 'Test Team',
    domain: 'test-team',
  };

  return {
    users,
    channels,
    team,
    botUser,
    botToken: 'xoxb-test-bot-token',
    appToken: 'xapp-test-app-token',
  };
}

// ============================================================================
// Slack Mock Server
// ============================================================================

export class SlackMockServer extends EventEmitter {
  private server: Server<unknown> | null = null;
  private wsConnections: Set<ServerWebSocket<unknown>> = new Set();
  private state: SlackMockState;
  private port: number;
  private debug: boolean;
  private envelopeCounter = 0;

  constructor(options: SlackMockServerOptions = {}) {
    super();
    this.port = options.port ?? 3457;
    this.debug = options.debug ?? false;

    const defaultData = createDefaultTestData();
    this.state = {
      ...defaultData,
      messages: new Map(),
      pins: new Map(),
    };
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async start(): Promise<void> {
    if (this.server) {
      throw new Error('Server is already running');
    }

    this.server = Bun.serve({
      port: this.port,
      fetch: (req, server) => this.handleRequest(req, server),
      websocket: {
        open: (ws) => this.handleWsOpen(ws),
        message: (ws, message) => this.handleWsMessage(ws, message),
        close: (ws) => this.handleWsClose(ws),
      },
    });

    this.log(`Slack mock server started on port ${this.port}`);
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    // Close all WebSocket connections
    for (const ws of this.wsConnections) {
      ws.close(1000, 'Server shutting down');
    }
    this.wsConnections.clear();

    this.server.stop();
    this.server = null;

    this.log('Slack mock server stopped');
  }

  reset(): void {
    const defaultData = createDefaultTestData();
    this.state = {
      ...defaultData,
      messages: new Map(),
      pins: new Map(),
    };
    this.envelopeCounter = 0;
    this.log('State reset to defaults');
  }

  // ============================================================================
  // State Access
  // ============================================================================

  getState(): SlackMockState {
    return this.state;
  }

  getUrl(): string {
    return `http://localhost:${this.port}`;
  }

  getWsUrl(): string {
    return `ws://localhost:${this.port}/socket-mode`;
  }

  getBotToken(): string {
    return this.state.botToken;
  }

  getAppToken(): string {
    return this.state.appToken;
  }

  getBotUser(): SlackUser {
    return this.state.botUser;
  }

  getChannelId(): string {
    const channel = Array.from(this.state.channels.values())[0];
    return channel?.id ?? 'C_TEST_CHANNEL';
  }

  // ============================================================================
  // State Manipulation (for test setup)
  // ============================================================================

  addUser(user: SlackUser): void {
    this.state.users.set(user.id, user);
  }

  addChannel(channel: SlackChannel): void {
    this.state.channels.set(channel.id, channel);
  }

  /**
   * Inject a message directly into state (for test setup)
   */
  injectMessage(message: SlackMessage): void {
    const key = `${message.channel}:${message.ts}`;
    this.state.messages.set(key, message);
  }

  /**
   * Get all messages in a channel
   */
  getChannelMessages(channelId: string): SlackMessage[] {
    const messages: SlackMessage[] = [];
    for (const [key, msg] of this.state.messages) {
      if (key.startsWith(`${channelId}:`)) {
        messages.push(msg);
      }
    }
    return messages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
  }

  /**
   * Get all messages in a thread
   */
  getThreadMessages(channelId: string, threadTs: string): SlackMessage[] {
    const messages: SlackMessage[] = [];
    for (const [key, msg] of this.state.messages) {
      if (key.startsWith(`${channelId}:`) && msg.thread_ts === threadTs) {
        messages.push(msg);
      }
    }
    // Also include the parent message
    const parentKey = `${channelId}:${threadTs}`;
    const parent = this.state.messages.get(parentKey);
    if (parent && !messages.find((m) => m.ts === parent.ts)) {
      messages.unshift(parent);
    }
    return messages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
  }

  /**
   * Get a specific message
   */
  getMessage(channelId: string, ts: string): SlackMessage | undefined {
    return this.state.messages.get(`${channelId}:${ts}`);
  }

  // ============================================================================
  // Socket Mode Event Triggering
  // ============================================================================

  /**
   * Send a Socket Mode event to all connected clients
   */
  sendSocketModeEvent(event: Omit<SocketModeEvent, 'envelope_id'>): void {
    const envelope: SocketModeEvent = {
      ...event,
      envelope_id: `envelope_${++this.envelopeCounter}`,
    };

    const data = JSON.stringify(envelope);
    for (const ws of this.wsConnections) {
      ws.send(data);
    }

    this.log(`Sent Socket Mode event: ${event.type}`);
  }

  /**
   * Simulate a message being posted (triggers Socket Mode event)
   */
  simulateMessageEvent(
    channelId: string,
    userId: string,
    text: string,
    threadTs?: string,
  ): SlackMessage {
    const message: SlackMessage = {
      type: 'message',
      ts: generateTs(),
      channel: channelId,
      user: userId,
      text,
      thread_ts: threadTs,
    };

    // Store the message
    this.injectMessage(message);

    // Send Socket Mode event
    this.sendSocketModeEvent({
      type: 'events_api',
      accepts_response_payload: false,
      payload: {
        type: 'event_callback',
        event: {
          ...message,
        },
      },
    });

    return message;
  }

  /**
   * Simulate a reaction being added (triggers Socket Mode event)
   */
  simulateReactionAdded(
    userId: string,
    channelId: string,
    messageTs: string,
    reaction: string,
  ): void {
    // Update message state
    const key = `${channelId}:${messageTs}`;
    const message = this.state.messages.get(key);
    if (message) {
      message.reactions = message.reactions || [];
      const existing = message.reactions.find((r) => r.name === reaction);
      if (existing) {
        if (!existing.users.includes(userId)) {
          existing.users.push(userId);
          existing.count++;
        }
      } else {
        message.reactions.push({ name: reaction, count: 1, users: [userId] });
      }
    }

    // Send Socket Mode event
    this.sendSocketModeEvent({
      type: 'events_api',
      accepts_response_payload: false,
      payload: {
        type: 'event_callback',
        event: {
          type: 'reaction_added',
          user: userId,
          reaction,
          item: {
            type: 'message',
            channel: channelId,
            ts: messageTs,
          },
          event_ts: generateTs(),
        },
      },
    });
  }

  /**
   * Simulate a reaction being removed (triggers Socket Mode event)
   */
  simulateReactionRemoved(
    userId: string,
    channelId: string,
    messageTs: string,
    reaction: string,
  ): void {
    // Update message state
    const key = `${channelId}:${messageTs}`;
    const message = this.state.messages.get(key);
    if (message?.reactions) {
      const existing = message.reactions.find((r) => r.name === reaction);
      if (existing) {
        existing.users = existing.users.filter((u) => u !== userId);
        existing.count = existing.users.length;
        if (existing.count === 0) {
          message.reactions = message.reactions.filter((r) => r.name !== reaction);
        }
      }
    }

    // Send Socket Mode event
    this.sendSocketModeEvent({
      type: 'events_api',
      accepts_response_payload: false,
      payload: {
        type: 'event_callback',
        event: {
          type: 'reaction_removed',
          user: userId,
          reaction,
          item: {
            type: 'message',
            channel: channelId,
            ts: messageTs,
          },
          event_ts: generateTs(),
        },
      },
    });
  }

  // ============================================================================
  // HTTP Request Handling
  // ============================================================================

  private async handleRequest(req: Request, server: Server<unknown>): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    this.log(`${req.method} ${path}`);

    // WebSocket upgrade for Socket Mode
    if (path === '/socket-mode') {
      const upgraded = server.upgrade(req, { data: {} });
      if (!upgraded) {
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      return new Response();
    }

    // Auth check for API endpoints (except api.test which doesn't require auth)
    if (path.startsWith('/api/') && path !== '/api/api.test') {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return this.jsonResponse({ ok: false, error: 'not_authed' }, 401);
      }

      const token = authHeader.substring(7);
      // apps.connections.open uses app token (xapp-...), other endpoints use bot token (xoxb-...)
      const validToken = path === '/api/apps.connections.open'
        ? token === this.state.appToken
        : token === this.state.botToken;

      if (!validToken) {
        return this.jsonResponse({ ok: false, error: 'invalid_auth' }, 401);
      }
    }

    // Route API endpoints
    try {
      const body = req.method === 'POST' ? await this.parseBody(req) : {};

      switch (path) {
        // Test
        case '/api/api.test':
          return this.jsonResponse({ ok: true });

        // Auth
        case '/api/apps.connections.open':
          return this.handleAppsConnectionsOpen();
        case '/api/auth.test':
          return this.handleAuthTest();

        // Chat
        case '/api/chat.postMessage':
          return this.handleChatPostMessage(body);
        case '/api/chat.update':
          return this.handleChatUpdate(body);
        case '/api/chat.delete':
          return this.handleChatDelete(body);

        // Conversations
        case '/api/conversations.replies':
          return this.handleConversationsReplies(url.searchParams, body);
        case '/api/conversations.history':
          return this.handleConversationsHistory(url.searchParams, body);
        case '/api/conversations.info':
          return this.handleConversationsInfo(url.searchParams, body);

        // Reactions
        case '/api/reactions.add':
          return this.handleReactionsAdd(body);
        case '/api/reactions.remove':
          return this.handleReactionsRemove(body);
        case '/api/reactions.get':
          return this.handleReactionsGet(url.searchParams, body);

        // Users
        case '/api/users.info':
          return this.handleUsersInfo(url.searchParams, body);
        case '/api/users.list':
          return this.handleUsersList();

        // Pins
        case '/api/pins.add':
          return this.handlePinsAdd(body);
        case '/api/pins.remove':
          return this.handlePinsRemove(body);
        case '/api/pins.list':
          return this.handlePinsList(url.searchParams, body);

        default:
          this.log(`Unhandled endpoint: ${path}`);
          return this.jsonResponse({ ok: false, error: 'unknown_method' }, 404);
      }
    } catch (error) {
      this.log(`Error handling request: ${error}`);
      return this.jsonResponse({ ok: false, error: 'internal_error' }, 500);
    }
  }

  private async parseBody(req: Request): Promise<Record<string, unknown>> {
    const contentType = req.headers.get('Content-Type') || '';

    if (contentType.includes('application/json')) {
      // Handle empty body
      const text = await req.text();
      if (!text || text.trim() === '') {
        return {};
      }
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        return {};
      }
    }

    if (contentType.includes('application/x-www-form-urlencoded')) {
      const text = await req.text();
      const params = new URLSearchParams(text);
      const result: Record<string, string> = {};
      for (const [key, value] of params) {
        result[key] = value;
      }
      return result;
    }

    return {};
  }

  private jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ============================================================================
  // API Endpoint Handlers
  // ============================================================================

  private handleAppsConnectionsOpen(): Response {
    return this.jsonResponse({
      ok: true,
      url: this.getWsUrl(),
    });
  }

  private handleAuthTest(): Response {
    return this.jsonResponse({
      ok: true,
      url: this.getUrl(),
      team: this.state.team.name,
      user: this.state.botUser.name,
      team_id: this.state.team.id,
      user_id: this.state.botUser.id,
      bot_id: `B${this.state.botUser.id.substring(1)}`,
      is_enterprise_install: false,
    });
  }

  private handleChatPostMessage(body: Record<string, unknown>): Response {
    const channel = body.channel as string;
    const text = body.text as string;
    const threadTs = body.thread_ts as string | undefined;
    const blocks = body.blocks as unknown[] | undefined;
    // Test-only: allow specifying user for test posts (not part of real Slack API)
    const asUser = body._test_user_id as string | undefined;
    // Test-only: emit Socket Mode event for this message (for bot to receive)
    const emitEvent = body._test_emit_event as boolean | undefined;

    if (!channel || !text) {
      return this.jsonResponse({ ok: false, error: 'invalid_arguments' }, 400);
    }

    const ts = generateTs();
    const message: SlackMessage = {
      type: 'message',
      ts,
      channel,
      user: asUser || this.state.botUser.id,
      text,
      thread_ts: threadTs,
      blocks,
    };

    this.state.messages.set(`${channel}:${ts}`, message);

    // Emit Socket Mode event if requested (for test user messages)
    // This allows tests to create posts that the bot will receive
    if (emitEvent && asUser && asUser !== this.state.botUser.id) {
      this.sendSocketModeEvent({
        type: 'events_api',
        accepts_response_payload: false,
        payload: {
          type: 'event_callback',
          event: {
            ...message,
          },
        },
      });
    }

    return this.jsonResponse({
      ok: true,
      channel,
      ts,
      message,
    });
  }

  private handleChatUpdate(body: Record<string, unknown>): Response {
    const channel = body.channel as string;
    const ts = body.ts as string;
    const text = body.text as string;

    if (!channel || !ts || !text) {
      return this.jsonResponse({ ok: false, error: 'invalid_arguments' }, 400);
    }

    const key = `${channel}:${ts}`;
    const message = this.state.messages.get(key);

    if (!message) {
      return this.jsonResponse({ ok: false, error: 'message_not_found' }, 404);
    }

    message.text = text;
    message.edited = {
      ts: generateTs(),
      user: this.state.botUser.id,
    };

    return this.jsonResponse({
      ok: true,
      channel,
      ts,
      text,
    });
  }

  private handleChatDelete(body: Record<string, unknown>): Response {
    const channel = body.channel as string;
    const ts = body.ts as string;

    if (!channel || !ts) {
      return this.jsonResponse({ ok: false, error: 'invalid_arguments' }, 400);
    }

    const key = `${channel}:${ts}`;
    if (!this.state.messages.has(key)) {
      return this.jsonResponse({ ok: false, error: 'message_not_found' }, 404);
    }

    this.state.messages.delete(key);

    return this.jsonResponse({
      ok: true,
      channel,
      ts,
    });
  }

  private handleConversationsReplies(
    params: URLSearchParams,
    body: Record<string, unknown>,
  ): Response {
    const channel = (params.get('channel') || body.channel) as string;
    const ts = (params.get('ts') || body.ts) as string;
    const limit = parseInt((params.get('limit') || body.limit || '100') as string, 10);

    if (!channel || !ts) {
      return this.jsonResponse({ ok: false, error: 'invalid_arguments' }, 400);
    }

    const messages = this.getThreadMessages(channel, ts).slice(0, limit);

    return this.jsonResponse({
      ok: true,
      messages,
      has_more: false,
    });
  }

  private handleConversationsHistory(
    params: URLSearchParams,
    body: Record<string, unknown>,
  ): Response {
    const channel = (params.get('channel') || body.channel) as string;
    const limit = parseInt((params.get('limit') || body.limit || '100') as string, 10);
    const latest = (params.get('latest') || body.latest) as string | undefined;
    const oldest = (params.get('oldest') || body.oldest) as string | undefined;
    const inclusive = (params.get('inclusive') || body.inclusive) === 'true';

    if (!channel) {
      return this.jsonResponse({ ok: false, error: 'invalid_arguments' }, 400);
    }

    // Get all messages in channel
    let messages = this.getChannelMessages(channel);

    // Filter by timestamp range if specified
    if (oldest || latest) {
      messages = messages.filter((m) => {
        // Use string comparison for timestamps to preserve precision
        if (oldest && inclusive && m.ts < oldest) return false;
        if (oldest && !inclusive && m.ts <= oldest) return false;
        if (latest && inclusive && m.ts > latest) return false;
        if (latest && !inclusive && m.ts >= latest) return false;
        return true;
      });
    }

    // Apply limit and reverse (most recent first)
    messages = messages.slice(-limit).reverse();

    return this.jsonResponse({
      ok: true,
      messages,
      has_more: false,
    });
  }

  private handleConversationsInfo(
    params: URLSearchParams,
    body: Record<string, unknown>,
  ): Response {
    const channelId = (params.get('channel') || body.channel) as string;

    if (!channelId) {
      return this.jsonResponse({ ok: false, error: 'invalid_arguments' }, 400);
    }

    const channel = this.state.channels.get(channelId);
    if (!channel) {
      return this.jsonResponse({ ok: false, error: 'channel_not_found' }, 404);
    }

    return this.jsonResponse({
      ok: true,
      channel,
    });
  }

  private handleReactionsAdd(body: Record<string, unknown>): Response {
    const channel = body.channel as string;
    const timestamp = body.timestamp as string;
    const name = body.name as string;
    // Test-only: allow specifying user for test reactions (not part of real Slack API)
    const asUser = body._test_user_id as string | undefined;
    // Test-only: emit Socket Mode event for this reaction (for bot to receive)
    const emitEvent = body._test_emit_event as boolean | undefined;
    const userId = asUser || this.state.botUser.id;

    if (!channel || !timestamp || !name) {
      return this.jsonResponse({ ok: false, error: 'invalid_arguments' }, 400);
    }

    const key = `${channel}:${timestamp}`;
    const message = this.state.messages.get(key);

    if (!message) {
      return this.jsonResponse({ ok: false, error: 'message_not_found' }, 404);
    }

    message.reactions = message.reactions || [];
    const existing = message.reactions.find((r) => r.name === name);

    if (existing) {
      if (!existing.users.includes(userId)) {
        existing.users.push(userId);
        existing.count++;
      }
    } else {
      message.reactions.push({
        name,
        count: 1,
        users: [userId],
      });
    }

    // Emit Socket Mode event if requested (for test user reactions)
    // This allows tests to trigger reaction events that the bot will receive
    if (emitEvent && userId !== this.state.botUser.id) {
      this.sendSocketModeEvent({
        type: 'events_api',
        accepts_response_payload: false,
        payload: {
          type: 'event_callback',
          event: {
            type: 'reaction_added',
            user: userId,
            reaction: name,
            item: {
              type: 'message',
              channel,
              ts: timestamp,
            },
            event_ts: generateTs(),
          },
        },
      });
    }

    return this.jsonResponse({ ok: true });
  }

  private handleReactionsRemove(body: Record<string, unknown>): Response {
    const channel = body.channel as string;
    const timestamp = body.timestamp as string;
    const name = body.name as string;
    // Test-only: allow specifying user for test reactions (not part of real Slack API)
    const asUser = body._test_user_id as string | undefined;
    const emitEvent = body._test_emit_event as boolean | undefined;
    const userId = asUser || this.state.botUser.id;

    if (!channel || !timestamp || !name) {
      return this.jsonResponse({ ok: false, error: 'invalid_arguments' }, 400);
    }

    const key = `${channel}:${timestamp}`;
    const message = this.state.messages.get(key);

    if (!message?.reactions) {
      return this.jsonResponse({ ok: false, error: 'no_reaction' }, 404);
    }

    const existing = message.reactions.find((r) => r.name === name);
    if (!existing) {
      return this.jsonResponse({ ok: false, error: 'no_reaction' }, 404);
    }

    existing.users = existing.users.filter((u) => u !== userId);
    existing.count = existing.users.length;

    if (existing.count === 0) {
      message.reactions = message.reactions.filter((r) => r.name !== name);
    }

    // Emit Socket Mode event if requested (for test user reactions)
    if (emitEvent && userId !== this.state.botUser.id) {
      this.sendSocketModeEvent({
        type: 'events_api',
        accepts_response_payload: false,
        payload: {
          type: 'event_callback',
          event: {
            type: 'reaction_removed',
            user: userId,
            reaction: name,
            item: {
              type: 'message',
              channel,
              ts: timestamp,
            },
            event_ts: generateTs(),
          },
        },
      });
    }

    return this.jsonResponse({ ok: true });
  }

  private handleReactionsGet(
    params: URLSearchParams,
    body: Record<string, unknown>,
  ): Response {
    const channel = (params.get('channel') || body.channel) as string;
    const timestamp = (params.get('timestamp') || body.timestamp) as string;

    if (!channel || !timestamp) {
      return this.jsonResponse({ ok: false, error: 'invalid_arguments' }, 400);
    }

    const key = `${channel}:${timestamp}`;
    const message = this.state.messages.get(key);

    if (!message) {
      return this.jsonResponse({ ok: false, error: 'message_not_found' }, 404);
    }

    return this.jsonResponse({
      ok: true,
      type: 'message',
      channel,
      message: {
        ...message,
        reactions: message.reactions || [],
      },
    });
  }

  private handleUsersInfo(
    params: URLSearchParams,
    body: Record<string, unknown>,
  ): Response {
    const userId = (params.get('user') || body.user) as string;

    if (!userId) {
      return this.jsonResponse({ ok: false, error: 'invalid_arguments' }, 400);
    }

    const user = this.state.users.get(userId);
    if (!user) {
      return this.jsonResponse({ ok: false, error: 'user_not_found' }, 404);
    }

    return this.jsonResponse({
      ok: true,
      user,
    });
  }

  private handleUsersList(): Response {
    const members = Array.from(this.state.users.values());

    return this.jsonResponse({
      ok: true,
      members,
      cache_ts: Math.floor(Date.now() / 1000),
    });
  }

  private handlePinsAdd(body: Record<string, unknown>): Response {
    const channel = body.channel as string;
    const timestamp = body.timestamp as string;

    if (!channel || !timestamp) {
      return this.jsonResponse({ ok: false, error: 'invalid_arguments' }, 400);
    }

    const key = `${channel}:${timestamp}`;
    const message = this.state.messages.get(key);

    if (!message) {
      return this.jsonResponse({ ok: false, error: 'message_not_found' }, 404);
    }

    this.state.pins.set(key, {
      channel,
      message,
      created: Math.floor(Date.now() / 1000),
      created_by: this.state.botUser.id,
    });

    return this.jsonResponse({ ok: true });
  }

  private handlePinsRemove(body: Record<string, unknown>): Response {
    const channel = body.channel as string;
    const timestamp = body.timestamp as string;

    if (!channel || !timestamp) {
      return this.jsonResponse({ ok: false, error: 'invalid_arguments' }, 400);
    }

    const key = `${channel}:${timestamp}`;
    if (!this.state.pins.has(key)) {
      return this.jsonResponse({ ok: false, error: 'no_pin' }, 404);
    }

    this.state.pins.delete(key);

    return this.jsonResponse({ ok: true });
  }

  private handlePinsList(
    params: URLSearchParams,
    body: Record<string, unknown>,
  ): Response {
    const channel = (params.get('channel') || body.channel) as string;

    if (!channel) {
      return this.jsonResponse({ ok: false, error: 'invalid_arguments' }, 400);
    }

    const items = Array.from(this.state.pins.values())
      .filter((pin) => pin.channel === channel)
      .map((pin) => ({
        type: 'message',
        channel: pin.channel,
        message: pin.message,
        created: pin.created,
        created_by: pin.created_by,
      }));

    return this.jsonResponse({
      ok: true,
      items,
    });
  }

  // ============================================================================
  // WebSocket Handling
  // ============================================================================

  private handleWsOpen(ws: ServerWebSocket<unknown>): void {
    this.wsConnections.add(ws);
    this.log('Socket Mode connection opened');

    // Send hello event
    ws.send(
      JSON.stringify({
        type: 'hello',
        num_connections: this.wsConnections.size,
        debug_info: {
          host: `localhost:${this.port}`,
          started: new Date().toISOString(),
        },
        connection_info: {
          app_id: 'A_TEST_APP',
        },
      }),
    );
  }

  private handleWsMessage(ws: ServerWebSocket<unknown>, message: string | Buffer): void {
    try {
      const data = JSON.parse(message.toString());
      this.log(`Socket Mode received: ${JSON.stringify(data)}`);

      // Handle acknowledgments
      if (data.envelope_id) {
        this.emit('envelope_ack', data.envelope_id);
      }
    } catch (error) {
      this.log(`Error parsing WebSocket message: ${error}`);
    }
  }

  private handleWsClose(ws: ServerWebSocket<unknown>): void {
    this.wsConnections.delete(ws);
    this.log('Socket Mode connection closed');
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  private log(message: string): void {
    if (this.debug) {
      console.error(`[slack-mock] ${message}`);
    }
  }
}

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a test user for injection
 */
export function createTestUser(overrides: Partial<SlackUser> = {}): SlackUser {
  const id = overrides.id || generateId('U');
  return {
    id,
    team_id: 'T_TEST_TEAM',
    name: `user_${id.toLowerCase()}`,
    real_name: `Test User ${id}`,
    is_bot: false,
    profile: {
      display_name: `Test User ${id}`,
    },
    ...overrides,
  };
}

/**
 * Create a test message for injection
 */
export function createTestMessage(
  channelId: string,
  userId: string,
  text: string,
  overrides: Partial<SlackMessage> = {},
): SlackMessage {
  return {
    type: 'message',
    ts: generateTs(),
    channel: channelId,
    user: userId,
    text,
    ...overrides,
  };
}

/**
 * Wait for a Socket Mode connection to be established
 */
export async function waitForSocketModeConnection(
  server: SlackMockServer,
  timeout = 5000,
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (server.getState().users.size > 0) {
      // Server is ready
      await new Promise((r) => setTimeout(r, 100));
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  throw new Error('Timeout waiting for Socket Mode connection');
}

// ============================================================================
// CLI Entry Point
// ============================================================================

/**
 * Run the mock server as a standalone process
 * Usage: bun run mock-server.ts
 * Environment: SLACK_MOCK_PORT (default: 3457), DEBUG (set to 1 for logging)
 */
async function main() {
  const port = parseInt(process.env.SLACK_MOCK_PORT || '3457', 10);
  const debug = process.env.DEBUG === '1';

  const server = new SlackMockServer({ port, debug });
  await server.start();

  console.log(`Slack mock server started on port ${port}`);
  console.log(`  API URL: http://localhost:${port}`);
  console.log(`  WebSocket URL: ws://localhost:${port}/socket-mode`);
  console.log(`  Bot Token: ${server.getBotToken()}`);
  console.log(`  App Token: ${server.getAppToken()}`);
  console.log(`  Channel ID: ${server.getChannelId()}`);
  console.log('');
  console.log('Press Ctrl+C to stop the server...');

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('Shutting down Slack mock server...');
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('Shutting down Slack mock server...');
    await server.stop();
    process.exit(0);
  });
}

// Run if this is the main module
if (import.meta.main) {
  main().catch((err) => {
    console.error('Failed to start mock server:', err);
    process.exit(1);
  });
}
