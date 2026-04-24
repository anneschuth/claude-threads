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

export interface MattermostPlatformConfig extends PlatformInstanceConfig {
  type: 'mattermost';
  url: string;
  token: string;
  channelId: string;
  botName: string;
  allowedUsers: string[];
  skipPermissions: boolean;
}

export interface SlackPlatformConfig extends PlatformInstanceConfig {
  type: 'slack';
  botToken: string;
  appToken: string;
  channelId: string;
  botName: string;
  allowedUsers: string[];
  skipPermissions: boolean;
  /** Optional API URL override for testing (defaults to https://slack.com/api) */
  apiUrl?: string;
}
