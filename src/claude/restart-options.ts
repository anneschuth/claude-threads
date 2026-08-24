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
import type { ResolvedMemoryConfig } from '../config/index.js';

export interface RestartContext {
  chromeEnabled: boolean;
  permissionTimeoutMs?: number;
  /** Pre-resolved account binding. Undefined for single-account mode. */
  account?: ClaudeCliAccount;
  /**
   * Feature-gate resolvers (a subset of SessionContext.ops), used to compute
   * the MCP child's agent-tool gates. REQUIRED so a respawn can't silently
   * drop the gating — the same hazard class this module exists for.
   */
  ops: AgentFeatureOps;
}

/** The SessionContext.ops subset sessionAgentFeatures needs. */
export interface AgentFeatureOps {
  getPlatformMemoryConfig(platformId: string): ResolvedMemoryConfig;
  isRoutinesEnabled(platformId: string): boolean;
  isWatchesEnabled(platformId: string): boolean;
}

/**
 * Compute the agent-feature tool gates for a session spawn/respawn: which
 * agent-initiated MCP tools (remember_fact, propose_routine, …) the child
 * may register. Advisory — the bot re-checks per bridge request — but keep
 * it truthful so disabled features' tools never appear in the model's list.
 */
export function sessionAgentFeatures(
  session: { platformId: string; unattended?: boolean },
  ops: AgentFeatureOps,
): NonNullable<ClaudeCliOptions['agentFeatures']> {
  const memory = ops.getPlatformMemoryConfig(session.platformId);
  return {
    memoryChannel: memory.enabled && memory.channelLayer,
    routines: ops.isRoutinesEnabled(session.platformId),
    watches: ops.isWatchesEnabled(session.platformId),
    unattended: session.unattended === true,
  };
}

/**
 * Platform MCP config with approvals scoping applied. Every CLI respawn path
 * must use this instead of a raw `getMcpConfig()`: scoping must survive
 * respawns (!cd, !permissions, worktrees, plugin install/uninstall) — and a
 * respawn is also the moment a later `!invite` actually reaches the approval
 * set.
 */
export function scopedMcpConfig(session: Session): ReturnType<Session['platform']['getMcpConfig']> {
  const platformMcpConfig = session.platform.getMcpConfig();
  if (resolveApprovals(session.platform.approvals, isDcmThreadId(session.threadId)) === 'owner') {
    platformMcpConfig.allowedUsers = Array.from(session.sessionAllowedUsers);
  }
  return platformMcpConfig;
}

export function buildRestartCliOptions(
  session: Session,
  ctx: RestartContext,
): Partial<ClaudeCliOptions> & Pick<ClaudeCliOptions, 'agentFeatures'> {
  const platformMcpConfig = scopedMcpConfig(session);
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
    agentFeatures: sessionAgentFeatures(session, ctx.ops),
  };
}
