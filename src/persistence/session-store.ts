import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';
import type { PlatformFile } from '../platform/types.js';

const log = createLogger('persist');

/**
 * Worktree information for a session
 */
export interface WorktreeInfo {
  repoRoot: string;      // Original git repo path
  worktreePath: string;  // Current worktree path
  branch: string;        // Branch name
}

/**
 * Persisted context prompt state (without timeoutId which can't be serialized)
 */
export interface PersistedContextPrompt {
  postId: string;
  queuedPrompt: string;
  queuedFiles?: PlatformFile[];  // Files attached to the queued prompt (for images)
  threadMessageCount: number;
  createdAt: number;
  availableOptions: number[];
}

/**
 * Persisted session state for resuming after bot restart
 */
export interface PersistedSession {
  platformId: string;            // Which platform instance (e.g., 'default', 'mattermost-main')
  threadId: string;              // Thread ID within that platform
  claudeSessionId: string;       // UUID for --session-id / --resume
  startedBy: string;             // Username who started the session
  startedByDisplayName?: string; // Display name for UI
  startedAt: string;             // ISO date
  sessionNumber: number;
  workingDir: string;            // Can change via !cd
  sessionAllowedUsers: string[]; // Collaboration list
  forceInteractivePermissions: boolean;
  sessionStartPostId: string | null;
  tasksPostId: string | null;
  lastTasksContent: string | null;  // For re-posting tasks when bumping to bottom
  tasksCompleted?: boolean;      // True when all tasks done (stops sticky behavior)
  tasksMinimized?: boolean;      // True when task list is minimized (show only progress)
  lastActivityAt: string;        // For stale cleanup
  planApproved: boolean;
  // Worktree support
  worktreeInfo?: WorktreeInfo;              // Active worktree info
  isWorktreeOwner?: boolean;                // True if this session CREATED the worktree (vs joining existing)
  pendingWorktreePrompt?: boolean;          // Waiting for branch name response
  worktreePromptDisabled?: boolean;         // User opted out with !worktree off
  queuedPrompt?: string;                    // User's original message when waiting for worktree response
  queuedFiles?: PlatformFile[];             // Files attached to the queued prompt (for images)
  firstPrompt?: string;                     // First user message, sent again after mid-session worktree creation
  // Context prompt support
  pendingContextPrompt?: PersistedContextPrompt; // Waiting for context selection
  needsContextPromptOnNextMessage?: boolean;     // Offer context prompt on next follow-up message (after !cd)
  // Resume support
  lifecyclePostId?: string;                        // Post ID of timeout/shutdown message (for resume via reaction or restart)
  // Session title and description
  sessionTitle?: string;                         // Short title describing the session topic
  sessionDescription?: string;                   // Longer description of what's happening (1-2 sentences)
  // Pull request URL
  pullRequestUrl?: string;                       // Full URL to PR (GitHub, GitLab, Bitbucket, Azure DevOps, etc.)
  // Message counter
  messageCount?: number;                         // Number of user messages sent to Claude
  // Resume failure tracking
  resumeFailCount?: number;                      // Count of consecutive resume failures
  // History retention (soft delete)
  cleanedAt?: string;                            // ISO date when session was soft-deleted (kept for history)
}

/**
 * v1 session format (before platformId was added)
 */
type PersistedSessionV1 = Omit<PersistedSession, 'platformId'> & {
  platformId?: string;
}

/**
 * Legacy session format (before lifecyclePostId rename in v0.33.7)
 * Used for migration from timeoutPostId to lifecyclePostId
 */
type PersistedSessionLegacy = PersistedSession & {
  timeoutPostId?: string;  // Old field name, renamed to lifecyclePostId
}

interface SessionStoreData {
  version: number;
  sessions: Record<string, PersistedSession>;
  stickyPostIds?: Record<string, string>;  // platformId -> postId
  platformEnabledState?: Record<string, boolean>;  // platformId -> enabled (defaults to true if not set)
}

const STORE_VERSION = 2; // v2: Added platformId for multi-platform support
const DEFAULT_CONFIG_DIR = join(homedir(), '.config', 'claude-threads');
const DEFAULT_SESSIONS_FILE = join(DEFAULT_CONFIG_DIR, 'sessions.json');

/**
 * SessionStore - Persistence layer for session state
 * Stores session data as JSON file for resume after restart
 */
