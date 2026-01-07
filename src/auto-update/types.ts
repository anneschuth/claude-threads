/**
 * Auto-update types and constants
 *
 * Type definitions for the auto-update system that handles version checking,
 * installation, and restart coordination.
 */

// =============================================================================
// Constants
// =============================================================================

/** Exit code that signals "restart needed" to the daemon wrapper */
export const RESTART_EXIT_CODE = 42;

/** Default check interval in minutes */
export const DEFAULT_CHECK_INTERVAL_MINUTES = 60;

/** Default idle timeout in minutes (for 'idle' mode) */
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 5;

/** Default quiet timeout in minutes (for 'quiet' mode) */
export const DEFAULT_QUIET_TIMEOUT_MINUTES = 10;

/** Default ask timeout in minutes (for 'ask' mode) */
export const DEFAULT_ASK_TIMEOUT_MINUTES = 30;

/** Minimum check interval (5 minutes) */
export const MIN_CHECK_INTERVAL_MINUTES = 5;

/** Path to state file for persisting update state across restarts */
export const UPDATE_STATE_FILENAME = 'update-state.json';

// =============================================================================
// Configuration Types
// =============================================================================

/** Timing mode for when to apply updates */
export type AutoRestartMode = 'immediate' | 'idle' | 'quiet' | 'scheduled' | 'ask';

/** Scheduled time window for updates */
export interface ScheduledWindow {
  /** Start hour (0-23) */
  startHour: number;
  /** End hour (0-23) */
  endHour: number;
}

/** Auto-update configuration (as stored in config.yaml) */
export interface AutoUpdateConfig {
  /** Whether auto-update is enabled (default: true) */
  enabled: boolean;

  /** How often to check for updates in minutes (default: 60) */
  checkIntervalMinutes: number;

  /** When to restart for updates */
  autoRestartMode: AutoRestartMode;

  /** For 'idle' mode: wait until no sessions for N minutes */
  idleTimeoutMinutes: number;

  /** For 'quiet' mode: wait until no activity in sessions for N minutes */
  quietTimeoutMinutes: number;

  /** For 'scheduled' mode: time window for updates */
  scheduledWindow: ScheduledWindow;

  /** For 'ask' mode: auto-proceed if no response after N minutes */
  askTimeoutMinutes: number;
}

/** Default auto-update configuration */
export const DEFAULT_AUTO_UPDATE_CONFIG: AutoUpdateConfig = {
  enabled: true,
  checkIntervalMinutes: DEFAULT_CHECK_INTERVAL_MINUTES,
  autoRestartMode: 'idle',
  idleTimeoutMinutes: DEFAULT_IDLE_TIMEOUT_MINUTES,
  quietTimeoutMinutes: DEFAULT_QUIET_TIMEOUT_MINUTES,
  scheduledWindow: {
    startHour: 2,
    endHour: 5,
  },
  askTimeoutMinutes: DEFAULT_ASK_TIMEOUT_MINUTES,
};

// =============================================================================
// Update State Types
// =============================================================================

/** Update availability information */
export interface UpdateInfo {
  /** Whether an update is available */
  available: boolean;

  /** Current installed version */
  currentVersion: string;

  /** Latest available version */
  latestVersion: string;

  /** When the update was detected */
  detectedAt: Date;
}

/** Update installation status */
export type UpdateStatus =
  | 'idle'            // No update in progress
  | 'available'       // Update detected, waiting for right time
  | 'scheduled'       // Restart scheduled (countdown active)
  | 'installing'      // npm install in progress
  | 'pending_restart' // Install complete, waiting for restart
  | 'failed'          // Installation failed
  | 'deferred';       // User deferred the update

/** Persisted update state (survives restarts) */
export interface PersistedUpdateState {
  /** Previous version before update (for rollback instructions) */
  previousVersion?: string;

  /** Target version being installed */
  targetVersion?: string;

  /** When the update started */
  startedAt?: string;

  /** Whether an update just completed (for post-restart notification) */
  justUpdated?: boolean;

  /** Last check time (for rate limiting checks on restart) */
  lastCheckAt?: string;

  /** Deferred until this time (ISO string) */
  deferredUntil?: string;
}

/** Runtime update state (in-memory) */
export interface UpdateState {
  /** Current status */
  status: UpdateStatus;

  /** Update info (if available) */
  updateInfo?: UpdateInfo;

  /** Scheduled restart time (for countdown display) */
  scheduledRestartAt?: Date;

  /** Installation error message (if failed) */
  errorMessage?: string;

  /** Ask mode: threads that have approved (threadId -> boolean) */
  askApprovals?: Map<string, boolean>;
}

// =============================================================================
// Event Types
// =============================================================================

/** Events emitted by the AutoUpdateManager */
export interface AutoUpdateEvents {
  /** Update available (emitted when check finds new version) */
  'update:available': (info: UpdateInfo) => void;

  /** Update status changed */
  'update:status': (status: UpdateStatus, message?: string) => void;

  /** Restart countdown started */
  'update:countdown': (secondsRemaining: number) => void;

  /** Update installation complete, restart imminent */
  'update:restart': (newVersion: string) => void;

  /** Update installation failed */
  'update:failed': (error: string) => void;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Merge user config with defaults, handling partial configs.
 */
export function mergeAutoUpdateConfig(
  userConfig: Partial<AutoUpdateConfig> | undefined
): AutoUpdateConfig {
  if (!userConfig) {
    return { ...DEFAULT_AUTO_UPDATE_CONFIG };
  }

  return {
    enabled: userConfig.enabled ?? DEFAULT_AUTO_UPDATE_CONFIG.enabled,
    checkIntervalMinutes: Math.max(
      MIN_CHECK_INTERVAL_MINUTES,
      userConfig.checkIntervalMinutes ?? DEFAULT_AUTO_UPDATE_CONFIG.checkIntervalMinutes
    ),
    autoRestartMode: userConfig.autoRestartMode ?? DEFAULT_AUTO_UPDATE_CONFIG.autoRestartMode,
    idleTimeoutMinutes: userConfig.idleTimeoutMinutes ?? DEFAULT_AUTO_UPDATE_CONFIG.idleTimeoutMinutes,
    quietTimeoutMinutes: userConfig.quietTimeoutMinutes ?? DEFAULT_AUTO_UPDATE_CONFIG.quietTimeoutMinutes,
    scheduledWindow: userConfig.scheduledWindow ?? DEFAULT_AUTO_UPDATE_CONFIG.scheduledWindow,
    askTimeoutMinutes: userConfig.askTimeoutMinutes ?? DEFAULT_AUTO_UPDATE_CONFIG.askTimeoutMinutes,
  };
}

/**
 * Check if we're within the scheduled update window.
 */
export function isInScheduledWindow(window: ScheduledWindow): boolean {
  const now = new Date();
  const hour = now.getHours();

  // Handle window that spans midnight (e.g., 22:00 - 05:00)
  if (window.startHour > window.endHour) {
    return hour >= window.startHour || hour < window.endHour;
  }

  return hour >= window.startHour && hour < window.endHour;
}
