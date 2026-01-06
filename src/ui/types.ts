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
 * Runtime toggle state - can be changed via keyboard shortcuts
 */
export interface ToggleState {
  debugMode: boolean;
  skipPermissions: boolean;  // Default for new sessions
  chromeEnabled: boolean;    // Default for new sessions
  keepAliveEnabled: boolean;
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
}

export interface AppState {
  config: AppConfig;
  platforms: Map<string, PlatformStatus>;
  sessions: Map<string, SessionInfo>;
  logs: LogEntry[];
  expandedSessions: Set<string>;
  ready: boolean;
  shuttingDown: boolean;
}

export interface UIInstance {
  setReady: () => void;
  setShuttingDown: () => void;
  addSession: (session: SessionInfo) => void;
  updateSession: (sessionId: string, updates: Partial<SessionInfo>) => void;
  removeSession: (sessionId: string) => void;
  addLog: (entry: Omit<LogEntry, 'id' | 'timestamp'>) => void;
  setPlatformStatus: (platformId: string, status: Partial<PlatformStatus>) => void;
  waitUntilExit: () => Promise<void>;
  // Toggle state getters (for main logic to read current values)
  getToggles: () => ToggleState;
}
