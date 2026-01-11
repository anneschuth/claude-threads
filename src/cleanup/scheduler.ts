/**
 * Background Cleanup Scheduler
 *
 * Runs cleanup tasks out of band to avoid blocking the main flow.
 * Tasks include:
 * - Log cleanup (thread logs older than retention period)
 * - Orphan worktree cleanup (worktrees > 24h with no session)
 * - Stale worktree metadata cleanup
 */

import { existsSync } from 'fs';
import { readdir, rm } from 'fs/promises';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';
import { cleanupOldLogs } from '../persistence/thread-logger.js';
import {
  getWorktreesDir,
  readWorktreeMetadata,
  removeWorktreeMetadata,
  removeWorktree as removeGitWorktree,
  isBranchMerged,
} from '../git/worktree.js';
import type { SessionStore } from '../persistence/session-store.js';

const log = createLogger('cleanup');

/** Default cleanup interval: 1 hour */
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** Max age for worktrees before cleanup: 24 hours */
const MAX_WORKTREE_AGE_MS = 24 * 60 * 60 * 1000;

export interface CleanupSchedulerOptions {
  /** Interval between cleanup runs in ms (default: 1 hour) */
  intervalMs?: number;
  /** Log retention in days (default: 30) */
  logRetentionDays?: number;
  /** Whether thread logs are enabled */
  threadLogsEnabled?: boolean;
  /** Session store for checking active worktrees */
  sessionStore: SessionStore;
  /** Max age for worktrees before cleanup in ms (default: 24 hours) */
  maxWorktreeAgeMs?: number;
  /** Enable worktree cleanup (default: true) */
  cleanupWorktrees?: boolean;
}

export interface CleanupStats {
  logsDeleted: number;
  worktreesCleaned: number;
  metadataCleaned: number;
  errors: string[];
}

/**
 * CleanupScheduler - Runs background cleanup tasks periodically.
 *
 * Start with `start()`, stop with `stop()`.
 * The scheduler runs cleanup immediately on start (fire-and-forget),
 * then periodically at the configured interval.
 */
export class CleanupScheduler {
  private readonly intervalMs: number;
  private readonly logRetentionDays: number;
  private readonly threadLogsEnabled: boolean;
  private readonly sessionStore: SessionStore;
  private readonly maxWorktreeAgeMs: number;
  private readonly cleanupWorktrees: boolean;

  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  constructor(options: CleanupSchedulerOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.logRetentionDays = options.logRetentionDays ?? 30;
    this.threadLogsEnabled = options.threadLogsEnabled ?? true;
    this.sessionStore = options.sessionStore;
    this.maxWorktreeAgeMs = options.maxWorktreeAgeMs ?? MAX_WORKTREE_AGE_MS;
    this.cleanupWorktrees = options.cleanupWorktrees ?? true;
  }

  /**
   * Start the cleanup scheduler.
   * Runs an initial cleanup immediately (fire-and-forget), then schedules periodic cleanup.
   */
  start(): void {
    if (this.isRunning) {
      log.debug('Cleanup scheduler already running');
      return;
    }

    this.isRunning = true;
    log.info(`Cleanup scheduler started (interval: ${Math.round(this.intervalMs / 60000)}min)`);

    // Fire-and-forget initial cleanup
    void this.runCleanup().catch(err => {
      log.warn(`Initial cleanup failed: ${err}`);
    });

    // Schedule periodic cleanup
    this.timer = setInterval(() => {
      void this.runCleanup().catch(err => {
        log.warn(`Periodic cleanup failed: ${err}`);
      });
    }, this.intervalMs);
  }

  /**
   * Stop the cleanup scheduler.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    log.debug('Cleanup scheduler stopped');
  }

  /**
   * Run all cleanup tasks.
   * Can be called manually for immediate cleanup.
   */
  async runCleanup(): Promise<CleanupStats> {
    const startTime = Date.now();
    log.debug('Running background cleanup...');

    const stats: CleanupStats = {
      logsDeleted: 0,
      worktreesCleaned: 0,
      metadataCleaned: 0,
      errors: [],
    };

    // Run cleanup tasks in parallel where possible
    const cleanupTasks: Promise<unknown>[] = [
      this.cleanupLogs().catch(err => {
        stats.errors.push(`Log cleanup: ${err}`);
        return 0;
      }),
    ];

    // Only run worktree cleanup if enabled
    if (this.cleanupWorktrees) {
      cleanupTasks.push(
        this.cleanupOrphanedWorktrees().catch(err => {
          stats.errors.push(`Worktree cleanup: ${err}`);
          return { cleaned: 0, metadata: 0 };
        })
      );
    }

    const [logStats, worktreeStats = { cleaned: 0, metadata: 0 }] = await Promise.all(cleanupTasks) as [
      number,
      { cleaned: number; metadata: number }?
    ];

    stats.logsDeleted = logStats;
    stats.worktreesCleaned = worktreeStats.cleaned;
    stats.metadataCleaned = worktreeStats.metadata;

    const elapsed = Date.now() - startTime;
    const totalCleaned = stats.logsDeleted + stats.worktreesCleaned + stats.metadataCleaned;

    if (totalCleaned > 0 || stats.errors.length > 0) {
      log.info(
        `Cleanup completed in ${elapsed}ms: ` +
        `${stats.logsDeleted} logs, ${stats.worktreesCleaned} worktrees, ${stats.metadataCleaned} metadata` +
        (stats.errors.length > 0 ? ` (${stats.errors.length} errors)` : '')
      );
    } else {
      log.debug(`Cleanup completed in ${elapsed}ms (nothing to clean)`);
    }

    return stats;
  }

