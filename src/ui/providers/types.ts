/**
 * UI Provider types - abstraction layer for different UI implementations
 *
 * This allows the bot to run with:
 * - InkProvider: Full TUI with Ink (default)
 * - HeadlessProvider: Console-only mode (logs to stdout)
 */

import type {
  SessionInfo,
  LogEntry,
  PlatformStatus,
  UpdatePanelState,
  ToggleState,
  ToggleCallbacks,
  AppConfig,
} from '../types.js';

/**
 * Core UI operations that all providers must implement
 */
export interface UIOperations {
  /** Mark the UI as ready (startup complete) */
  setReady(): void;

  /** Mark the UI as shutting down */
  setShuttingDown(): void;

  /** Add a new session to the UI */
  addSession(session: SessionInfo): void;

  /** Update an existing session */
  updateSession(sessionId: string, updates: Partial<SessionInfo>): void;

  /** Remove a session from the UI */
  removeSession(sessionId: string): void;

  /** Add a log entry */
  addLog(entry: Omit<LogEntry, 'id' | 'timestamp'>): void;

  /** Update platform status */
  setPlatformStatus(platformId: string, status: Partial<PlatformStatus>): void;

  /** Update auto-update state */
  setUpdateState(state: UpdatePanelState): void;

  /** Get current toggle state */
  getToggles(): ToggleState;
}

/**
 * UI Provider interface - implemented by both Ink and Headless providers
 */
export interface UIProvider extends UIOperations {
  /** Start the UI (renders in Ink mode, initializes in headless mode) */
  start(): Promise<void>;

  /** Stop the UI and cleanup resources */
  stop(): Promise<void>;

  /** Wait for the UI to exit (used for graceful shutdown) */
  waitUntilExit(): Promise<void>;
}

/**
 * Options for starting the UI
 */
export interface StartUIOptions {
  /** App configuration */
  config: AppConfig;

  /** Run in headless mode (no interactive UI) */
  headless?: boolean;

  /** Callback when user requests quit (Ctrl+C, q key) */
  onQuit?: () => void;

  /** Callbacks for toggle changes */
  toggleCallbacks?: ToggleCallbacks;
}
