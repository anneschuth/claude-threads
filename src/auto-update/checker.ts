/**
 * Update checker module
 *
 * Periodically checks for updates using the npm registry.
 * Emits events when updates are detected.
 */

import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger.js';
import { VERSION } from '../version.js';
import type { UpdateInfo, AutoUpdateConfig } from './types.js';

const log = createLogger('checker');

// Package name for npm registry lookup
const PACKAGE_NAME = 'claude-threads';

/**
 * Compare two semver versions.
 * Returns:
 *   1 if a > b
 *   0 if a == b
 *  -1 if a < b
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.replace(/^v/, '').split('.').map(Number);
  const partsB = b.replace(/^v/, '').split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }
  return 0;
}

/**
 * Fetch the latest version from npm registry.
 * Uses the npm registry API directly to avoid spawning processes.
 */
async function fetchLatestVersion(): Promise<string | null> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      log.warn(`Failed to fetch latest version: HTTP ${response.status}`);
      return null;
    }

    const data = await response.json() as { version?: string };
    return data.version ?? null;
  } catch (err) {
    log.warn(`Failed to fetch latest version: ${err}`);
    return null;
  }
}

/**
 * UpdateChecker - Periodically checks for available updates
 *
 * Events:
 * - 'update': Emitted when an update is available (UpdateInfo)
 * - 'check:start': Emitted when a check starts
 * - 'check:complete': Emitted when a check completes
 * - 'check:error': Emitted when a check fails (Error)
 */
export class UpdateChecker extends EventEmitter {
  private config: AutoUpdateConfig;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private lastCheck: Date | null = null;
  private lastUpdateInfo: UpdateInfo | null = null;
  private isChecking = false;

  constructor(config: AutoUpdateConfig) {
    super();
    this.config = config;
  }

  /**
   * Start periodic update checking.
   */
  start(): void {
    if (!this.config.enabled) {
      log.debug('Auto-update disabled, not starting checker');
      return;
    }

    // Do an initial check after a short delay (don't block startup)
    setTimeout(() => {
      this.check().catch(err => {
        log.warn(`Initial update check failed: ${err}`);
      });
    }, 5000);

    // Set up periodic checks
    const intervalMs = this.config.checkIntervalMinutes * 60 * 1000;
    this.checkInterval = setInterval(() => {
      this.check().catch(err => {
        log.warn(`Periodic update check failed: ${err}`);
      });
    }, intervalMs);

    log.info(`🔄 Update checker started (every ${this.config.checkIntervalMinutes} minutes)`);
  }

  /**
   * Stop periodic update checking.
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    log.debug('Update checker stopped');
  }

  /**
   * Manually trigger an update check.
   * Returns the update info if an update is available.
   */
  async check(): Promise<UpdateInfo | null> {
    // Prevent concurrent checks
    if (this.isChecking) {
      log.debug('Check already in progress, skipping');
      return this.lastUpdateInfo;
    }

    this.isChecking = true;
    this.emit('check:start');

    try {
      log.debug('Checking for updates...');

      const latestVersion = await fetchLatestVersion();
      if (!latestVersion) {
        this.emit('check:complete', false);
        return null;
      }

      this.lastCheck = new Date();

      const currentVersion = VERSION;
      const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

      if (hasUpdate) {
        const updateInfo: UpdateInfo = {
          available: true,
          currentVersion,
          latestVersion,
          detectedAt: new Date(),
        };

        // Only emit if this is a new update (not already known)
        if (!this.lastUpdateInfo || this.lastUpdateInfo.latestVersion !== latestVersion) {
          log.info(`🆕 Update available: v${currentVersion} → v${latestVersion}`);
          this.lastUpdateInfo = updateInfo;
          this.emit('update', updateInfo);
        }

        this.emit('check:complete', true);
        return updateInfo;
      }

      log.debug(`Up to date (v${currentVersion})`);
      this.emit('check:complete', false);
      return null;
    } catch (err) {
      log.warn(`Update check failed: ${err}`);
      this.emit('check:error', err);
      return null;
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * Get the last known update info (if any).
   */
  getLastUpdateInfo(): UpdateInfo | null {
    return this.lastUpdateInfo;
  }

  /**
   * Get the time of the last check.
   */
  getLastCheckTime(): Date | null {
    return this.lastCheck;
  }

  /**
   * Update the configuration (e.g., after config reload).
   */
  updateConfig(config: AutoUpdateConfig): void {
    const oldInterval = this.config.checkIntervalMinutes;
    this.config = config;

    // Restart interval if it changed
    if (config.checkIntervalMinutes !== oldInterval && this.checkInterval) {
      this.stop();
      this.start();
    }
  }
}
