/**
 * Auto-update module
 *
 * Provides automatic version checking, installation, and restart functionality.
 *
 * Usage:
 * ```typescript
 * import { AutoUpdateManager, type AutoUpdateConfig } from './auto-update/index.js';
 *
 * const manager = new AutoUpdateManager(config.autoUpdate, {
 *   getSessionActivity: () => sessionManager.getActivityInfo(),
 *   getActiveThreadIds: () => sessionManager.getActiveThreadIds(),
 *   broadcastUpdate: (msg) => sessionManager.broadcastToAll(msg),
 *   postAskMessage: (ids, ver) => sessionManager.postAskMessage(ids, ver),
 *   refreshUI: () => updateStickyMessages(),
 * });
 *
 * manager.start();
 * ```
 */

// Main manager
export { AutoUpdateManager, type AutoUpdateCallbacks, type MessageBuilder } from './manager.js';

// Types
export {
  // Config types
  type AutoUpdateConfig,
  type AutoRestartMode,
  type ScheduledWindow,

  // State types
  type UpdateInfo,
  type UpdateState,
  type UpdateStatus,
  type PersistedUpdateState,

  // Event types
  type AutoUpdateEvents,

  // Constants
  RESTART_EXIT_CODE,
  DEFAULT_AUTO_UPDATE_CONFIG,
  DEFAULT_CHECK_INTERVAL_MINUTES,
  DEFAULT_IDLE_TIMEOUT_MINUTES,
  DEFAULT_QUIET_TIMEOUT_MINUTES,
  DEFAULT_ASK_TIMEOUT_MINUTES,

  // Helpers
  mergeAutoUpdateConfig,
  isInScheduledWindow,
} from './types.js';

// Scheduler types (for advanced usage)
export { type SessionActivityInfo } from './scheduler.js';

// Installer utilities (for manual operations)
export {
  checkJustUpdated,
  getRollbackInstructions,
  loadUpdateState,
  saveUpdateState,
  clearUpdateState,
} from './installer.js';
