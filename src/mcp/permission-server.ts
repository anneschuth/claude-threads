#!/usr/bin/env node
/**
 * MCP Permission Server for Mattermost
 *
 * This server handles Claude Code's permission prompts by forwarding them to
 * Mattermost for user approval via emoji reactions.
 *
 * It is spawned by Claude Code when using --permission-prompt-tool and
 * communicates via stdio (MCP protocol).
 *
 * Approval options:
 *   - 👍 (+1) Allow this tool use
 *   - ✅ (white_check_mark) Allow all future tool uses in this session
 *   - 👎 (-1) Deny this tool use
 *
 * Environment variables (passed by mm-claude):
 *   - MATTERMOST_URL: Mattermost server URL
 *   - MATTERMOST_TOKEN: Bot access token
 *   - MATTERMOST_CHANNEL_ID: Channel to post permission requests
 *   - MM_THREAD_ID: Thread ID for the current session
 *   - ALLOWED_USERS: Comma-separated list of authorized usernames
 *   - DEBUG: Set to '1' for debug logging
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import WebSocket from 'ws';

// =============================================================================
// Configuration
// =============================================================================

const MM_URL = process.env.MATTERMOST_URL || '';
const MM_TOKEN = process.env.MATTERMOST_TOKEN || '';
const MM_CHANNEL_ID = process.env.MATTERMOST_CHANNEL_ID || '';
const MM_THREAD_ID = process.env.MM_THREAD_ID || '';
const ALLOWED_USERS = (process.env.ALLOWED_USERS || '')
  .split(',')
  .map(u => u.trim())
  .filter(u => u.length > 0);

const DEBUG = process.env.DEBUG === '1';
const PERMISSION_TIMEOUT_MS = 120000; // 2 minutes

// Session state
let allowAllSession = false;
let botUserId: string | null = null;

// =============================================================================
// Debug Logging
// =============================================================================

function debug(msg: string): void {
  if (DEBUG) console.error(`[MCP] ${msg}`);
}

// =============================================================================
// Mattermost API Helpers
// =============================================================================

interface MattermostPost {
  id: string;
  channel_id: string;
  message: string;
}

async function getBotUserId(): Promise<string> {
  if (botUserId) return botUserId;
  const response = await fetch(`${MM_URL}/api/v4/users/me`, {
    headers: { 'Authorization': `Bearer ${MM_TOKEN}` },
  });
  const me = await response.json();
  botUserId = me.id as string;
  return botUserId;
}

async function getUserById(userId: string): Promise<string | null> {
  try {
    const response = await fetch(`${MM_URL}/api/v4/users/${userId}`, {
      headers: { 'Authorization': `Bearer ${MM_TOKEN}` },
    });
    if (!response.ok) return null;
    const user = await response.json();
    return user.username || null;
  } catch {
    return null;
  }
}

function isUserAllowed(username: string): boolean {
  if (ALLOWED_USERS.length === 0) return true;
  return ALLOWED_USERS.includes(username);
}

async function createPost(message: string, rootId?: string): Promise<MattermostPost> {
  const response = await fetch(`${MM_URL}/api/v4/posts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MM_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel_id: MM_CHANNEL_ID,
      message,
      root_id: rootId || undefined,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create post: ${response.status}`);
  }

  return response.json();
}

async function addReaction(postId: string, emoji: string): Promise<void> {
  const userId = await getBotUserId();
  await fetch(`${MM_URL}/api/v4/reactions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MM_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      user_id: userId,
      post_id: postId,
      emoji_name: emoji,
    }),
  });
}

// =============================================================================
// Reaction Handling
// =============================================================================

function waitForReaction(postId: string): Promise<{ emoji: string; username: string }> {
  return new Promise((resolve, reject) => {
    const wsUrl = MM_URL.replace(/^http/, 'ws') + '/api/v4/websocket';
    debug(`Connecting to WebSocket: ${wsUrl}`);
    const ws = new WebSocket(wsUrl);

    const timeout = setTimeout(() => {
      debug(`Timeout waiting for reaction on ${postId}`);
      ws.close();
      reject(new Error('Permission request timed out'));
    }, PERMISSION_TIMEOUT_MS);

    ws.on('open', () => {
      debug(`WebSocket connected, authenticating...`);
      ws.send(JSON.stringify({
        seq: 1,
        action: 'authentication_challenge',
        data: { token: MM_TOKEN },
      }));
    });

    ws.on('message', async (data) => {
      try {
        const event = JSON.parse(data.toString());
        debug(`WS event: ${event.event || event.status || 'unknown'}`);

        if (event.event === 'reaction_added') {
          const reactionData = event.data;
          // Mattermost sends reaction as JSON string
          const reaction = typeof reactionData.reaction === 'string'
            ? JSON.parse(reactionData.reaction)
            : reactionData.reaction;

          debug(`Reaction on post ${reaction?.post_id}, looking for ${postId}`);

          if (reaction?.post_id === postId) {
            const userId = reaction.user_id;
            debug(`Reaction from user ${userId}, emoji: ${reaction.emoji_name}`);

            // Ignore bot's own reactions (from adding reaction options)
            const myId = await getBotUserId();
            if (userId === myId) {
              debug(`Ignoring bot's own reaction`);
              return;
            }

            // Check if user is authorized
            const username = await getUserById(userId);
            debug(`Username: ${username}, allowed: ${ALLOWED_USERS.join(',') || '(all)'}`);

            if (!username || !isUserAllowed(username)) {
              debug(`Ignoring unauthorized user: ${username || userId}`);
              return;
            }

            debug(`Accepting reaction ${reaction.emoji_name} from ${username}`);
            clearTimeout(timeout);
            ws.close();
            resolve({ emoji: reaction.emoji_name, username });
          }
        }
      } catch (e) {
        debug(`Parse error: ${e}`);
      }
    });

    ws.on('error', (err) => {
      debug(`WebSocket error: ${err}`);
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// =============================================================================
// Tool Formatting
// =============================================================================

function formatToolInfo(toolName: string, input: Record<string, unknown>): string {
  const short = (p: string) => {
    const home = process.env.HOME || '';
    return p?.startsWith(home) ? '~' + p.slice(home.length) : p;
  };

  switch (toolName) {
    case 'Read':
      return `📄 **Read** \`${short(input.file_path as string)}\``;
    case 'Write':
      return `📝 **Write** \`${short(input.file_path as string)}\``;
    case 'Edit':
      return `✏️ **Edit** \`${short(input.file_path as string)}\``;
    case 'Bash': {
      const cmd = (input.command as string || '').substring(0, 100);
      return `💻 **Bash** \`${cmd}${cmd.length >= 100 ? '...' : ''}\``;
    }
    default:
      if (toolName.startsWith('mcp__')) {
        const parts = toolName.split('__');
        return `🔌 **${parts.slice(2).join('__')}** *(${parts[1]})*`;
      }
      return `🔧 **${toolName}**`;
  }
}

// =============================================================================
// Permission Handler
// =============================================================================

interface PermissionResult {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}

async function handlePermission(
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<PermissionResult> {
  debug(`handlePermission called for ${toolName}`);

  // Auto-approve if "allow all" was selected earlier
  if (allowAllSession) {
    debug(`Auto-allowing ${toolName} (allow all active)`);
    return { behavior: 'allow', updatedInput: toolInput };
  }

  if (!MM_URL || !MM_TOKEN || !MM_CHANNEL_ID) {
    console.error('[MCP] Missing Mattermost config');
    return { behavior: 'deny', message: 'Permission service not configured' };
  }

  try {
    // Post permission request to Mattermost
    const toolInfo = formatToolInfo(toolName, toolInput);
    const message = `⚠️ **Permission requested**\n\n${toolInfo}\n\n` +
      `👍 Allow | ✅ Allow all | 👎 Deny`;

    const post = await createPost(message, MM_THREAD_ID || undefined);

    // Add reaction options for the user to click
    await addReaction(post.id, '+1');
    await addReaction(post.id, 'white_check_mark');
    await addReaction(post.id, '-1');

    // Wait for user's reaction
    const { emoji } = await waitForReaction(post.id);

    if (emoji === '+1' || emoji === 'thumbsup') {
      console.error(`[MCP] Allowed: ${toolName}`);
      return { behavior: 'allow', updatedInput: toolInput };
    } else if (emoji === 'white_check_mark' || emoji === 'heavy_check_mark') {
      allowAllSession = true;
      console.error(`[MCP] Allowed all: ${toolName}`);
      return { behavior: 'allow', updatedInput: toolInput };
    } else {
      console.error(`[MCP] Denied: ${toolName}`);
      return { behavior: 'deny', message: 'User denied permission' };
    }
  } catch (error) {
    console.error('[MCP] Permission error:', error);
    return { behavior: 'deny', message: String(error) };
  }
}

// =============================================================================
// MCP Server Setup
// =============================================================================

async function main() {
  const server = new McpServer({
    name: 'mm-claude-permissions',
    version: '1.0.0',
  });

  server.tool(
    'permission_prompt',
    'Handle permission requests via Mattermost reactions',
    {
      tool_name: z.string().describe('Name of the tool requesting permission'),
      input: z.record(z.string(), z.unknown()).describe('Tool input parameters'),
    },
    async ({ tool_name, input }) => {
      const result = await handlePermission(tool_name, input as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP] Permission server ready');
}

main().catch((err) => {
  console.error('[MCP] Fatal:', err);
  process.exit(1);
});
