/**
 * Types for the Ink-based CLI UI
 */

export interface SessionInfo {
  id: string;
  threadId: string;
  startedBy: string;
  displayName?: string;
  status: 'starting' | 'active' | 'idle' | 'stopping' | 'paused';
  workingDir: string;
  sessionNumber: number;
  worktreeBranch?: string;
  // Platform information
  platformType?: 'mattermost' | 'slack';
  platformDisplayName?: string;
  // Rich session metadata
  title?: string;
  description?: string;
  tags?: string[];
  lastActivity?: Date;
  // Typing indicator state (for spinner display)
  isTyping?: boolean;
}

export interface LogEntry {
  id: string;
  timestamp: Date;
  level: 'debug' | 'info' | 'warn' | 'error';
  component: string;
  message: string;
  sessionId?: string;
}

export interface PlatformStatus {
  id: string;
  displayName: string;
  botName: string;
  url: string;
  platformType?: 'mattermost' | 'slack';
  connected: boolean;
  reconnecting: boolean;
  reconnectAttempts: number;
  enabled: boolean;  // Whether the platform is enabled (accepting messages)
}

export interface AppConfig {
  version: string;
  workingDir: string;
  claudeVersion: string;
  claudeCompatible: boolean;
  skipPermissions: boolean;
  chromeEnabled: boolean;
  keepAliveEnabled: boolean;
}

/**
 * Update panel state - tracks auto-update status for UI display
 */
export interface UpdatePanelState {
  status: 'idle' | 'available' | 'scheduled' | 'installing' | 'pending_restart' | 'failed' | 'deferred';
  currentVersion: string;
  latestVersion?: string;
  scheduledRestartAt?: Date;
  errorMessage?: string;
  deferredUntil?: Date;
}

/**
 * Runtime toggle state - can be changed via keyboard shortcuts
 */
export interface ToggleState {
  debugMode: boolean;
  skipPermissions: boolean;  // Default for new sessions
  chromeEnabled: boolean;    // Default for new sessions
  keepAliveEnabled: boolean;
  updateModalVisible: boolean;  // Whether the update modal is shown
  logsFocused: boolean;  // Whether logs panel is focused for scrolling
}

/**
 * Callbacks for when toggles change (to propagate to main logic)
 */
export interface ToggleCallbacks {
  onDebugToggle?: (enabled: boolean) => void;
  onPermissionsToggle?: (skipPermissions: boolean) => void;
  onChromeToggle?: (enabled: boolean) => void;
  onKeepAliveToggle?: (enabled: boolean) => void;
  onPlatformToggle?: (platformId: string, enabled: boolean) => void;
  onForceUpdate?: () => void;
}

export interface AppState {
  config: AppConfig;
  platforms: Map<string, PlatformStatus>;
  sessions: Map<string, SessionInfo>;
  logs: LogEntry[];
  selectedSessionId: string | null;  // Currently selected session tab
  ready: boolean;
  shuttingDown: boolean;
}
