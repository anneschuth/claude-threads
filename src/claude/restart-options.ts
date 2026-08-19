/**
 * Shared builder for the cross-cutting `ClaudeCliOptions` fields that every
 * Claude restart site needs identical wiring for. Lives in `src/claude/` so
 * it sits alongside `ClaudeCli` itself, and so callers in different layers
 * (operations/commands, operations/worktree, session/lifecycle) can all use
 * it without circular imports.
 *
 * Why this exists: there are FIVE places in the codebase that construct a
 * `ClaudeCli` (start session, resume session, !cd, !permissions interactive,
 * !worktree create / switch). Each of them must thread `uploadDir` and
 * `outboundFiles` through, or `send_file` silently breaks. Forgot two of
 * them in the original PR (#361 worktree paths) and only caught it during
 * manual testing — exactly the failure mode this helper exists to prevent.
 *
 * Callers pass the small set of cross-cutting primitives they have access
 * to (chromeEnabled, permissionTimeoutMs, account); the helper derives
 * uploadDir / outboundFiles from `session` itself.
 */

import type { ClaudeCliOptions, ClaudeCliAccount } from './cli.js';
import { isDcmThreadId, resolveApprovals } from '../platform/utils.js';
import type { Session } from '../session/types.js';
import { getSessionUploadDir } from '../operations/streaming/index.js';

export interface RestartContext {
  chromeEnabled: boolean;
  permissionTimeoutMs?: number;
  /** Pre-resolved account binding. Undefined for single-account mode. */
  account?: ClaudeCliAccount;
}

export function buildRestartCliOptions(
  session: Session,
  ctx: RestartContext,
): Partial<ClaudeCliOptions> {
  const platformMcpConfig = session.platform.getMcpConfig();
  // Approvals scoping must survive CLI respawns (!cd, !permissions,
  // worktree switches) — and a respawn is also the moment a later !invite
  // actually reaches the approval set.
  if (resolveApprovals(session.platform.approvals, isDcmThreadId(session.threadId)) === 'owner') {
    platformMcpConfig.allowedUsers = Array.from(session.sessionAllowedUsers);
  }
  return {
    threadId: session.threadId,
    chrome: ctx.chromeEnabled,
    platformConfig: platformMcpConfig,
    logSessionId: session.sessionId,
    permissionTimeoutMs: ctx.permissionTimeoutMs,
    account: ctx.account,
    uploadDir: getSessionUploadDir(session.platformId, session.threadId),
    outboundFiles: platformMcpConfig.outboundFiles,
    sessionOwnerUsername: session.startedBy,
    // The bridge is session-scoped and survives respawns: the new MCP child
    // must reconnect to the same socket.
    decisionBridgePath: session.decisionBridge?.path,
  };
}
