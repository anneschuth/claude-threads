/**
 * UI entry point - exports startUI() function
 */
import React from 'react';
import { render } from 'ink';
import { App, type AppHandlers } from './App.js';
import type { AppConfig, UIInstance, SessionInfo, LogEntry, PlatformStatus } from './types.js';

export type { UIInstance, AppConfig, SessionInfo, LogEntry, PlatformStatus };

export async function startUI(config: AppConfig): Promise<UIInstance> {
  // Check for TTY - fail fast if not interactive
  if (!process.stdout.isTTY) {
    throw new Error('claude-threads requires an interactive terminal (TTY)');
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
    })
  );

  // Wait for handlers to be ready
  const handlers = await handlersPromise;

  // Return the UI instance
  return {
    setReady: handlers.setReady,
    addSession: handlers.addSession,
    updateSession: handlers.updateSession,
    removeSession: handlers.removeSession,
    addLog: handlers.addLog,
    setPlatformStatus: handlers.setPlatformStatus,
    waitUntilExit,
  };
}
