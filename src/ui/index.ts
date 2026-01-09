/**
 * UI entry point - exports startUI() function
 */
import { createUIProvider, type UIProvider, type StartUIOptions } from './providers/index.js';
import type { AppConfig, SessionInfo, LogEntry, PlatformStatus, ToggleState, ToggleCallbacks, UpdatePanelState } from './types.js';

export type { UIProvider, StartUIOptions, AppConfig, SessionInfo, LogEntry, PlatformStatus, ToggleState, ToggleCallbacks, UpdatePanelState };

// Re-export UIInstance as an alias for backward compatibility
export type UIInstance = UIProvider;

export async function startUI(options: StartUIOptions): Promise<UIProvider> {
  return createUIProvider(options);
}
