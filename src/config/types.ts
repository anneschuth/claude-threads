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
 * Visibility for the bot's "overhead" posts (per-thread session header and
 * channel sticky). Per-platform — see `PlatformInstanceConfig.sessionHeader`
 * and `PlatformInstanceConfig.stickyMessage`.
 *
 * - `full` (default): full table / sessions list, today's behavior.
 * - `minimal`: one-line status bar only.
 * - `hidden`: don't post at all.
 */
export type OverheadVisibility = 'full' | 'minimal' | 'hidden';

export const OVERHEAD_VISIBILITY_VALUES: readonly OverheadVisibility[] = ['full', 'minimal', 'hidden'] as const;

export const DEFAULT_OVERHEAD_VISIBILITY: OverheadVisibility = 'full';

export function isOverheadVisibility(value: unknown): value is OverheadVisibility {
  return typeof value === 'string' && (OVERHEAD_VISIBILITY_VALUES as readonly string[]).includes(value);
}

/**
 * Normalize a per-platform overhead-visibility field. Undefined → default.
 * Throws on any other invalid value so config errors surface at startup
 * instead of silently falling back.
 */
export function resolveOverheadVisibility(
  value: unknown,
  fieldPath: string,
): OverheadVisibility {
  if (value === undefined || value === null) return DEFAULT_OVERHEAD_VISIBILITY;
  if (isOverheadVisibility(value)) return value;
  throw new Error(
    `Invalid ${fieldPath}: expected one of ${OVERHEAD_VISIBILITY_VALUES.join(', ')}, got ${JSON.stringify(value)}`,
  );
}

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
  /**
   * Per-thread session header visibility. Default `'full'`.
   * `'minimal'` keeps only the one-line status bar; `'hidden'` skips the
   * header post entirely so Claude's own response is the first message in
   * the thread.
   */
  sessionHeader?: OverheadVisibility;
  /**
   * Channel-level sticky message visibility for this platform. Default `'full'`.
   * `'minimal'` keeps only the one-line status bar (no active-sessions list);
   * `'hidden'` disables the sticky entirely (no post, no bumping). Distinct
   * from the top-level `Config.stickyMessage` block, which only customizes
   * the sticky's `description` / `footer` for platforms still rendering it.
   */
  stickyMessage?: OverheadVisibility;
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
 * Single source of truth for user-facing metadata per permission mode.
 * Every consumer (sticky message, session header, `!permissions` post) reads
 * from this record — add a new field here and it's available everywhere.
 */
const MODE_INFO: Record<PermissionMode, {
  icon: string;
  label: string;
  description: string;
}> = {
  default: {
    icon: '🔐',
    label: 'Default',
    description: 'Every tool-use prompts for approval.',
  },
  auto: {
    icon: '⚡',
    label: 'Auto',
    description: 'Claude classifier auto-approves low-risk tools; high-risk still prompts.',
  },
  bypass: {
    icon: '⚠️',
    label: 'Bypass',
    description: 'No prompts — every tool-use is allowed.',
  },
};

/**
 * Display metadata for a permission mode. One source of truth for the
 * `{icon} {label}` chips used in the sticky message, session header, and the
 * `!permissions` confirmation post.
 */
export function permissionModeDisplay(
  mode: PermissionMode,
): { icon: string; label: string; /** "🔐 Default" */ chip: string } {
  const info = MODE_INFO[mode];
  return { icon: info.icon, label: info.label, chip: `${info.icon} ${info.label}` };
}

/**
 * Human-readable description of what a permission mode actually does.
 * Used in `!permissions` confirmation posts so users know what they opted into.
 */
export function permissionModeDescription(mode: PermissionMode): string {
  return MODE_INFO[mode].description;
}

/**
 * Compute a session's effective permission mode.
 *
 * Precedence (highest wins):
 *   1. `override` — explicit in-process override set by `!permissions <mode>`
 *      on this session. Not persisted.
 *   2. `sessionHasInteractiveOverride` — sticky `default` opt-in flag
 *      (persists across bot restart via `PersistedSession.forceInteractivePermissions`).
 *   3. `botWideMode` — the bot's current default mode.
 *
 * Used both for user-facing display (session header, `isSessionInteractive`)
 * and for choosing the mode when respawning Claude after `!cd` / plugin
 * install/uninstall / worktree switch. In both cases the semantic is the
 * same: "what mode should THIS session run under right now?"
 */
export function effectivePermissionMode(input: {
  override?: PermissionMode;
  sessionHasInteractiveOverride: boolean;
  botWideMode: PermissionMode;
}): PermissionMode {
  if (input.override) return input.override;
  if (input.sessionHasInteractiveOverride) return 'default';
  return input.botWideMode;
}

// =============================================================================
// Platform configs
// =============================================================================

/**
 * Outbound file (`send_file`) settings. When omitted, defaults to
 * `{ enabled: true, maxBytes: 100 MB }`.
 */
export interface OutboundFilesConfig {
  /** When false, the `send_file` MCP tool returns an error to Claude. */
  enabled?: boolean;
  /** Per-file size cap. Defaults to 100 MB. */
  maxBytes?: number;
}

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
  /** Outbound `send_file` settings. */
  outboundFiles?: OutboundFilesConfig;
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
  /** Outbound `send_file` settings. */
  outboundFiles?: OutboundFilesConfig;
}
