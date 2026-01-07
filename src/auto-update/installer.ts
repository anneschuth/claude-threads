/**
 * Update installer module
 *
 * Handles the actual bun/npm install and state persistence.
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { homedir } from 'os';
import { createLogger } from '../utils/logger.js';
import { VERSION } from '../version.js';
import type { PersistedUpdateState, UpdateInfo } from './types.js';
import { UPDATE_STATE_FILENAME } from './types.js';

const log = createLogger('installer');

// State file path
const STATE_PATH = resolve(homedir(), '.config', 'claude-threads', UPDATE_STATE_FILENAME);

// Package name
const PACKAGE_NAME = 'claude-threads';

/**
 * Load persisted update state from disk.
 */
export function loadUpdateState(): PersistedUpdateState {
  try {
    if (existsSync(STATE_PATH)) {
      const content = readFileSync(STATE_PATH, 'utf-8');
      return JSON.parse(content) as PersistedUpdateState;
    }
  } catch (err) {
    log.warn(`Failed to load update state: ${err}`);
  }
  return {};
}

/**
 * Save update state to disk.
 */
export function saveUpdateState(state: PersistedUpdateState): void {
  try {
    const dir = dirname(STATE_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
    log.debug('Update state saved');
  } catch (err) {
    log.warn(`Failed to save update state: ${err}`);
  }
}

/**
 * Clear the update state (after successful restart or rollback).
 */
export function clearUpdateState(): void {
  try {
    if (existsSync(STATE_PATH)) {
      writeFileSync(STATE_PATH, '{}', 'utf-8');
    }
  } catch (err) {
    log.warn(`Failed to clear update state: ${err}`);
  }
}

/**
 * Check if the bot just updated (for post-restart notification).
 */
export function checkJustUpdated(): { previousVersion: string; currentVersion: string } | null {
  const state = loadUpdateState();

  if (state.justUpdated && state.previousVersion) {
    // Clear the flag
    saveUpdateState({
      ...state,
      justUpdated: false,
    });

    return {
      previousVersion: state.previousVersion,
      currentVersion: VERSION,
    };
  }

  return null;
}

/**
 * Install a specific version using bun (preferred) or npm as fallback.
 * Returns true on success, false on failure.
 */
export async function installVersion(version: string): Promise<{ success: boolean; error?: string }> {
  log.info(`📦 Installing ${PACKAGE_NAME}@${version}...`);

  // Save state before installing
  saveUpdateState({
    previousVersion: VERSION,
    targetVersion: version,
    startedAt: new Date().toISOString(),
    justUpdated: false,
  });

  return new Promise((resolve) => {
    // Use bun to install globally (preferred since this package requires bun)
    // Fall back to npm on Windows where bun may not be available
    const useBun = process.platform !== 'win32';
    const cmd = useBun ? 'bun' : 'npm.cmd';
    const args = useBun
      ? ['install', '-g', `${PACKAGE_NAME}@${version}`]
      : ['install', '-g', `${PACKAGE_NAME}@${version}`];

    log.debug(`Using ${useBun ? 'bun' : 'npm'} for installation`);

    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Disable npm progress bar for cleaner output (only affects npm)
        npm_config_progress: 'false',
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        log.info(`✅ Successfully installed ${PACKAGE_NAME}@${version}`);

        // Mark as just updated for post-restart notification
        saveUpdateState({
          previousVersion: VERSION,
          targetVersion: version,
          startedAt: new Date().toISOString(),
          justUpdated: true,
        });

        resolve({ success: true });
      } else {
        const errorMsg = stderr || stdout || `Exit code: ${code}`;
        log.error(`❌ Installation failed: ${errorMsg}`);

        // Clear the state on failure
        clearUpdateState();

        resolve({ success: false, error: errorMsg });
      }
    });

    child.on('error', (err) => {
      log.error(`❌ Failed to spawn npm: ${err}`);
      clearUpdateState();
      resolve({ success: false, error: err.message });
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill();
        log.error('❌ Installation timed out');
        clearUpdateState();
        resolve({ success: false, error: 'Installation timed out' });
      }
    }, 5 * 60 * 1000);
  });
}

/**
 * Get rollback instructions for the previous version.
 */
export function getRollbackInstructions(previousVersion: string): string {
  const cmd = process.platform === 'win32' ? 'npm' : 'bun';
  return `To rollback to the previous version, run:\n  ${cmd} install -g ${PACKAGE_NAME}@${previousVersion}`;
}

/**
 * UpdateInstaller - Handles installation and state management
 */
export class UpdateInstaller {
  private isInstalling = false;

  /**
   * Install an update.
   */
  async install(updateInfo: UpdateInfo): Promise<{ success: boolean; error?: string }> {
    if (this.isInstalling) {
      return { success: false, error: 'Installation already in progress' };
    }

    this.isInstalling = true;

    try {
      return await installVersion(updateInfo.latestVersion);
    } finally {
      this.isInstalling = false;
    }
  }

  /**
   * Check if installation is in progress.
   */
  isInProgress(): boolean {
    return this.isInstalling;
  }

  /**
   * Check if the bot just updated and return version info.
   */
  checkJustUpdated(): { previousVersion: string; currentVersion: string } | null {
    return checkJustUpdated();
  }

  /**
   * Get the persisted state (for UI display).
   */
  getState(): PersistedUpdateState {
    return loadUpdateState();
  }

  /**
   * Clear the persisted state.
   */
  clearState(): void {
    clearUpdateState();
  }
}