  // ---------------------------------------------------------------------------
  // Private cleanup methods
  // ---------------------------------------------------------------------------

  /**
   * Clean up old thread logs.
   */
  private async cleanupLogs(): Promise<number> {
    if (!this.threadLogsEnabled) {
      return 0;
    }

    // cleanupOldLogs is synchronous, wrap in Promise for consistency
    return new Promise(resolve => {
      try {
        const deleted = cleanupOldLogs(this.logRetentionDays);
        resolve(deleted);
      } catch (err) {
        log.warn(`Log cleanup error: ${err}`);
        resolve(0);
      }
    });
  }

  /**
   * Clean up orphaned worktrees.
   * Orphan = worktree in ~/.claude-threads/worktrees/ with no active session using it,
   * and either older than 24 hours or its branch was merged.
   */
  private async cleanupOrphanedWorktrees(): Promise<{ cleaned: number; metadata: number }> {
    const worktreesDir = getWorktreesDir();
    const result = { cleaned: 0, metadata: 0 };

    if (!existsSync(worktreesDir)) {
      log.debug('No worktrees directory exists, nothing to clean');
      return result;
    }

    // Get list of worktrees currently in use by persisted sessions
    const persisted = this.sessionStore.load();
    const activeWorktrees = new Set<string>();
    for (const session of persisted.values()) {
      if (session.worktreeInfo?.worktreePath) {
        activeWorktrees.add(session.worktreeInfo.worktreePath);
      }
    }

    const now = Date.now();

    try {
      const entries = await readdir(worktreesDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const worktreePath = join(worktreesDir, entry.name);

        // Skip worktrees that are in use by persisted sessions
        if (activeWorktrees.has(worktreePath)) {
          log.debug(`Worktree in use by persisted session, skipping: ${entry.name}`);
          continue;
        }

        // Check metadata for age-based and merged-branch cleanup
        const meta = await readWorktreeMetadata(worktreePath);
        let shouldCleanup = false;
        let cleanupReason = '';

        if (meta) {
          const lastActivity = new Date(meta.lastActivityAt).getTime();
          const age = now - lastActivity;

          // If metadata has a sessionId, the worktree is potentially in use.
          // Only clean up if it's been inactive for the max age (session may have crashed).
          // This provides extra protection against race conditions where the session
          // hasn't been persisted yet but the worktree was already created.
          if (meta.sessionId && age < this.maxWorktreeAgeMs) {
            log.debug(`Worktree has active session (${Math.round(age / 60000)}min old), skipping: ${entry.name}`);
            continue;
          }

          // Check if branch was merged (only if old enough - merged branches may still be in use)
          const merged = age >= this.maxWorktreeAgeMs
            ? await isBranchMerged(meta.repoRoot, meta.branch).catch(() => false)
            : false;

          if (merged) {
            shouldCleanup = true;
            cleanupReason = `branch "${meta.branch}" was merged`;
          } else if (age >= this.maxWorktreeAgeMs) {
            shouldCleanup = true;
            cleanupReason = `inactive for ${Math.round(age / 3600000)}h`;
          } else {
            log.debug(`Worktree recent (${Math.round(age / 60000)}min old), skipping: ${entry.name}`);
            continue;
          }
        } else {
          // No metadata = truly orphaned
          shouldCleanup = true;
          cleanupReason = 'no metadata';
        }

        if (!shouldCleanup) continue;

        // Orphaned, old, or merged worktree - clean it up
        log.info(`Cleaning worktree (${cleanupReason}): ${entry.name}`);

        try {
          // Try git worktree remove first (proper cleanup)
          if (meta?.repoRoot) {
            await removeGitWorktree(meta.repoRoot, worktreePath);
          } else {
            // No metadata, just remove the directory
            await rm(worktreePath, { recursive: true, force: true });
          }
          result.cleaned++;

          // Also clean up metadata
          await removeWorktreeMetadata(worktreePath);
          result.metadata++;
        } catch (err) {
          log.warn(`Failed to clean orphaned worktree ${entry.name}: ${err}`);
          // Try force remove as fallback
          try {
            await rm(worktreePath, { recursive: true, force: true });
            result.cleaned++;
            // Clean up metadata even on force remove
            await removeWorktreeMetadata(worktreePath);
            result.metadata++;
          } catch (rmErr) {
            log.error(`Failed to force remove worktree ${entry.name}: ${rmErr}`);
          }
        }
      }
    } catch (err) {
      log.warn(`Failed to scan worktrees directory: ${err}`);
    }

    return result;
  }
}
