/**
 * HeadlessProvider - Console-only UI implementation
 *
 * Provides a simple logging-based interface for non-interactive environments.
 * All output is written to stdout with timestamps.
 */
import type {
  SessionInfo,
  LogEntry,
  PlatformStatus,
  UpdatePanelState,
  ToggleState,
} from '../types.js';
import type { UIProvider, StartUIOptions } from './types.js';

export class HeadlessProvider implements UIProvider {
  private options: StartUIOptions;
  private sessions: Map<string, SessionInfo> = new Map();
  private platforms: Map<string, PlatformStatus> = new Map();
  private toggles: ToggleState;
  private exitPromiseResolve: (() => void) | null = null;
  private exitPromise: Promise<void>;

  constructor(options: StartUIOptions) {
    this.options = options;

    // Initialize toggles from config
    this.toggles = {
      debugMode: process.env.DEBUG === '1',
      skipPermissions: options.config.skipPermissions,
      chromeEnabled: options.config.chromeEnabled,
      keepAliveEnabled: options.config.keepAliveEnabled,
      updateModalVisible: false,
      logsFocused: false,
    };

    // Create a promise that resolves when stop() is called
    this.exitPromise = new Promise((resolve) => {
      this.exitPromiseResolve = resolve;
    });
  }

  private formatTimestamp(): string {
    const now = new Date();
    return now.toTimeString().slice(0, 8); // HH:MM:SS
  }

  private log(component: string, message: string, level: 'debug' | 'info' | 'warn' | 'error' = 'info'): void {
    // Skip debug logs unless debug mode is enabled
    if (level === 'debug' && !this.toggles.debugMode) {
      return;
    }

    const timestamp = this.formatTimestamp();
    const levelPrefix = level === 'error' ? 'ERROR' : level === 'warn' ? 'WARN' : level === 'debug' ? 'DEBUG' : 'INFO';
    console.log(`[${timestamp}] [${levelPrefix}] [${component}] ${message}`);
  }

  async start(): Promise<void> {
    const { config } = this.options;
    this.log('HeadlessProvider', `claude-threads v${config.version} starting in headless mode`);
    this.log('HeadlessProvider', `Working directory: ${config.workingDir}`);
    this.log('HeadlessProvider', `Claude CLI: ${config.claudeVersion}`);
  }

  async stop(): Promise<void> {
    this.log('HeadlessProvider', 'Stopped');
    if (this.exitPromiseResolve) {
      this.exitPromiseResolve();
    }
  }

  async waitUntilExit(): Promise<void> {
    return this.exitPromise;
  }

  setReady(): void {
    this.log('HeadlessProvider', 'Bot ready and listening for messages');
  }

  setShuttingDown(): void {
    this.log('HeadlessProvider', 'Shutting down...');
  }

  addSession(session: SessionInfo): void {
    this.sessions.set(session.id, session);
    const title = session.title || session.displayName || session.threadId;
    const platform = session.platformDisplayName || session.platformType || 'unknown';
    this.log('Session', `Started: ${title} (${session.id}) on ${platform} by ${session.startedBy}`);
  }

  updateSession(sessionId: string, updates: Partial<SessionInfo>): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const oldStatus = session.status;
    const updatedSession = { ...session, ...updates };
    this.sessions.set(sessionId, updatedSession);

    // Log significant status changes
    if (updates.status && updates.status !== oldStatus) {
      const title = updatedSession.title || updatedSession.displayName || updatedSession.threadId;
      this.log('Session', `${title} (${sessionId}): ${oldStatus} -> ${updates.status}`);
    }

    // Log typing indicator changes in debug mode
    if (updates.isTyping !== undefined && this.toggles.debugMode) {
      const title = updatedSession.title || updatedSession.displayName || updatedSession.threadId;
      this.log('Session', `${title}: typing=${updates.isTyping}`, 'debug');
    }
  }

  removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      const title = session.title || session.displayName || session.threadId;
      this.log('Session', `Ended: ${title} (${sessionId})`);
      this.sessions.delete(sessionId);
    }
  }

  addLog(entry: Omit<LogEntry, 'id' | 'timestamp'>): void {
    this.log(entry.component, entry.message, entry.level);
  }

  setPlatformStatus(platformId: string, status: Partial<PlatformStatus>): void {
    const existing = this.platforms.get(platformId);
    const updated = existing ? { ...existing, ...status } : (status as PlatformStatus);
    this.platforms.set(platformId, updated);

    // Log connection status changes
    if (status.connected !== undefined) {
      const name = updated.displayName || platformId;
      this.log('Platform', `${name}: ${status.connected ? 'connected' : 'disconnected'}`);
    }

    if (status.reconnecting !== undefined && status.reconnecting) {
      const name = updated.displayName || platformId;
      this.log('Platform', `${name}: reconnecting (attempt ${status.reconnectAttempts || 1})`, 'warn');
    }

    if (status.enabled !== undefined) {
      const name = updated.displayName || platformId;
      this.log('Platform', `${name}: ${status.enabled ? 'enabled' : 'disabled'}`);
    }
  }

  setUpdateState(state: UpdatePanelState): void {
    switch (state.status) {
      case 'available':
        this.log('Update', `Update available: v${state.currentVersion} -> v${state.latestVersion}`);
        break;
      case 'scheduled':
        if (state.scheduledRestartAt) {
          this.log('Update', `Update scheduled for ${state.scheduledRestartAt.toLocaleTimeString()}`);
        }
        break;
      case 'installing':
        this.log('Update', 'Installing update...');
        break;
      case 'pending_restart':
        this.log('Update', 'Update installed, pending restart');
        break;
      case 'failed':
        this.log('Update', `Update failed: ${state.errorMessage || 'Unknown error'}`, 'error');
        break;
      case 'deferred':
        if (state.deferredUntil) {
          this.log('Update', `Update deferred until ${state.deferredUntil.toLocaleTimeString()}`);
        }
        break;
    }
  }

  getToggles(): ToggleState {
    return { ...this.toggles };
  }
}
