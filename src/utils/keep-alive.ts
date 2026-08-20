/**
 * System Keep-Alive Module
 *
 * Prevents the system from going to sleep while Claude sessions are active.
 * Uses platform-specific methods:
 * - macOS: caffeinate command
 * - Linux: systemd-inhibit command
 * - Windows: stay-awake npm package (if available)
 */

import { spawn, ChildProcess, StdioOptions } from 'child_process';
import { createLogger } from './logger.js';

const log = createLogger('keepalive');

/**
 * Spawn specification for a platform's keep-alive process.
 */
interface KeepAliveSpawnSpec {
  command: string;
  args: string[];
  stdio: StdioOptions;
}

/**
 * Build the spawn spec for the given platform, tying the keep-alive
 * process's lifetime to `parentPid` (the bot process).
 *
 * This coupling is the load-bearing part: without it, a hard death of the
 * bot (SIGKILL, crashed test runner) orphans the inhibitor to init and the
 * machine can never sleep again until someone kills it by hand.
 *
 * - macOS: `caffeinate -w <pid>` exits natively when the watched pid dies.
 * - Linux: `systemd-inhibit ... cat` with a piped stdin. systemd-inhibit
 *   execs the command, so the inhibitor lock is held by `cat` itself; when
 *   the bot dies the kernel closes the pipe, `cat` reads EOF and exits,
 *   releasing the lock. Event-driven, works even on SIGKILL.
 * - Fallbacks (xdg-screensaver / PowerShell): poll the parent pid in the
 *   loop and exit when it is gone.
 */
function keepAliveSpawnSpec(
  platform: NodeJS.Platform,
  parentPid: number
): KeepAliveSpawnSpec | null {
  switch (platform) {
    case 'darwin':
      return {
        command: 'caffeinate',
        args: ['-s', '-i', '-w', String(parentPid)],
        stdio: 'ignore',
      };
    case 'linux':
      return {
        command: 'systemd-inhibit',
        args: [
          '--what=sleep:idle:handle-lid-switch',
          '--why=Claude Code session active',
          '--mode=block',
          'cat',
        ],
        stdio: ['pipe', 'ignore', 'ignore'],
      };
    default:
      return null;
  }
}

/**
 * Linux fallback loop: xdg-screensaver reset while the parent is alive.
 */
function linuxFallbackScript(parentPid: number): string {
  return `while kill -0 ${parentPid} 2>/dev/null; do xdg-screensaver reset 2>/dev/null || true; sleep 60; done`;
}

/**
 * Windows keep-alive script: SetThreadExecutionState while the parent is
 * alive. The execution state dies with the PowerShell process, so exiting
 * the loop is enough to release it.
 */
function windowsScript(parentPid: number): string {
  return `
        Add-Type -TypeDefinition @"
          using System;
          using System.Runtime.InteropServices;
          public class PowerState {
            [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
            public static extern uint SetThreadExecutionState(uint esFlags);
          }
"@
        # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
        [PowerState]::SetThreadExecutionState(0x80000001) | Out-Null
        # Keep running until killed or the parent process exits
        while (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 60 }
      `;
}

export { keepAliveSpawnSpec, linuxFallbackScript, windowsScript };
export type { KeepAliveSpawnSpec };

/**
 * KeepAlive manager - singleton that tracks active sessions and manages
 * system sleep prevention.
 */
class KeepAliveManager {
  private activeSessionCount = 0;
  private keepAliveProcess: ChildProcess | null = null;
  private enabled = true;
  private platform: NodeJS.Platform;

  constructor() {
    this.platform = process.platform;
  }

  /**
   * Enable or disable keep-alive functionality.
   * When disabled, no system sleep prevention will occur.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled && this.keepAliveProcess) {
      this.stopKeepAlive();
    }
    log.debug(`Keep-alive ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Check if keep-alive is currently enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Check if keep-alive is currently active (process running).
   */
  isActive(): boolean {
    return this.keepAliveProcess !== null;
  }

  /**
   * Called when a session starts. Increments the session count and
   * starts system sleep prevention if this is the first session.
   */
  sessionStarted(): void {
    this.activeSessionCount++;
    log.debug(`Session started (${this.activeSessionCount} active)`);

    if (this.activeSessionCount === 1) {
      this.startKeepAlive();
    }
  }

  /**
   * Called when a session ends. Decrements the session count and
   * stops system sleep prevention if there are no more sessions.
   */
  sessionEnded(): void {
    if (this.activeSessionCount > 0) {
      this.activeSessionCount--;
    }
    log.debug(`Session ended (${this.activeSessionCount} active)`);

    if (this.activeSessionCount === 0) {
      this.stopKeepAlive();
    }
  }

  /**
   * Force stop the keep-alive process (used during shutdown).
   */
  forceStop(): void {
    this.stopKeepAlive();
    this.activeSessionCount = 0;
  }

  /**
   * Get the current session count.
   */
  getSessionCount(): number {
    return this.activeSessionCount;
  }

  /**
   * Start the platform-specific keep-alive process.
   */
  private startKeepAlive(): void {
    if (!this.enabled) {
      log.debug('Keep-alive disabled, skipping');
      return;
    }

    if (this.keepAliveProcess) {
      log.debug('Keep-alive already running');
      return;
    }

    switch (this.platform) {
      case 'darwin':
        this.startMacOSKeepAlive();
        break;
      case 'linux':
        this.startLinuxKeepAlive();
        break;
      case 'win32':
        this.startWindowsKeepAlive();
        break;
      default:
        log.warn(`Keep-alive not supported on ${this.platform}`);
    }
  }

