/**
 * InkProvider - Full TUI implementation using Ink
 *
 * Wraps the existing App component and provides the UIProvider interface.
 * This is the default UI mode for interactive terminals.
 */
import React from 'react';
import { render } from 'ink';
import { App, type AppHandlers } from '../App.js';
import type {
  SessionInfo,
  LogEntry,
  PlatformStatus,
  UpdatePanelState,
  ToggleState,
} from '../types.js';
import type { UIProvider, StartUIOptions } from './types.js';

export class InkProvider implements UIProvider {
  private options: StartUIOptions;
  private handlers: AppHandlers | null = null;
  private waitUntilExitFn: (() => Promise<void>) | null = null;
  private onResize: (() => void) | null = null;
  private exitPromiseResolve: (() => void) | null = null;
  private exitPromise: Promise<void>;

  constructor(options: StartUIOptions) {
    this.options = options;
    // Create a promise that resolves when the UI exits
    this.exitPromise = new Promise((resolve) => {
      this.exitPromiseResolve = resolve;
    });
  }

  async start(): Promise<void> {
    const { config, onQuit, toggleCallbacks } = this.options;

    // Check for TTY - fail fast if not interactive
    if (!process.stdout.isTTY) {
      throw new Error('InkProvider requires an interactive terminal (TTY). Use HeadlessProvider for non-TTY environments.');
    }

    // Promise that resolves when handlers are ready
    let resolveHandlers: (handlers: AppHandlers) => void;
    const handlersPromise = new Promise<AppHandlers>((resolve) => {
      resolveHandlers = resolve;
    });

    // Render the app
    const { waitUntilExit } = render(
      React.createElement(App, {
        config,
        onStateReady: (handlers: AppHandlers) => resolveHandlers(handlers),
        onResizeReady: (handler: () => void) => {
          this.onResize = handler;
        },
        onQuit,
        toggleCallbacks,
      }),
      {
        // Hide the cursor - we only use keyboard shortcuts, not text input
        patchConsole: false,
        // Disable default Ctrl+C handling so we can show "Shutting down..." first
        exitOnCtrlC: false,
      }
    );

    this.waitUntilExitFn = waitUntilExit;

    // Hide cursor explicitly
    process.stdout.write('\x1b[?25l');

    // Restore cursor on exit
    const restoreCursor = () => process.stdout.write('\x1b[?25h');
    process.on('exit', restoreCursor);

    // Handle terminal resize - clear screen and trigger re-render
    const handleResize = () => {
      // Clear the screen to remove artifacts
      process.stdout.write('\x1b[2J\x1b[H');
      // Trigger state update in App to force re-render
      if (this.onResize) this.onResize();
    };
    process.on('SIGWINCH', handleResize);

    // Wait for handlers to be ready
    this.handlers = await handlersPromise;
  }

  async stop(): Promise<void> {
    // Restore cursor visibility
    process.stdout.write('\x1b[?25h');

    // Resolve the exit promise
    if (this.exitPromiseResolve) {
      this.exitPromiseResolve();
    }
  }

  async waitUntilExit(): Promise<void> {
    if (this.waitUntilExitFn) {
      return this.waitUntilExitFn();
    }
    return this.exitPromise;
  }

  // UIOperations implementation - delegate to handlers

  setReady(): void {
    if (!this.handlers) {
      throw new Error('InkProvider not started. Call start() first.');
    }
    this.handlers.setReady();
  }

  setShuttingDown(): void {
    if (!this.handlers) {
      throw new Error('InkProvider not started. Call start() first.');
    }
    this.handlers.setShuttingDown();
  }

  addSession(session: SessionInfo): void {
    if (!this.handlers) {
      throw new Error('InkProvider not started. Call start() first.');
    }
    this.handlers.addSession(session);
  }

  updateSession(sessionId: string, updates: Partial<SessionInfo>): void {
    if (!this.handlers) {
      throw new Error('InkProvider not started. Call start() first.');
    }
    this.handlers.updateSession(sessionId, updates);
  }

  removeSession(sessionId: string): void {
    if (!this.handlers) {
      throw new Error('InkProvider not started. Call start() first.');
    }
    this.handlers.removeSession(sessionId);
  }

  addLog(entry: Omit<LogEntry, 'id' | 'timestamp'>): void {
    if (!this.handlers) {
      throw new Error('InkProvider not started. Call start() first.');
    }
    this.handlers.addLog(entry);
  }

  setPlatformStatus(platformId: string, status: Partial<PlatformStatus>): void {
    if (!this.handlers) {
      throw new Error('InkProvider not started. Call start() first.');
    }
    this.handlers.setPlatformStatus(platformId, status);
  }

  setUpdateState(state: UpdatePanelState): void {
    if (!this.handlers) {
      throw new Error('InkProvider not started. Call start() first.');
    }
    this.handlers.setUpdateState(state);
  }

  getToggles(): ToggleState {
    if (!this.handlers) {
      throw new Error('InkProvider not started. Call start() first.');
    }
    return this.handlers.getToggles();
  }
}
