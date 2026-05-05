#!/usr/bin/env node
/**
 * MCP Permission Server
 *
 * This server handles Claude Code's permission prompts by forwarding them to
 * the chat platform for user approval via emoji reactions.
 *
 * Platform-agnostic design: Uses PermissionApi interface with platform-specific
 * implementations selected based on PLATFORM_TYPE environment variable.
 *
 * It is spawned by Claude Code when using --permission-prompt-tool and
 * communicates via stdio (MCP protocol).
 *
 * Approval options:
 *   - 👍 (+1) Allow this tool use
 *   - ✅ (white_check_mark) Allow all future tool uses in this session
 *   - 👎 (-1) Deny this tool use
 *
 * Environment variables (passed by claude-threads):
 *   - PLATFORM_TYPE: Platform type ('mattermost' or 'slack')
 *   - PLATFORM_URL: Platform server URL
 *   - PLATFORM_TOKEN: Bot access token
 *   - PLATFORM_CHANNEL_ID: Channel to post permission requests
 *   - PLATFORM_THREAD_ID: Thread ID for the current session
 *   - ALLOWED_USERS: Comma-separated list of authorized usernames
 *   - DEBUG: Set to '1' for debug logging
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { isApprovalEmoji, isAllowAllEmoji, APPROVAL_EMOJIS, ALLOW_ALL_EMOJIS, DENIAL_EMOJIS } from '../utils/emoji.js';
import { formatToolForPermission } from '../operations/index.js';
import { mcpLogger } from '../utils/logger.js';
import type { PermissionApi, MattermostPermissionApiConfig, SlackPermissionApiConfig } from '../platform/permission-api.js';
import { createPermissionApi } from '../platform/permission-api-factory.js';
import { validateOutboundPath } from './path-validator.js';

// =============================================================================
// Configuration
// =============================================================================

const PLATFORM_TYPE = process.env.PLATFORM_TYPE || '';
const PLATFORM_URL = process.env.PLATFORM_URL || '';
const PLATFORM_TOKEN = process.env.PLATFORM_TOKEN || '';
const PLATFORM_CHANNEL_ID = process.env.PLATFORM_CHANNEL_ID || '';
const PLATFORM_THREAD_ID = process.env.PLATFORM_THREAD_ID || '';
const ALLOWED_USERS = (process.env.ALLOWED_USERS || '')
  .split(',')
  .map(u => u.trim())
  .filter(u => u.length > 0);

const PERMISSION_TIMEOUT_MS = parseInt(process.env.PERMISSION_TIMEOUT_MS || '120000', 10);

// Outbound-file (`send_file`) configuration. Populated by the bot at spawn
// time via buildPermissionArgs. Empty roots → outbound disabled regardless
// of OUTBOUND_FILES_ENABLED, since we'd have nothing to validate against.
const SESSION_WORKING_DIR = process.env.SESSION_WORKING_DIR || '';
const SESSION_UPLOAD_DIR = process.env.SESSION_UPLOAD_DIR || '';
const OUTBOUND_FILES_ENABLED = (process.env.OUTBOUND_FILES_ENABLED ?? '1') !== '0';
const OUTBOUND_FILES_MAX_BYTES = parseInt(
  process.env.OUTBOUND_FILES_MAX_BYTES || String(100 * 1024 * 1024),
  10,
);

const SEND_FILE_TOOL_NAME = 'mcp__claude-threads-permissions__send_file';

// =============================================================================
// Permission API Instance
// =============================================================================
const apiConfig: MattermostPermissionApiConfig | SlackPermissionApiConfig =
  PLATFORM_TYPE === 'slack'
    ? {
        platformType: 'slack',
        botToken: PLATFORM_TOKEN,
        appToken: process.env.PLATFORM_APP_TOKEN || '',
        channelId: PLATFORM_CHANNEL_ID,
        threadTs: PLATFORM_THREAD_ID || undefined,
        allowedUsers: ALLOWED_USERS,
        debug: process.env.DEBUG === '1',
      }
    : {
        platformType: 'mattermost',
        url: PLATFORM_URL,
        token: PLATFORM_TOKEN,
        channelId: PLATFORM_CHANNEL_ID,
        threadId: PLATFORM_THREAD_ID || undefined,
        allowedUsers: ALLOWED_USERS,
        debug: process.env.DEBUG === '1',
      };

let permissionApi: PermissionApi | null = null;

function getApi(): PermissionApi {
  if (!permissionApi) {
    permissionApi = createPermissionApi(PLATFORM_TYPE, apiConfig);
  }
  return permissionApi;
}

// Session state
let allowAllSession = false;

// =============================================================================
// Permission Handler
// =============================================================================

export interface PermissionResult {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}

/**
 * Runtime configuration for the permission handler. Passed explicitly so the
 * handler can be tested without module-level env state.
 */
