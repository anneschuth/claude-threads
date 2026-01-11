/**
 * Configuration type exports
 *
 * Re-exports types from config/migration.ts for convenience.
 * The actual config loading and migration logic is in config/migration.ts.
 */

import type { WorktreeMode as WorktreeModeType } from './config/migration.js';

// Re-export types and functions
export type {
  Config,
  PlatformInstanceConfig,
  MattermostPlatformConfig,
  WorktreeMode,
  LimitsConfig,
} from './config/migration.js';

export { resolveLimits, LIMITS_DEFAULTS } from './config/migration.js';

/**
 * CLI arguments that can override config
 */
export interface CliArgs {
  url?: string;
  token?: string;
  channel?: string;
  botName?: string;
  allowedUsers?: string;
  skipPermissions?: boolean;
  chrome?: boolean;
  worktreeMode?: WorktreeModeType;
  keepAlive?: boolean;
}