  /**
   * Stop the keep-alive process.
   */
  private stopKeepAlive(): void {
    if (this.keepAliveProcess) {
      log.debug('Stopping keep-alive');
      this.keepAliveProcess.kill();
      this.keepAliveProcess = null;
    }
  }

  /**
   * macOS: Use the built-in caffeinate command.
   * -s: Prevent system sleep
   * -i: Prevent idle sleep
   */
  private startMacOSKeepAlive(): void {
    try {
      // caffeinate -s prevents system sleep (but allows display sleep)
      // caffeinate -i prevents idle sleep
      // caffeinate -w <pid> makes it exit when the bot process dies,
      // so a crashed bot can't leave the Mac sleepless
      const spec = keepAliveSpawnSpec('darwin', process.pid);
      if (!spec) return;
      this.keepAliveProcess = spawn(spec.command, spec.args, {
        stdio: spec.stdio,
        detached: false,
      });

      this.keepAliveProcess.on('error', (err) => {
        log.error(`Failed to start caffeinate: ${err.message}`);
        this.keepAliveProcess = null;
      });

      this.keepAliveProcess.on('exit', (code) => {
        if (code !== null && code !== 0 && this.activeSessionCount > 0) {
          log.debug(`caffeinate exited with code ${code}`);
        }
        this.keepAliveProcess = null;
      });

      log.info('Sleep prevention active (caffeinate)');
    } catch (err) {
      log.error(`Failed to start caffeinate: ${err}`);
    }
  }

  /**
   * Linux: Use systemd-inhibit to prevent sleep.
   * Falls back to a simple loop if systemd-inhibit is not available.
   */
  private startLinuxKeepAlive(): void {
    try {
      // Try systemd-inhibit first (standard on modern Linux).
      // It execs a command while inhibiting sleep - we use 'cat' reading
      // from a pipe held by this process: if the bot dies (even SIGKILL),
      // the pipe closes, cat exits on EOF and the inhibitor lock is
      // released instead of leaking to init.
      const spec = keepAliveSpawnSpec('linux', process.pid);
      if (!spec) return;
      this.keepAliveProcess = spawn(spec.command, spec.args, {
        stdio: spec.stdio,
        detached: false,
      });

      this.keepAliveProcess.on('error', (err) => {
        log.debug(`systemd-inhibit not available: ${err.message}`);
        this.keepAliveProcess = null;
        // Try alternative method
        this.startLinuxKeepAliveFallback();
      });

      this.keepAliveProcess.on('exit', (code) => {
        if (code !== null && code !== 0 && this.activeSessionCount > 0) {
          log.debug(`systemd-inhibit exited with code ${code}`);
        }
        this.keepAliveProcess = null;
      });

      log.info('Sleep prevention active (systemd-inhibit)');
    } catch (err) {
      log.debug(`Failed to start systemd-inhibit: ${err}`);
      this.startLinuxKeepAliveFallback();
    }
  }

  /**
   * Linux fallback: Try using xdg-screensaver or dbus-send.
   * This is less reliable but works on more systems.
   */
  private startLinuxKeepAliveFallback(): void {
    // Try xdg-screensaver suspend (works on many desktop environments)
    try {
      // The loop watches the bot pid and exits when it is gone, so a hard
      // bot death can't leave the reset loop running forever
      this.keepAliveProcess = spawn(
        'bash',
        ['-c', linuxFallbackScript(process.pid)],
        {
          stdio: 'ignore',
          detached: false,
        }
      );

      this.keepAliveProcess.on('error', (err) => {
        log.warn(`Linux keep-alive fallback not available: ${err.message}`);
        this.keepAliveProcess = null;
      });

      this.keepAliveProcess.on('exit', () => {
        this.keepAliveProcess = null;
      });

      log.info('Sleep prevention active (xdg-screensaver)');
    } catch (err) {
      log.warn(`Linux keep-alive not available: ${err}`);
    }
  }

  /**
   * Windows: Use PowerShell to call SetThreadExecutionState.
   * This is the most reliable method on Windows without requiring
   * additional npm packages.
   */
  private startWindowsKeepAlive(): void {
    try {
      // Use PowerShell to call SetThreadExecutionState API
      // ES_CONTINUOUS (0x80000000) + ES_SYSTEM_REQUIRED (0x00000001) = 0x80000001
      const script = windowsScript(process.pid);

      this.keepAliveProcess = spawn(
        'powershell',
        ['-NoProfile', '-Command', script],
        {
          stdio: 'ignore',
          detached: false,
          windowsHide: true,
        }
      );

      this.keepAliveProcess.on('error', (err) => {
        log.warn(`Windows keep-alive not available: ${err.message}`);
        this.keepAliveProcess = null;
      });

      this.keepAliveProcess.on('exit', (code) => {
        if (code !== null && code !== 0 && this.activeSessionCount > 0) {
          log.debug(`PowerShell keep-alive exited with code ${code}`);
        }
        this.keepAliveProcess = null;
      });

      log.info('Sleep prevention active (SetThreadExecutionState)');
    } catch (err) {
      log.warn(`Windows keep-alive not available: ${err}`);
    }
  }
}

// Singleton instance
const keepAlive = new KeepAliveManager();

export { keepAlive, KeepAliveManager };