export interface PermissionHandlerConfig {
  api: PermissionApi;
  threadId?: string;
  timeoutMs: number;
  platformConfigured: boolean;
  getAllowAll: () => boolean;
  setAllowAll: (value: boolean) => void;
  now?: () => number;
}

/**
 * Pure(-ish) permission handler — exported for testing. Side effects flow
 * through the injected `api` and `get/setAllowAll` callbacks.
 */
export async function handlePermissionWith(
  toolName: string,
  toolInput: Record<string, unknown>,
  cfg: PermissionHandlerConfig
): Promise<PermissionResult> {
  mcpLogger.debug(`handlePermission called for ${toolName}`);

  // Auto-approve send_file: it has its own path-validation gate inside the
  // tool handler, and asking the user to react 👍 to every screenshot the
  // model sends defeats the entire point of the feature.
  if (toolName === SEND_FILE_TOOL_NAME) {
    mcpLogger.debug(`Auto-allowing ${toolName} (path validator is the real gate)`);
    return { behavior: 'allow', updatedInput: toolInput };
  }

  // Auto-approve if "allow all" was selected earlier
  if (cfg.getAllowAll()) {
    mcpLogger.debug(`Auto-allowing ${toolName} (allow all active)`);
    return { behavior: 'allow', updatedInput: toolInput };
  }

  if (!cfg.platformConfigured) {
    mcpLogger.error('Missing platform config');
    return { behavior: 'deny', message: 'Permission service not configured' };
  }

  const now = cfg.now ?? Date.now;

  try {
    const api = cfg.api;
    const formatter = api.getFormatter();

    // Post permission request with reaction options
    const toolInfo = formatToolForPermission(toolName, toolInput, formatter);
    const message = `⚠️ ${formatter.formatBold('Permission requested')}\n\n${toolInfo}\n\n` +
      `👍 Allow | ✅ Allow all | 👎 Deny`;

    const botUserId = await api.getBotUserId();
    const post = await api.createInteractivePost(
      message,
      [APPROVAL_EMOJIS[0], ALLOW_ALL_EMOJIS[0], DENIAL_EMOJIS[0]],
      cfg.threadId
    );

    // Wait for authorized user's reaction (keep waiting if unauthorized users react)
    const startTime = now();
    let reaction: Awaited<ReturnType<typeof api.waitForReaction>>;
    let username: string | null = null;

    while (true) {
      const remainingTime = cfg.timeoutMs - (now() - startTime);
      if (remainingTime <= 0) {
        await api.updatePost(post.id, `⏱️ ${formatter.formatBold('Timed out')} - permission denied\n\n${toolInfo}`);
        mcpLogger.info(`Timeout: ${toolName}`);
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      reaction = await api.waitForReaction(post.id, botUserId, remainingTime);

      if (!reaction) {
        await api.updatePost(post.id, `⏱️ ${formatter.formatBold('Timed out')} - permission denied\n\n${toolInfo}`);
        mcpLogger.info(`Timeout: ${toolName}`);
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      // Get username and check if allowed
      username = await api.getUsername(reaction.userId);
      if (username && api.isUserAllowed(username)) {
        break; // Authorized user - process their reaction
      }

      // Unauthorized user - log and keep waiting
      mcpLogger.debug(`Ignoring unauthorized user: ${username || reaction.userId}, waiting for authorized user`);
    }

    const emoji = reaction.emojiName;
    mcpLogger.debug(`Reaction ${emoji} from ${username}`);

    if (isApprovalEmoji(emoji)) {
      await api.updatePost(post.id, `✅ ${formatter.formatBold('Allowed')} by ${formatter.formatUserMention(username)}\n\n${toolInfo}`);
      mcpLogger.info(`Allowed: ${toolName}`);
      return { behavior: 'allow', updatedInput: toolInput };
    } else if (isAllowAllEmoji(emoji)) {
      cfg.setAllowAll(true);
      await api.updatePost(post.id, `✅ ${formatter.formatBold('Allowed all')} by ${formatter.formatUserMention(username)}\n\n${toolInfo}`);
      mcpLogger.info(`Allowed all: ${toolName}`);
      return { behavior: 'allow', updatedInput: toolInput };
    } else {
      await api.updatePost(post.id, `❌ ${formatter.formatBold('Denied')} by ${formatter.formatUserMention(username)}\n\n${toolInfo}`);
      mcpLogger.info(`Denied: ${toolName}`);
      return { behavior: 'deny', message: 'User denied permission' };
    }
  } catch (error) {
    mcpLogger.error(`Permission error: ${error}`);
    return { behavior: 'deny', message: String(error) };
  }
}

async function handlePermission(
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<PermissionResult> {
  return handlePermissionWith(toolName, toolInput, {
    api: getApi(),
    threadId: PLATFORM_THREAD_ID || undefined,
    timeoutMs: PERMISSION_TIMEOUT_MS,
    platformConfigured: Boolean(PLATFORM_URL && PLATFORM_TOKEN && PLATFORM_CHANNEL_ID),
    getAllowAll: () => allowAllSession,
    setAllowAll: (v) => { allowAllSession = v; },
  });
}

// =============================================================================
// MCP Server Setup
// =============================================================================

// Define the input schema outside the function call to avoid TypeScript recursion issues
const permissionInputSchema = {
  tool_name: z.string().describe('Name of the tool requesting permission'),
  input: z.record(z.string(), z.unknown()).describe('Tool input parameters'),
};

const sendFileInputSchema = {
  path: z
    .string()
    .describe(
      'Absolute path of a file inside the session working directory. The bot will upload it to chat.',
    ),
  caption: z
    .string()
    .optional()
    .describe('Optional message body / initial comment shown alongside the file.'),
};

export interface SendFileResult {
  ok: boolean;
  postId?: string;
  reason?: string;
}

export interface SendFileHandlerConfig {
  api: PermissionApi;
  threadId: string;
  enabled: boolean;
  allowedRoots: string[];
  maxBytes: number;
}

/**
 * Handle a `send_file` invocation: validate the path, then call into the
 * permission-API's uploadFile. Returns a JSON-friendly result the MCP child
 * can serialize back to Claude.
 */
export async function handleSendFileWith(
  args: { path: string; caption?: string },
  cfg: SendFileHandlerConfig,
): Promise<SendFileResult> {
  if (!cfg.enabled) {
    return { ok: false, reason: 'outbound file sending is disabled by the operator' };
  }
  if (!cfg.api.uploadFile) {
    return { ok: false, reason: 'this platform does not support outbound file uploads' };
  }
  if (!cfg.threadId) {
    return { ok: false, reason: 'no thread context — file uploads only work inside a session thread' };
  }
  if (cfg.allowedRoots.length === 0) {
    return { ok: false, reason: 'no allowed roots configured for outbound file uploads' };
  }

  const validated = await validateOutboundPath(args.path, {
    allowedRoots: cfg.allowedRoots,
    maxBytes: cfg.maxBytes,
  });
  if (!validated.ok) {
    return { ok: false, reason: validated.reason };
  }

  try {
    const result = await cfg.api.uploadFile(validated.resolvedPath, cfg.threadId, {
      caption: args.caption,
      filename: validated.basename,
    });
    return { ok: true, postId: result.postId };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    mcpLogger.warn(`send_file upload failed: ${reason}`);
    return { ok: false, reason };
  }
}

async function handleSendFile(args: { path: string; caption?: string }): Promise<SendFileResult> {
  return handleSendFileWith(args, {
    api: getApi(),
    threadId: PLATFORM_THREAD_ID,
    enabled: OUTBOUND_FILES_ENABLED,
    allowedRoots: [SESSION_WORKING_DIR, SESSION_UPLOAD_DIR].filter(p => p.length > 0),
    maxBytes: OUTBOUND_FILES_MAX_BYTES,
  });
}

async function main() {
  const server = new McpServer({
    name: 'claude-threads-permissions',
    version: '1.0.0',
  });

  // Use type assertion to work around TypeScript recursion depth issues with zod
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).tool(
    'permission_prompt',
    'Handle permission requests via chat platform reactions',
    permissionInputSchema,
    async ({ tool_name, input }: { tool_name: string; input: Record<string, unknown> }) => {
      const result = await handlePermission(tool_name, input);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).tool(
    'send_file',
    'Send a file from the session working directory directly into the chat thread. ' +
      'Use this when the user asked to receive a file inline, or when you produce an artifact ' +
      'they should see (screenshot, generated audio, plot, document). The path must be absolute ' +
      'and inside the session working directory. Returns { ok: true, postId } on success or ' +
      '{ ok: false, reason } on failure.',
    sendFileInputSchema,
    async ({ path, caption }: { path: string; caption?: string }) => {
      const result = await handleSendFile({ path, caption });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  mcpLogger.info(`Permission server ready (platform: ${PLATFORM_TYPE})`);
}

main().catch((err) => {
  mcpLogger.error(`Fatal: ${err}`);
  process.exit(1);
});
