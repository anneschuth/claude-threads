/**
 * Configuration type definitions for claude-threads
 */

import type { AutoUpdateConfig, AutoRestartMode, ScheduledWindow } from '../auto-update/types.js';

// Re-export auto-update types for convenience
export type { AutoUpdateConfig, AutoRestartMode, ScheduledWindow };

// =============================================================================
// Types
// =============================================================================

export type WorktreeMode = 'off' | 'prompt' | 'require';

/**
 * Thread logging configuration
 */
export interface ThreadLogsConfig {
  enabled?: boolean;        // Default: true
  retentionDays?: number;   // Default: 30 - days to keep logs after session ends
}

/**
 * Resource limits and timeouts configuration
 * All fields are optional with sensible defaults. Additions here must stay
 * backward-compatible (optional + defaulted) — `config.yaml` files in the
 * wild predate most of these fields.
 */
export interface LimitsConfig {
  /** Maximum concurrent sessions (default: 5) */
  maxSessions?: number;
  /** Idle timeout before auto-terminate session, in minutes (default: 30) */
  sessionTimeoutMinutes?: number;
  /** Warn user N minutes before session timeout (default: 5) */
  sessionWarningMinutes?: number;
  /** Background cleanup run frequency, in minutes (default: 60) */
  cleanupIntervalMinutes?: number;
  /** Cleanup orphaned worktrees older than N hours (default: 24) */
  maxWorktreeAgeHours?: number;
  /** Enable automatic cleanup of orphaned worktrees (default: true) */
  cleanupWorktrees?: boolean;
  /** Timeout for permission approval reactions, in seconds (default: 120) */
  permissionTimeoutSeconds?: number;
  /**
   * Delay between the first streaming chunk and flushing the batched output
   * to the platform, in ms (default: 500). Lower = snappier updates +
   * more API calls. Higher = fewer posts + coarser visible streaming.
   */
  flushDelayMs?: number;
}

/**
 * Resolved limits. Every field is non-optional so downstream code doesn't
 * defend itself.
 */
export interface ResolvedLimits {
  maxSessions: number;
  sessionTimeoutMinutes: number;
  sessionWarningMinutes: number;
  cleanupIntervalMinutes: number;
  maxWorktreeAgeHours: number;
  cleanupWorktrees: boolean;
  permissionTimeoutSeconds: number;
  flushDelayMs: number;
}

/**
 * Default values for LimitsConfig
 */
export const LIMITS_DEFAULTS: ResolvedLimits = {
  maxSessions: 5,
  sessionTimeoutMinutes: 30,
  sessionWarningMinutes: 5,
  cleanupIntervalMinutes: 60,
  maxWorktreeAgeHours: 24,
  cleanupWorktrees: true,
  permissionTimeoutSeconds: 120,
  flushDelayMs: 500,
};

/**
 * Resolve limits config with defaults, supporting env var fallback for backward compatibility
 */
export function resolveLimits(limits?: LimitsConfig): ResolvedLimits {
  // Support legacy env vars as fallback
  const envMaxSessions = process.env.MAX_SESSIONS ? parseInt(process.env.MAX_SESSIONS, 10) : undefined;
  const envSessionTimeout = process.env.SESSION_TIMEOUT_MS
    ? Math.round(parseInt(process.env.SESSION_TIMEOUT_MS, 10) / 60000) // Convert ms to minutes
    : undefined;

  return {
    maxSessions: limits?.maxSessions ?? envMaxSessions ?? LIMITS_DEFAULTS.maxSessions,
    sessionTimeoutMinutes: limits?.sessionTimeoutMinutes ?? envSessionTimeout ?? LIMITS_DEFAULTS.sessionTimeoutMinutes,
    sessionWarningMinutes: limits?.sessionWarningMinutes ?? LIMITS_DEFAULTS.sessionWarningMinutes,
    cleanupIntervalMinutes: limits?.cleanupIntervalMinutes ?? LIMITS_DEFAULTS.cleanupIntervalMinutes,
    maxWorktreeAgeHours: limits?.maxWorktreeAgeHours ?? LIMITS_DEFAULTS.maxWorktreeAgeHours,
    cleanupWorktrees: limits?.cleanupWorktrees ?? LIMITS_DEFAULTS.cleanupWorktrees,
    permissionTimeoutSeconds: limits?.permissionTimeoutSeconds ?? LIMITS_DEFAULTS.permissionTimeoutSeconds,
    flushDelayMs: limits?.flushDelayMs ?? LIMITS_DEFAULTS.flushDelayMs,
  };
}

