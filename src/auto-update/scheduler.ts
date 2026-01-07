/**
 * Update scheduler module
 *
 * Handles timing logic for when updates should be applied.
 * Supports multiple modes: idle, quiet, scheduled, ask, immediate.
 */

import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger.js';
import type { AutoUpdateConfig, UpdateInfo } from './types.js';
import { isInScheduledWindow } from './types.js';

const log = createLogger('scheduler');

/** Session activity info for scheduling decisions */
export interface SessionActivityInfo {
  /** Number of active sessions */
  activeSessionCount: number;
  /** Time of last activity across all sessions (null if no sessions) */
  lastActivityAt: Date | null;
  /** Whether any session is currently processing */
  anySessionBusy: boolean;
}

/** Callback to get current session activity */
export type GetSessionActivityFn = () => SessionActivityInfo;

/** Callback to post ask messages to threads */
export type PostAskMessageFn = (threadIds: string[], version: string) => Promise<void>;

/** Callback to get active thread IDs */
export type GetActiveThreadIdsFn = () => string[];

/**
 * UpdateScheduler - Determines when to apply updates
 *
 * Events:
 * - 'ready': Emitted when it's time to apply the update
 * - 'countdown': Emitted with seconds remaining until restart
 * - 'deferred': Emitted when update is deferred
 */
export class UpdateScheduler extends EventEmitter {
  private config: AutoUpdateConfig;
  private getSessionActivity: GetSessionActivityFn;
  private getActiveThreadIds: GetActiveThreadIdsFn;
  private postAskMessage: PostAskMessageFn;

  private pendingUpdate: UpdateInfo | null = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private idleStartTime: Date | null = null;
  private scheduledRestartAt: Date | null = null;

  // Ask mode state
  private askApprovals: Map<string, boolean> = new Map();
  private askStartTime: Date | null = null;

  constructor(
    config: AutoUpdateConfig,
    getSessionActivity: GetSessionActivityFn,
    getActiveThreadIds: GetActiveThreadIdsFn,
    postAskMessage: PostAskMessageFn
  ) {
    super();
    this.config = config;
    this.getSessionActivity = getSessionActivity;
    this.getActiveThreadIds = getActiveThreadIds;
    this.postAskMessage = postAskMessage;
  }

  /**
   * Schedule an update for the right time based on mode.
   */
  scheduleUpdate(updateInfo: UpdateInfo): void {
    this.pendingUpdate = updateInfo;

    // Handle immediate mode - just emit ready right away
    if (this.config.autoRestartMode === 'immediate') {
      log.info('Immediate mode: triggering update now');
      this.emit('ready', updateInfo);
      return;
    }

    // Start checking for the right time
    this.startChecking();
  }

  /**
   * Cancel a scheduled update.
   */
  cancelSchedule(): void {
    this.stopChecking();
    this.pendingUpdate = null;
    this.idleStartTime = null;
    this.scheduledRestartAt = null;
    this.askApprovals.clear();
    this.askStartTime = null;
    log.debug('Update schedule cancelled');
  }

  /**
   * Defer the update by a specified number of minutes.
   */
  deferUpdate(minutes: number): Date {
    const deferUntil = new Date(Date.now() + minutes * 60 * 1000);
    this.scheduledRestartAt = null;
    this.idleStartTime = null;
    this.emit('deferred', deferUntil);
    log.info(`Update deferred until ${deferUntil.toLocaleTimeString()}`);
    return deferUntil;
  }

  /**
   * Record an approval/denial from a thread (for 'ask' mode).
   */
  recordAskResponse(threadId: string, approved: boolean): void {
    this.askApprovals.set(threadId, approved);
    log.debug(`Thread ${threadId.substring(0, 8)} ${approved ? 'approved' : 'denied'} update`);
    // Check condition immediately after recording
    this.checkAskCondition();
  }

  /**
   * Get the scheduled restart time (if countdown is active).
   */
  getScheduledRestartAt(): Date | null {
    return this.scheduledRestartAt;
  }

  /**
   * Get pending update info.
   */
  getPendingUpdate(): UpdateInfo | null {
    return this.pendingUpdate;
  }

  /**
   * Update configuration.
   */
  updateConfig(config: AutoUpdateConfig): void {
    this.config = config;
  }

