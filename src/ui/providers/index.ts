/**
 * UI Providers - factory and exports
 *
 * Provides both InkProvider (full TUI) and HeadlessProvider (console-only)
 * implementations of the UIProvider interface.
 */
export * from './types.js';
export { InkProvider } from './ink-provider.js';
export { HeadlessProvider } from './headless-provider.js';

import type { UIProvider, StartUIOptions } from './types.js';
import { InkProvider } from './ink-provider.js';
import { HeadlessProvider } from './headless-provider.js';

/**
 * Create a UI provider based on options
 *
 * @param options - Configuration options including headless mode flag
 * @returns A started UIProvider instance
 */
export async function createUIProvider(options: StartUIOptions): Promise<UIProvider> {
  if (options.headless) {
    const provider = new HeadlessProvider(options);
    await provider.start();
    return provider;
  }

  const provider = new InkProvider(options);
  await provider.start();
  return provider;
}
