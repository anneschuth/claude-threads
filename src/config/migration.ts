import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';
import type { AutoUpdateConfig, AutoRestartMode, ScheduledWindow } from '../auto-update/types.js';

// YAML config path
export const CONFIG_PATH = resolve(homedir(), '.config', 'claude-threads', 'config.yaml');

// =============================================================================
// Types
// =============================================================================

export type WorktreeMode = 'off' | 'prompt' | 'require';

// Re-export auto-update types for convenience
export type { AutoUpdateConfig, AutoRestartMode, ScheduledWindow };

/**
 * Thread logging configuration
 */
export interface ThreadLogsConfig {
  enabled?: boolean;        // Default: true
  retentionDays?: number;   // Default: 30 - days to keep logs after session ends
}

export interface NewConfig {
  version: number;
  workingDir: string;
  chrome: boolean;
  worktreeMode: WorktreeMode;
  keepAlive?: boolean; // Optional, defaults to true when undefined
  autoUpdate?: Partial<AutoUpdateConfig>; // Optional auto-update configuration
  threadLogs?: ThreadLogsConfig; // Optional thread logging configuration
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

// =============================================================================
// Config Loading
// =============================================================================

/**
 * Load config from YAML file
 */
export function loadConfigWithMigration(): NewConfig | null {
  if (existsSync(CONFIG_PATH)) {
    const content = readFileSync(CONFIG_PATH, 'utf-8');
    return Bun.YAML.parse(content) as NewConfig;
  }
  return null; // No config found
}

/**
 * Save config to YAML file with secure permissions
 * - Directory: 0o700 (only owner can access)
 * - File: 0o600 (only owner can read/write)
 * This is important because the config contains API tokens
 */
export function saveConfig(config: NewConfig): void {
  const configDir = dirname(CONFIG_PATH);
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(CONFIG_PATH, Bun.YAML.stringify(config), { encoding: 'utf-8', mode: 0o600 });

  // Also fix permissions on existing files (in case they were created with wrong permissions)
  try {
    chmodSync(configDir, 0o700);
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // Ignore permission errors (might happen on some systems)
  }
}

/**
 * Check if config exists
 */
export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}