  /**
   * Stop all timers and cleanup.
   */
  stop(): void {
    this.stopChecking();
    this.stopCountdown();
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  private startChecking(): void {
    if (this.checkTimer) return;

    // Check immediately, then every 10 seconds
    this.checkCondition();
    this.checkTimer = setInterval(() => this.checkCondition(), 10000);
    log.debug(`Started checking for ${this.config.autoRestartMode} condition`);
  }

  private stopChecking(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  private checkCondition(): void {
    if (!this.pendingUpdate) return;

    switch (this.config.autoRestartMode) {
      case 'idle':
        this.checkIdleCondition();
        break;
      case 'quiet':
        this.checkQuietCondition();
        break;
      case 'scheduled':
        this.checkScheduledCondition();
        break;
      case 'ask':
        this.checkAskCondition();
        break;
    }
  }

  private checkIdleCondition(): void {
    const activity = this.getSessionActivity();

    if (activity.activeSessionCount === 0) {
      // No active sessions - start idle timer if not started
      if (!this.idleStartTime) {
        this.idleStartTime = new Date();
        log.debug('No active sessions, starting idle timer');
      }

      // Check if we've been idle long enough
      const idleMs = Date.now() - this.idleStartTime.getTime();
      const requiredMs = this.config.idleTimeoutMinutes * 60 * 1000;

      if (idleMs >= requiredMs) {
        log.info(`Idle for ${this.config.idleTimeoutMinutes} minutes, triggering update`);
        this.triggerCountdown();
      }
    } else {
      // Sessions are active, reset idle timer
      if (this.idleStartTime) {
        log.debug('Sessions became active, resetting idle timer');
        this.idleStartTime = null;
      }
    }
  }

  private checkQuietCondition(): void {
    const activity = this.getSessionActivity();

    // Even with active sessions, check if they've been inactive
    if (activity.lastActivityAt) {
      const quietMs = Date.now() - activity.lastActivityAt.getTime();
      const requiredMs = this.config.quietTimeoutMinutes * 60 * 1000;

      if (quietMs >= requiredMs && !activity.anySessionBusy) {
        log.info(`Sessions quiet for ${this.config.quietTimeoutMinutes} minutes, triggering update`);
        this.triggerCountdown();
      }
    } else if (activity.activeSessionCount === 0) {
      // No sessions at all, same as idle
      if (!this.idleStartTime) {
        this.idleStartTime = new Date();
      }

      const idleMs = Date.now() - this.idleStartTime.getTime();
      const requiredMs = this.config.quietTimeoutMinutes * 60 * 1000;

      if (idleMs >= requiredMs) {
        log.info('No sessions and quiet timeout reached, triggering update');
        this.triggerCountdown();
      }
    }
  }

  private checkScheduledCondition(): void {
    // Only update during the scheduled window
    if (!isInScheduledWindow(this.config.scheduledWindow)) {
      return;
    }

    // Within window - also require idle/quiet condition
    const activity = this.getSessionActivity();

    if (activity.activeSessionCount === 0) {
      log.info('Within scheduled window and no active sessions, triggering update');
      this.triggerCountdown();
    } else if (activity.lastActivityAt) {
      const quietMs = Date.now() - activity.lastActivityAt.getTime();
      const requiredMs = this.config.idleTimeoutMinutes * 60 * 1000;

      if (quietMs >= requiredMs && !activity.anySessionBusy) {
        log.info('Within scheduled window and sessions quiet, triggering update');
        this.triggerCountdown();
      }
    }
  }

  private checkAskCondition(): void {
    const threadIds = this.getActiveThreadIds();

    // If no active threads, proceed with update
    if (threadIds.length === 0) {
      log.info('No active threads, proceeding with update');
      this.triggerCountdown();
      return;
    }

    // Post ask message if not already done
    if (!this.askStartTime && this.pendingUpdate) {
      this.askStartTime = new Date();
      this.postAskMessage(threadIds, this.pendingUpdate.latestVersion).catch(err => {
        log.warn(`Failed to post ask message: ${err}`);
      });
      return;
    }

    // Check if we have majority approval
    let approvals = 0;
    let denials = 0;
    for (const approved of this.askApprovals.values()) {
      if (approved) approvals++;
      else denials++;
    }

    // Majority approval
    if (approvals > threadIds.length / 2) {
      log.info(`Majority approved (${approvals}/${threadIds.length}), triggering update`);
      this.triggerCountdown();
      return;
    }

    // Majority denial
    if (denials > threadIds.length / 2) {
      log.info(`Majority denied (${denials}/${threadIds.length}), deferring update`);
      this.deferUpdate(60); // Defer for 1 hour
      return;
    }

    // Check for timeout
    if (this.askStartTime) {
      const elapsedMs = Date.now() - this.askStartTime.getTime();
      const timeoutMs = this.config.askTimeoutMinutes * 60 * 1000;

      if (elapsedMs >= timeoutMs) {
        log.info(`Ask timeout reached (${this.config.askTimeoutMinutes} min), triggering update`);
        this.triggerCountdown();
      }
    }
  }

  private triggerCountdown(): void {
    if (!this.pendingUpdate) return;

    this.stopChecking();

    // Start 60-second countdown
    this.scheduledRestartAt = new Date(Date.now() + 60000);
    let secondsRemaining = 60;

    this.emit('countdown', secondsRemaining);

    this.countdownTimer = setInterval(() => {
      secondsRemaining--;
      this.emit('countdown', secondsRemaining);

      if (secondsRemaining <= 0) {
        this.stopCountdown();
        this.emit('ready', this.pendingUpdate);
      }
    }, 1000);

    log.info('Update countdown started (60 seconds)');
  }

  private stopCountdown(): void {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }
}
