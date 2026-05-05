/**
 * Auto-update manager module
 *
 * Orchestrates the entire auto-update flow:
 * - Periodically checks for updates
 * - Schedules updates based on configured mode
 * - Installs updates and triggers restart
 */

import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger.js';
import { VERSION } from '../version.js';
import { UpdateChecker } from './checker.js';
import { UpdateScheduler, type SessionActivityInfo } from './scheduler.js';
import { UpdateInstaller, getRollbackInstructions } from './installer.js';
import type {
  AutoUpdateConfig,
  UpdateInfo,
  UpdateState,
  UpdateStatus,
  AutoUpdateEvents,
} from './types.js';
import { RESTART_EXIT_CODE, mergeAutoUpdateConfig } from './types.js';
import { decideRespawn, resolveClaudeThreadsBin, spawnReplacement } from './respawn.js';
import type { PlatformFormatter } from '../platform/formatter.js';

/** Message builder function that takes a formatter and returns the formatted message */
export type MessageBuilder = (formatter: PlatformFormatter) => string;

const log = createLogger('updater');

/** Callbacks for integrating with the session manager and chat platforms */
export interface AutoUpdateCallbacks {
  /** Get current session activity (for scheduling decisions) */
  getSessionActivity: () => SessionActivityInfo;

  /** Get active thread IDs (for ask mode) */
  getActiveThreadIds: () => string[];

  /** Post update notification to all active threads */
  broadcastUpdate: (messageBuilder: MessageBuilder) => Promise<void>;

  /** Post ask message to specific threads */
  postAskMessage: (threadIds: string[], version: string) => Promise<void>;

  /** Trigger UI update (sticky message, status bar, etc.) */
  refreshUI: () => Promise<void>;

  /** Prepare for restart (persist sessions, disconnect platforms) */
  prepareForRestart: () => Promise<void>;
}