/**
 * Sticky message customization
 */
export interface StickyMessageCustomization {
  /** Custom description shown below the title (e.g., what the bot does) */
  description?: string;
  /** Custom footer content shown before the default "Mention me to start a session" line */
  footer?: string;
}

/**
 * One Claude subscription/account the bot can spawn sessions under.
 *
 * Exactly one of `home` or `apiKey` should be set:
 * - `home`: path to an alternate $HOME that contains `.claude/.credentials.json`
 *   from a prior `HOME=<path> claude login`. Used for OAuth Pro/Max subscriptions.
 *   Claude's history (`~/.claude/projects/...`) also lives here, so a resumed
 *   session MUST pick the same account.
 * - `apiKey`: direct Anthropic API key. Billed against that key's account.
 *   History still persists under the bot's default HOME because Claude only
 *   uses `apiKey` for billing, not for state storage.
 *
 * Leaving `claudeAccounts` unset in config keeps the bot in single-account mode:
 * every session inherits `process.env` exactly as before.
 */
export interface ClaudeAccount {
  /** Stable identifier used in logs, UI, and persisted session state. */
  id: string;
  /** Alternate $HOME for OAuth-based accounts. Mutually exclusive with apiKey. */
  home?: string;
  /** Anthropic API key for API-billed accounts. Mutually exclusive with home. */
  apiKey?: string;
  /** Optional human-readable label shown in UI (defaults to `id`). */
  displayName?: string;
}

export interface Config {
  version: number;
  workingDir: string;
  chrome: boolean;
  worktreeMode: WorktreeMode;
  keepAlive?: boolean; // Optional, defaults to true when undefined
  autoUpdate?: Partial<AutoUpdateConfig>; // Optional auto-update configuration
  threadLogs?: ThreadLogsConfig; // Optional thread logging configuration
  limits?: LimitsConfig; // Optional resource limits and timeouts
  stickyMessage?: StickyMessageCustomization; // Optional sticky message customization
  /** Optional Claude account pool. When omitted, bot runs in single-account mode. */
  claudeAccounts?: ClaudeAccount[];
  platforms: PlatformInstanceConfig[];
}

export interface PlatformInstanceConfig {
  id: string;
  type: 'mattermost' | 'slack';
  displayName: string;
  // Platform-specific fields (TypeScript allows extra properties)
  [key: string]: unknown;
}

// =============================================================================
// Permission modes
// =============================================================================

/**
 * How tool-use permissions are enforced for Claude sessions.
 *
 * - `default`: Claude always asks before using a tool; the bot posts a permission
 *   prompt in the thread and the user reacts 👍 / ✅ / 👎 to allow/allow-all/deny.
 *   This is the safest option and the historical behavior when
 *   `skipPermissions: false`.
 *
 * - `auto`: Claude's built-in classifier decides per-tool-use. Low-risk tools
 *   (Read, Grep, Write within the working dir) are auto-approved; high-risk
 *   tools (shell with external effects, writes outside the working dir) still
 *   prompt via the MCP permission server. Introduced in Claude CLI 2.1.x.
 *   New in this config; no backward-compat shim needed.
 *
 * - `bypass`: No prompts, no classifier — every tool-use is allowed. Equivalent
 *   to passing `--dangerously-skip-permissions` to the Claude CLI. This is what
 *   the legacy `skipPermissions: true` maps to.
 */
export type PermissionMode = 'default' | 'auto' | 'bypass';

