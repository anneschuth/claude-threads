/**
 * UI entry point - exports startUI() function
 */
import { createUIProvider, type UIProvider, type StartUIOptions } from './providers/index.js';
import type { AppConfig, SessionInfo, LogEntry, PlatformStatus, ToggleState, ToggleCallbacks, UpdatePanelState } from './types.js';

export type { UIProvider, StartUIOptions, AppConfig, SessionInfo, LogEntry, PlatformStatus, ToggleState, ToggleCallbacks, UpdatePanelState };

export async function startUI(options: StartUIOptions): Promise<UIProvider> {
  return createUIProvider(options);
}