/**
 * AutoUpdateManager - Main orchestrator for auto-updates
 *
 * Events:
 * - 'update:available': Update detected
 * - 'update:status': Status changed (status, message?)
 * - 'update:countdown': Restart countdown (secondsRemaining)
 * - 'update:restart': Restart imminent (newVersion)
 * - 'update:failed': Installation failed (error)
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class AutoUpdateManager extends EventEmitter {
  private config: AutoUpdateConfig;
  private callbacks: AutoUpdateCallbacks;
  private checker: UpdateChecker;
  private scheduler: UpdateScheduler;
  private installer: UpdateInstaller;

  private state: UpdateState = {
    status: 'idle',
  };

  // Track deferred until time
  private deferredUntil: Date | null = null;

  constructor(
    configOverride: Partial<AutoUpdateConfig> | undefined,
    callbacks: AutoUpdateCallbacks
  ) {
    super();

    this.config = mergeAutoUpdateConfig(configOverride);
    this.callbacks = callbacks;

    // Initialize components
    this.checker = new UpdateChecker(this.config);
    this.scheduler = new UpdateScheduler(
      this.config,
      callbacks.getSessionActivity,
      callbacks.getActiveThreadIds,
      callbacks.postAskMessage
    );
    this.installer = new UpdateInstaller();

    // Wire up events
    this.setupEventHandlers();
  }

  /**
   * Start the auto-update system.
   */
  start(): void {
    if (!this.config.enabled) {
      log.info('Auto-update is disabled');
      return;
    }

    // Check if we just updated
    const updateResult = this.installer.checkJustUpdated();
    if (updateResult) {
      log.info(`🎉 Updated from v${updateResult.previousVersion} to v${updateResult.currentVersion}`);
      // Broadcast the good news
      this.callbacks.broadcastUpdate((fmt) =>
        `🎉 ${fmt.formatBold('Bot updated')} from v${updateResult.previousVersion} to v${updateResult.currentVersion}`
      ).catch(err => {
        log.warn(`Failed to broadcast update notification: ${err}`);
      });
    }

    // Start the checker
    this.checker.start();

    log.info(`🔄 Auto-update manager started (mode: ${this.config.autoRestartMode})`);
  }

  /**
   * Stop the auto-update system.
   */
  stop(): void {
    this.checker.stop();
    this.scheduler.stop();
    log.debug('Auto-update manager stopped');
  }

  /**
   * Get current update state (for UI display).
   */
  getState(): UpdateState {
    return { ...this.state };
  }

  /**
   * Get the current config.
   */
  getConfig(): AutoUpdateConfig {
    return { ...this.config };
  }

  /**
   * Manually trigger an update check.
   */
  async checkNow(): Promise<UpdateInfo | null> {
    return this.checker.check();
  }

  /**
   * Force an immediate update (bypass scheduling).
   */
  async forceUpdate(): Promise<void> {
    const updateInfo = this.state.updateInfo || await this.checker.check();
    if (!updateInfo) {
      log.info('No update available');
      return;
    }

    log.info('Forcing immediate update');
    await this.performUpdate(updateInfo);
  }

  /**
   * Defer the current update by N minutes.
   */
  deferUpdate(minutes: number = 60): void {
    this.deferredUntil = this.scheduler.deferUpdate(minutes);
    this.updateStatus('deferred', `Deferred until ${this.deferredUntil.toLocaleTimeString()}`);
  }

  /**
   * Record an ask mode response from a thread.
   */
  recordAskResponse(threadId: string, approved: boolean): void {
    this.scheduler.recordAskResponse(threadId, approved);
  }

  /**
   * Check if updates are enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Check if an update is available.
   */
  hasUpdate(): boolean {
    return this.state.updateInfo?.available ?? false;
  }

  /**
   * Get the pending update info.
   */
  getUpdateInfo(): UpdateInfo | undefined {
    return this.state.updateInfo;
  }

  /**
   * Get the scheduled restart time (if any).
   */
  getScheduledRestartAt(): Date | null {
    return this.scheduler.getScheduledRestartAt();
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  private setupEventHandlers(): void {
    // Update detected
    this.checker.on('update', (info: UpdateInfo) => {
      this.state.updateInfo = info;
      this.updateStatus('available');
      this.emit('update:available', info);

      // Refresh UI to show update badge
      this.callbacks.refreshUI().catch(() => {});

      // Schedule the update based on mode
      this.scheduler.scheduleUpdate(info);
    });

    // Countdown started
    this.scheduler.on('countdown', (seconds: number) => {
      this.emit('update:countdown', seconds);

      // Broadcast countdown at key intervals
      if (seconds === 60 || seconds === 30 || seconds === 10) {
        const latestVersion = this.state.updateInfo?.latestVersion;
        this.callbacks.broadcastUpdate((fmt) =>
          `⏳ ${fmt.formatBold(`Restarting in ${seconds} seconds`)} for update to v${latestVersion}`
        ).catch(() => {});
      }
    });

    // Ready to update
    this.scheduler.on('ready', async (info: UpdateInfo) => {
      await this.performUpdate(info);
    });

    // Update deferred
    this.scheduler.on('deferred', (until: Date) => {
      this.deferredUntil = until;
      this.updateStatus('deferred');
    });
  }

  private async performUpdate(updateInfo: UpdateInfo): Promise<void> {
    this.updateStatus('installing');

    // Broadcast installation start
    await this.callbacks.broadcastUpdate((fmt) =>
      `📦 ${fmt.formatBold('Installing update')} v${updateInfo.latestVersion}...`
    ).catch(() => {});

    // Perform installation
    const result = await this.installer.install(updateInfo);

    if (result.success) {
      this.updateStatus('pending_restart');
      this.emit('update:restart', updateInfo.latestVersion);

      // Decide the restart strategy BEFORE telling the user what's about
      // to happen. The success message should not promise auto-resumption
      // if we know we can't deliver it (e.g. self-respawn case where the
      // binary isn't on PATH).
      const decision = decideRespawn();
      const binPath = decision.kind === 'self-respawn' ? resolveClaudeThreadsBin() : null;
      const canSelfRespawn = decision.kind === 'self-respawn' && binPath !== null;
      const willAutoRestart =
        decision.kind === 'exit-for-supervisor'
          ? decision.supervisor !== 'none-headless'
          : canSelfRespawn;

      // Tailored success message. If we know auto-restart isn't going to
      // happen, tell the user to run claude-threads themselves rather
      // than implying sessions will come back on their own.
      if (willAutoRestart) {
        await this.callbacks.broadcastUpdate((fmt) =>
          `✅ ${fmt.formatBold('Update installed')} to v${updateInfo.latestVersion}. Restarting now, sessions will resume automatically.`
        ).catch(() => {});
      } else {
        await this.callbacks.broadcastUpdate((fmt) =>
          `✅ ${fmt.formatBold('Update installed')} to v${updateInfo.latestVersion}. Could not auto-restart (no supervisor and no claude-threads on PATH); please run ${fmt.formatCode('claude-threads')} to bring the bot back. Sessions are persisted and will resume.`
        ).catch(() => {});
      }

      // Give a moment for the message to be sent
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Prepare for restart (persist sessions, disconnect platforms)
      await this.callbacks.prepareForRestart();

      log.info(`🔄 Restarting for update to v${updateInfo.latestVersion}`);

      // Clear screen for clean restart (in case prepareForRestart didn't)
      process.stdout.write('\x1b[2J\x1b[H');  // Clear screen, cursor to home
      process.stdout.write('\x1b[?25h');       // Restore cursor visibility

      // Hand off to the replacement.
      // - With a known supervisor (bash daemon, systemd, pm2): exit 42 and
      //   let the supervisor's restart handling apply (counters, limits).
      // - Otherwise with a TTY: self-respawn so the interactive user
      //   keeps their UI.
      // See src/auto-update/respawn.ts for the full rationale.
      if (decision.kind === 'self-respawn') {
        if (canSelfRespawn) {
          const ok = spawnReplacement(undefined, binPath);
          if (ok) {
            process.exit(0);
          }
          log.error('Self-respawn launch failed after binary resolution succeeded');
        } else {
          log.error('claude-threads not found on PATH; manual restart required');
        }
        // No supervisor to fall back to: exit 0 cleanly. Exit 42 here
        // would mean "ask my parent to restart me", but our parent is
        // the user's shell and the user already got the manual-restart
        // message above.
        process.exit(0);
      }
      log.debug(`Restart handled by supervisor: ${decision.supervisor}`);
      process.exit(RESTART_EXIT_CODE);
    } else {
      const errorMsg = result.error ?? 'Unknown error';
      this.state.errorMessage = errorMsg;
      this.updateStatus('failed', errorMsg);
      this.emit('update:failed', errorMsg);

      // Broadcast failure
      const errorText = result.error;
      await this.callbacks.broadcastUpdate((fmt) =>
        `❌ ${fmt.formatBold('Update failed')}: ${errorText}\n${getRollbackInstructions(VERSION)}`
      ).catch(() => {});
    }
  }

  private updateStatus(status: UpdateStatus, message?: string): void {
    this.state.status = status;
    if (message) {
      this.state.errorMessage = status === 'failed' ? message : undefined;
    }
    this.emit('update:status', status, message);

    // Refresh UI
    this.callbacks.refreshUI().catch(() => {});
  }
}

// Type-safe event emitter interface
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface AutoUpdateManager {
  on<K extends keyof AutoUpdateEvents>(event: K, listener: AutoUpdateEvents[K]): this;
  emit<K extends keyof AutoUpdateEvents>(event: K, ...args: Parameters<AutoUpdateEvents[K]>): boolean;
}
