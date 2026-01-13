import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';
import yaml from 'js-yaml';

// Re-export all types from types.ts
export type {
  WorktreeMode,
  ThreadLogsConfig,
  LimitsConfig,
  Config,
  PlatformInstanceConfig,
  MattermostPlatformConfig,
  SlackPlatformConfig,
  AutoUpdateConfig,
  AutoRestartMode,
  ScheduledWindow,
} from './types.js';
export { LIMITS_DEFAULTS, resolveLimits } from './types.js';

import type { Config } from './types.js';

// YAML config path
export const CONFIG_PATH = resolve(homedir(), '.config', 'claude-threads', 'config.yaml');

// =============================================================================
// Config Loading
// =============================================================================

/**
 * Load config from YAML file
 */
export function loadConfigWithMigration(): Config | null {
  if (existsSync(CONFIG_PATH)) {
    const content = readFileSync(CONFIG_PATH, 'utf-8');
    return Bun.YAML.parse(content) as Config;
  }
  return null; // No config found
}

/**
 * Save config to YAML file with secure permissions
 * - Directory: 0o700 (only owner can access)
 * - File: 0o600 (only owner can read/write)
 * This is important because the config contains API tokens
 *
 * @param config - The configuration to save
 * @param path - Optional custom path (for testing), defaults to CONFIG_PATH
 */
export function saveConfig(config: Config, path: string = CONFIG_PATH): void {
  const configDir = dirname(path);
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  // Use js-yaml with block style for readable YAML output
  const yamlContent = yaml.dump(config, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });
  writeFileSync(path, yamlContent, { encoding: 'utf-8', mode: 0o600 });

  // Also fix permissions on existing files (in case they were created with wrong permissions)
  try {
    chmodSync(configDir, 0o700);
    chmodSync(path, 0o600);
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