export class SessionStore {
  private readonly sessionsFile: string;
  private readonly configDir: string;

  /**
   * Create a SessionStore instance
   * @param sessionsPath - Custom path for sessions.json (default: ~/.config/claude-threads/sessions.json)
   *                       Can also be set via CLAUDE_THREADS_SESSIONS_PATH environment variable.
   *                       Useful for testing to isolate session state between test files.
   */
  constructor(sessionsPath?: string) {
    const envPath = process.env.CLAUDE_THREADS_SESSIONS_PATH;
    const effectivePath = sessionsPath ?? envPath;

    if (effectivePath) {
      this.sessionsFile = effectivePath;
      this.configDir = join(effectivePath, '..');
    } else {
      this.sessionsFile = DEFAULT_SESSIONS_FILE;
      this.configDir = DEFAULT_CONFIG_DIR;
    }

    // Ensure config directory exists
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true });
    }
  }

  /**
   * Load all persisted sessions
   * Returns Map with composite sessionId ("platformId:threadId") as key
   */
  load(): Map<string, PersistedSession> {
    const sessions = new Map<string, PersistedSession>();

    if (!existsSync(this.sessionsFile)) {
      log.debug('No sessions file found');
      return sessions;
    }

    try {
      const data = JSON.parse(readFileSync(this.sessionsFile, 'utf-8')) as SessionStoreData;

      // Migration: v1 → v2 (add platformId and convert keys to composite format)
      if (data.version === 1) {
        log.info('Migrating sessions from v1 to v2 (adding platformId)');
        const newSessions: Record<string, PersistedSession> = {};
        for (const [_oldKey, session] of Object.entries(data.sessions)) {
          const v1Session = session as PersistedSessionV1;
          if (!v1Session.platformId) {
            v1Session.platformId = 'default';
          }
          // Convert key from threadId to platformId:threadId
          const newKey = `${v1Session.platformId}:${v1Session.threadId}`;
          newSessions[newKey] = v1Session as PersistedSession;
        }
        data.sessions = newSessions;
        data.version = 2;
        // Save migrated data
        this.writeAtomic(data);
      } else if (data.version !== STORE_VERSION) {
        log.warn(`Sessions file version ${data.version} not supported, starting fresh`);
        return sessions;
      }

      // Migration: timeoutPostId → lifecyclePostId (v0.33.7)
      // This is a field rename that doesn't require a version bump
      let needsSave = false;
      for (const session of Object.values(data.sessions)) {
        const legacySession = session as PersistedSessionLegacy;
        if (legacySession.timeoutPostId && !session.lifecyclePostId) {
          session.lifecyclePostId = legacySession.timeoutPostId;
          delete legacySession.timeoutPostId;
          needsSave = true;
          log.debug(`Migrated timeoutPostId to lifecyclePostId for session ${session.threadId.substring(0, 8)}...`);
        }
      }
      if (needsSave) {
        log.info('Migrated session(s) from timeoutPostId to lifecyclePostId');
        this.writeAtomic(data);
      }

      // Load active sessions only (exclude soft-deleted)
      for (const session of Object.values(data.sessions)) {
        // Skip soft-deleted sessions (they're kept for history only)
        if (session.cleanedAt) continue;

        const sessionId = `${session.platformId}:${session.threadId}`;
        sessions.set(sessionId, session);
      }

      log.debug(`Loaded ${sessions.size} active session(s)`);
    } catch (err) {
      log.error(`Failed to load sessions: ${err}`);
    }

    return sessions;
  }

  /**
   * Save a session (creates or updates)
   * @param sessionId - Composite key "platformId:threadId"
   * @param session - Session data to persist
   */
  save(sessionId: string, session: PersistedSession): void {
    const data = this.loadRaw();
    // Use sessionId as key (already composite)
    data.sessions[sessionId] = session;
    this.writeAtomic(data);

    const shortId = sessionId.substring(0, 20);
    log.debug(`Saved session ${shortId}...`);
  }

  /**
   * Remove a session permanently
   * @param sessionId - Composite key "platformId:threadId"
   */
  remove(sessionId: string): void {
    const data = this.loadRaw();
    if (data.sessions[sessionId]) {
      delete data.sessions[sessionId];
      this.writeAtomic(data);

      const shortId = sessionId.substring(0, 20);
      log.debug(`Removed session ${shortId}...`);
    }
  }

  /**
   * Soft-delete a session (mark as cleaned but keep for history)
   * @param sessionId - Composite key "platformId:threadId"
   */
  softDelete(sessionId: string): void {
    const data = this.loadRaw();
    if (data.sessions[sessionId]) {
      data.sessions[sessionId].cleanedAt = new Date().toISOString();
      this.writeAtomic(data);

      const shortId = sessionId.substring(0, 20);
      log.debug(`Soft-deleted session ${shortId}...`);
    }
  }

  /**
   * Soft-delete sessions older than maxAgeMs (keeps them for history display)
   * Only affects active sessions (not already soft-deleted)
   * @returns Array of sessionIds that were soft-deleted
   */
  cleanStale(maxAgeMs: number): string[] {
    const data = this.loadRaw();
    const now = Date.now();
    const staleIds: string[] = [];

    for (const [sessionId, session] of Object.entries(data.sessions)) {
      // Skip already soft-deleted sessions
      if (session.cleanedAt) continue;

      const lastActivity = new Date(session.lastActivityAt).getTime();
      if (now - lastActivity > maxAgeMs) {
        staleIds.push(sessionId);
        session.cleanedAt = new Date().toISOString();
      }
    }

    if (staleIds.length > 0) {
      this.writeAtomic(data);
      log.debug(`Soft-deleted ${staleIds.length} stale session(s)`);
    }

    return staleIds;
  }

  /**
   * Permanently remove soft-deleted sessions older than historyRetentionMs
   * @param historyRetentionMs - How long to keep soft-deleted sessions (default: 3 days)
   * @returns Number of sessions permanently removed
   */
  cleanHistory(historyRetentionMs: number = 3 * 24 * 60 * 60 * 1000): number {
    const data = this.loadRaw();
    const now = Date.now();
    let removedCount = 0;

    for (const [sessionId, session] of Object.entries(data.sessions)) {
      if (!session.cleanedAt) continue;

      const cleanedTime = new Date(session.cleanedAt).getTime();
      if (now - cleanedTime > historyRetentionMs) {
        delete data.sessions[sessionId];
        removedCount++;
      }
    }

    if (removedCount > 0) {
      this.writeAtomic(data);
      log.debug(`Permanently removed ${removedCount} old session(s) from history`);
    }

    return removedCount;
  }

  /**
   * Get all inactive sessions for a platform (for history display).
   * Includes both soft-deleted sessions (completed) and timed-out sessions (resumable).
   * @param platformId - Platform instance ID
   * @param activeSessions - Set of currently active session IDs to exclude
   * @returns Array of inactive sessions, sorted by most recent activity
   */
  getHistory(platformId: string, activeSessions?: Set<string>): PersistedSession[] {
    const data = this.loadRaw();
    const historySessions: PersistedSession[] = [];

    for (const [sessionId, session] of Object.entries(data.sessions)) {
      if (session.platformId !== platformId) continue;

      // Include soft-deleted sessions (completed normally)
      if (session.cleanedAt) {
        historySessions.push(session);
        continue;
      }

      // Include timed-out sessions that are not currently active
      // These have lifecyclePostId (or legacy timeoutPostId) set but no cleanedAt
      const legacySession = session as PersistedSessionLegacy;
      const hasLifecyclePost = session.lifecyclePostId || legacySession.timeoutPostId;
      if (hasLifecyclePost && activeSessions && !activeSessions.has(sessionId)) {
        historySessions.push(session);
      }
    }

    // Sort by most recent activity (cleanedAt for completed, lastActivityAt for timed out)
    return historySessions.sort((a, b) => {
      const aTime = new Date(a.cleanedAt || a.lastActivityAt).getTime();
      const bTime = new Date(b.cleanedAt || b.lastActivityAt).getTime();
      return bTime - aTime;
    });
  }

  /**
   * Clear all sessions
   */
  clear(): void {
    const data = this.loadRaw();
    // Preserve sticky post IDs when clearing sessions
    this.writeAtomic({ version: STORE_VERSION, sessions: {}, stickyPostIds: data.stickyPostIds });
    log.debug('Cleared all sessions');
  }

  // ---------------------------------------------------------------------------
  // Sticky Post ID Management
  // ---------------------------------------------------------------------------

  /**
   * Save a sticky post ID for a platform
   */
  saveStickyPostId(platformId: string, postId: string): void {
    const data = this.loadRaw();
    if (!data.stickyPostIds) {
      data.stickyPostIds = {};
    }
    data.stickyPostIds[platformId] = postId;
    this.writeAtomic(data);

    log.debug(`Saved sticky post ID for ${platformId}: ${postId.substring(0, 8)}...`);
  }

  /**
   * Get all sticky post IDs
   */
  getStickyPostIds(): Map<string, string> {
    const data = this.loadRaw();
    return new Map(Object.entries(data.stickyPostIds || {}));
  }

  /**
   * Remove a sticky post ID for a platform
   */
  removeStickyPostId(platformId: string): void {
    const data = this.loadRaw();
    if (data.stickyPostIds && data.stickyPostIds[platformId]) {
      delete data.stickyPostIds[platformId];
      this.writeAtomic(data);

      log.debug(`Removed sticky post ID for ${platformId}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Platform Enabled State Management
  // ---------------------------------------------------------------------------

  /**
   * Get all platform enabled states
   * Returns a map of platformId -> enabled (defaults to true if not set)
   */
  getPlatformEnabledState(): Map<string, boolean> {
    const data = this.loadRaw();
    return new Map(Object.entries(data.platformEnabledState || {}));
  }

  /**
   * Check if a specific platform is enabled
   * @param platformId - Platform instance ID
   * @returns true if enabled or not set (defaults to enabled), false if explicitly disabled
   */
  isPlatformEnabled(platformId: string): boolean {
    const data = this.loadRaw();
    // Default to true if not set
    return data.platformEnabledState?.[platformId] ?? true;
  }

  /**
   * Set the enabled state for a platform
   * @param platformId - Platform instance ID
   * @param enabled - Whether the platform is enabled
   */
  setPlatformEnabled(platformId: string, enabled: boolean): void {
    const data = this.loadRaw();
    if (!data.platformEnabledState) {
      data.platformEnabledState = {};
    }
    data.platformEnabledState[platformId] = enabled;
    this.writeAtomic(data);

    log.debug(`Set platform ${platformId} enabled state to ${enabled}`);
  }

  /**
   * Find a persisted session by platform and thread ID
   * @param platformId - Platform instance ID
   * @param threadId - Thread ID within the platform
   * @returns Session data if found, undefined otherwise
   */
  findByThread(platformId: string, threadId: string): PersistedSession | undefined {
    const sessionId = `${platformId}:${threadId}`;
    const data = this.loadRaw();
    return data.sessions[sessionId];
  }

  /**
   * Find a persisted session by timeout post ID or session start post ID
   * Used for resuming sessions via emoji reaction
   * @param platformId - Platform instance ID
   * @param postId - Post ID to search for
   * @returns Session data if found, undefined otherwise
   */
  findByPostId(platformId: string, postId: string): PersistedSession | undefined {
    const data = this.loadRaw();
    for (const session of Object.values(data.sessions)) {
      if (session.platformId !== platformId) continue;
      // Check both lifecyclePostId and legacy timeoutPostId for compatibility
      const legacySession = session as PersistedSessionLegacy;
      const lifecycleId = session.lifecyclePostId || legacySession.timeoutPostId;
      if (lifecycleId === postId || session.sessionStartPostId === postId) {
        // Migrate the field if using legacy name
        if (legacySession.timeoutPostId && !session.lifecyclePostId) {
          session.lifecyclePostId = legacySession.timeoutPostId;
        }
        return session;
      }
    }
    return undefined;
  }

  /**
   * Load raw data from file
   */
  private loadRaw(): SessionStoreData {
    if (!existsSync(this.sessionsFile)) {
      return { version: STORE_VERSION, sessions: {} };
    }

    try {
      return JSON.parse(readFileSync(this.sessionsFile, 'utf-8')) as SessionStoreData;
    } catch {
      return { version: STORE_VERSION, sessions: {} };
    }
  }

  /**
   * Write data atomically (write to temp file, then rename)
   */
  private writeAtomic(data: SessionStoreData): void {
    const tempFile = `${this.sessionsFile}.tmp`;
    writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tempFile, this.sessionsFile);
  }
}
