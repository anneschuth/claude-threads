/**
 * Pure helpers for cycling through permission modes — used by the UI toggle
 * (keyboard `[p]` rotates default → auto → bypass → default) and by any
 * other place that wants to advance/step through the modes deterministically.
 *
 * Kept in its own file so the cycle order is a single source of truth and
 * can be unit-tested without importing the Ink UI tree.
 */

import type { PermissionMode } from './types.js';

/** Order in which the keyboard toggle cycles. */
export const PERMISSION_MODE_CYCLE: readonly PermissionMode[] = [
  'default',
  'auto',
  'bypass',
] as const;

/**
 * Return the next mode in the cycle, wrapping back to the start after the last.
 * Unknown inputs (defensive; should not happen at the type level) fall back
 * to the first cycle entry.
 */
export function nextPermissionMode(current: PermissionMode): PermissionMode {
  const idx = PERMISSION_MODE_CYCLE.indexOf(current);
  if (idx === -1) return PERMISSION_MODE_CYCLE[0];
  return PERMISSION_MODE_CYCLE[(idx + 1) % PERMISSION_MODE_CYCLE.length];
}
