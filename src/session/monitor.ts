/**
 * Session Monitor
 *
 * Periodically checks for idle sessions that need to be timed out
 * and refreshes sticky messages to keep relative times current.
 */

import { createLogger } from '../utils/logger.js';
import * as lifecycle from './lifecycle.js';
import type { SessionContext } from './context.js';

const log = createLogger('monitor');

/** Default interval: 1 minute */
const DEFAULT_INTERVAL_MS = 60 * 1000;

export interface SessionMonitorOptions {
  /** Interval between checks in ms (default: 1 minute) */
  intervalMs?: number;
  /** Session timeout in ms */
  sessionTimeoutMs: number;
  /** Warning before timeout in ms */
  sessionWarningMs: number;
  /** Get the session context */
  getContext: () => SessionContext;
  /** Get active session count */
  getSessionCount: () => number;
  /** Update sticky message */
  updateStickyMessage: () => Promise<void>;
}

/**
 * SessionMonitor - Monitors sessions for idle timeout and refreshes UI.
 *
 * Responsibilities:
 * - Check for idle sessions that should be timed out
 * - Refresh sticky messages to keep relative times current
 *
 * Start with `start()`, stop with `stop()`.
 */
export class SessionMonitor {
  private readonly intervalMs: number;
  private readonly sessionTimeoutMs: number;
  private readonly sessionWarningMs: number;
  private readonly getContext: () => SessionContext;
  private readonly getSessionCount: () => number;
  private readonly updateStickyMessage: () => Promise<void>;

  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  constructor(options: SessionMonitorOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.sessionTimeoutMs = options.sessionTimeoutMs;
    this.sessionWarningMs = options.sessionWarningMs;
    this.getContext = options.getContext;
    this.getSessionCount = options.getSessionCount;
    this.updateStickyMessage = options.updateStickyMessage;
  }

  /**
   * Start the session monitor.
   */
  start(): void {
    if (this.isRunning) {
      log.debug('Session monitor already running');
      return;
    }

    this.isRunning = true;
    log.debug(`Session monitor started (interval: ${this.intervalMs / 1000}s)`);

    this.timer = setInterval(() => {
      this.runCheck().catch(err => {
        log.error(`Error during session monitoring: ${err}`);
      });
    }, this.intervalMs);
  }

  /**
   * Stop the session monitor.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    log.debug('Session monitor stopped');
  }

  /**
   * Run a single check cycle.
   */
  private async runCheck(): Promise<void> {
    // Check for idle sessions that need to be timed out
    await lifecycle.cleanupIdleSessions(
      this.sessionTimeoutMs,
      this.sessionWarningMs,
      this.getContext()
    );

    // Refresh sticky message to keep relative times current (only if there are active sessions)
    if (this.getSessionCount() > 0) {
      await this.updateStickyMessage();
    }
  }
}