/**
 * Resolve the effective permission mode from new + legacy fields. New config
 * wins; legacy `skipPermissions` is honored when `permissionMode` is unset.
 *
 * Returns `'default'` when both are unset — the safe choice for ambiguous
 * configs (asks the user to decide rather than silently bypassing).
 */
export function resolvePermissionMode(opts: {
  permissionMode?: PermissionMode;
  /** @deprecated Use `permissionMode` instead. Kept for backward compat. */
  skipPermissions?: boolean;
}): PermissionMode {
  if (opts.permissionMode) return opts.permissionMode;
  if (opts.skipPermissions === true) return 'bypass';
  if (opts.skipPermissions === false) return 'default';
  return 'default';
}

/**
 * Display metadata for a permission mode. One source of truth for the
 * `{icon} {label}` chips used in the sticky message, session header, and the
 * `!permissions` confirmation post.
 */
export function permissionModeDisplay(
  mode: PermissionMode,
): { icon: string; label: string; /** "🔐 Default" */ chip: string } {
  switch (mode) {
    case 'default':
      return { icon: '🔐', label: 'Default', chip: '🔐 Default' };
    case 'auto':
      return { icon: '⚡', label: 'Auto',    chip: '⚡ Auto' };
    case 'bypass':
      return { icon: '⚠️', label: 'Bypass',  chip: '⚠️ Bypass' };
  }
}

/**
 * Human-readable description of what a permission mode actually does.
 * Used in `!permissions` confirmation posts so users know what they opted into.
 */
export function permissionModeDescription(mode: PermissionMode): string {
  switch (mode) {
    case 'default': return 'Every tool-use prompts for approval.';
    case 'auto':    return 'Claude classifier auto-approves low-risk tools; high-risk still prompts.';
    case 'bypass':  return 'No prompts — every tool-use is allowed.';
  }
}

/**
 * Mode to spawn Claude with when respawning an existing session (because of
 * `!cd`, plugin install/uninstall, or worktree switch).
 *
 * This preserves pre-existing behavior from before PR #343: the old code was
 * `skipPermissions: ctx.config.skipPermissions || !session.forceInteractivePermissions`.
 * That formula has a subtle quirk — it downgrades 'default' sessions to
 * 'bypass' on respawn unless the session explicitly opted into interactive
 * via `!permissions`. Kept here verbatim to avoid smuggling a behavior
 * change into a refactor; separately tracked for a follow-up.
 *
 * @param sessionHasInteractiveOverride `Session.forceInteractivePermissions`
 * @param currentMode current effective permission mode (bot-wide or override)
 */
export function permissionModeForRestart(
  sessionHasInteractiveOverride: boolean,
  currentMode: PermissionMode,
): PermissionMode {
  return currentMode === 'bypass' || !sessionHasInteractiveOverride
    ? 'bypass'
    : 'default';
}

// =============================================================================
// Platform configs
// =============================================================================

export interface MattermostPlatformConfig extends PlatformInstanceConfig {
  type: 'mattermost';
  url: string;
  token: string;
  channelId: string;
  botName: string;
  allowedUsers: string[];
  /**
   * @deprecated Use `permissionMode` instead. Kept for backward compatibility
   * with existing config.yaml files. When both are set, `permissionMode` wins.
   */
  skipPermissions?: boolean;
  /** Preferred way to configure permissions. See `PermissionMode`. */
  permissionMode?: PermissionMode;
}

export interface SlackPlatformConfig extends PlatformInstanceConfig {
  type: 'slack';
  botToken: string;
  appToken: string;
  channelId: string;
  botName: string;
  allowedUsers: string[];
  /**
   * @deprecated Use `permissionMode` instead. Kept for backward compatibility
   * with existing config.yaml files. When both are set, `permissionMode` wins.
   */
  skipPermissions?: boolean;
  /** Preferred way to configure permissions. See `PermissionMode`. */
  permissionMode?: PermissionMode;
  /** Optional API URL override for testing (defaults to https://slack.com/api) */
  apiUrl?: string;
}
