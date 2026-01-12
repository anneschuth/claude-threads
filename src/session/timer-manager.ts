/**
 * Timer management for sessions
 *
 * Centralizes timer handling for sessions, making cleanup logic cleaner and more testable.
 */

/**
 * Timer references for a session.
 * All timer fields are nullable to indicate "not running" state.
 */
export interface SessionTimers {
  /** Timer for batched message updates (debounce) */
  updateTimer: ReturnType<typeof setTimeout> | null;
  /** Interval for sending typing indicators */
  typingTimer: ReturnType<typeof setInterval> | null;
  /** Interval for periodic status bar refreshes */
  statusBarTimer: ReturnType<typeof setInterval> | null;
}

/**
 * Create a new SessionTimers object with all timers cleared.
 */
export function createSessionTimers(): SessionTimers {
  return {
    updateTimer: null,
    typingTimer: null,
    statusBarTimer: null,
  };
}

/**
 * Clear all timers in a SessionTimers object.
 * Safe to call even if timers are already null.
 */
export function clearAllTimers(timers: SessionTimers): void {
  if (timers.updateTimer) {
    clearTimeout(timers.updateTimer);
    timers.updateTimer = null;
  }
  if (timers.typingTimer) {
    clearInterval(timers.typingTimer);
    timers.typingTimer = null;
  }
  if (timers.statusBarTimer) {
    clearInterval(timers.statusBarTimer);
    timers.statusBarTimer = null;
  }
}
