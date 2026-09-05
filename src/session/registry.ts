/**
 * SessionRegistry - Simple session tracking
 *
 * This is a pure data structure for tracking active sessions.
 * It does NOT contain business logic - just lookup and registration.
 *
 * Operations should find sessions via the registry, then call
 * operation handlers directly with the session.
 */

import type { Session } from './types.js';
import { isRevivable } from '../persistence/session-store.js';
import type { SessionStore, PersistedSession } from '../persistence/session-store.js';

/**
 * THE composite session id format (`platformId:threadId`). Every producer —
 * the registry, SessionManager, and lifecycle's in-flight-start keys — must
 * build ids through this function: the watch/routine runners consult
 * `isSessionStartInFlight` with ids from `ctx.ops.getSessionId`, so a
 * format drift between producers would silently disable that guard.
 */
export function compositeSessionId(platformId: string, threadId: string): string {
  return `${platformId}:${threadId}`;
}

/**
 * Registry for tracking active sessions and their posts.
 *
 * Responsibilities:
 * - Track active sessions by composite ID (platformId:threadId)
 * - Map post IDs to thread IDs for reaction handling
 * - Provide session lookup methods
 * - Interface with persistence layer for paused sessions
 */
export class SessionRegistry {
  private sessions: Map<string, Session> = new Map();
  private postIndex: Map<string, string> = new Map();
  private sessionStore: SessionStore;

  constructor(sessionStore: SessionStore) {
    this.sessionStore = sessionStore;
  }

  // ---------------------------------------------------------------------------
  // Session ID Generation
  // ---------------------------------------------------------------------------

  /**
   * Generate composite session ID from platform and thread.
   */
  getSessionId(platformId: string, threadId: string): string {
    return compositeSessionId(platformId, threadId);
  }

  /**
   * Parse composite session ID back to components.
   */
  parseSessionId(sessionId: string): { platformId: string; threadId: string } | null {
    const colonIndex = sessionId.indexOf(':');
    if (colonIndex === -1) return null;
    return {
      platformId: sessionId.substring(0, colonIndex),
      threadId: sessionId.substring(colonIndex + 1),
    };
  }

  // ---------------------------------------------------------------------------
  // Session Lookup
  // ---------------------------------------------------------------------------

  /**
   * Find active session by platform and thread ID.
   */
  find(platformId: string, threadId: string): Session | undefined {
    return this.sessions.get(this.getSessionId(platformId, threadId));
  }

  /**
   * Find an active session by thread ID.
   *
   * When the caller knows the platform, pass `platformId`: the lookup then
   * resolves O(1) against the composite key and is scoped to that platform.
   * platformId is the session store's privacy boundary, so a thread id that
   * collides across platforms must not resolve to another platform's active
   * session — security-relevant callers (the message router, the in-session
   * authorization check) always pass it. Without a `platformId` this falls
   * back to an unscoped scan across all platforms, kept for the callers that
   * genuinely don't have one to hand.
   */
  findByThreadId(threadId: string, platformId?: string): Session | undefined {
    if (platformId !== undefined) {
      return this.find(platformId, threadId);
    }
    for (const session of this.sessions.values()) {
      if (session.threadId === threadId) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * Find active session by post ID (for reaction handling).
   */
  findByPost(postId: string): Session | undefined {
    const threadId = this.postIndex.get(postId);
    if (!threadId) return undefined;
    return this.findByThreadId(threadId);
  }

  /**
   * Get session by composite session ID.
   */
  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Check if session exists.
   */
  has(platformId: string, threadId: string): boolean {
    return this.sessions.has(this.getSessionId(platformId, threadId));
  }

  /**
   * Check if thread has an active session.
   */
  isActiveThread(threadId: string): boolean {
    return this.findByThreadId(threadId) !== undefined;
  }

  // ---------------------------------------------------------------------------
  // Session Registration
  // ---------------------------------------------------------------------------

  /**
   * Register a new active session.
   */
  register(session: Session): void {
    this.sessions.set(session.sessionId, session);
  }

  /**
   * Unregister an active session.
   */
  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Register a post ID mapping to thread ID.
   * Used for reaction handling - reactions come with postId, we need threadId.
   */
  registerPost(postId: string, threadId: string): void {
    this.postIndex.set(postId, threadId);
  }

  /**
   * Unregister a post ID mapping.
   */
  unregisterPost(postId: string): void {
    this.postIndex.delete(postId);
  }

  /**
   * Clear all post mappings for a thread.
   */
  clearPostsForThread(threadId: string): void {
    for (const [postId, tid] of this.postIndex.entries()) {
      if (tid === threadId) {
        this.postIndex.delete(postId);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * Get all active sessions.
   */
  getAll(): Session[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get all active thread IDs.
   */
  getActiveThreadIds(): string[] {
    return Array.from(this.sessions.values()).map(s => s.threadId);
  }

  /**
   * Get count of active sessions.
   */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Get sessions for a specific platform.
   */
  getForPlatform(platformId: string): Session[] {
    return Array.from(this.sessions.values()).filter(
      s => s.sessionId.startsWith(`${platformId}:`)
    );
  }

  // ---------------------------------------------------------------------------
  // Persistence Integration
  // ---------------------------------------------------------------------------

  /**
   * Check if there's a paused (persisted) session for this thread.
   */
  hasPaused(platformId: string, threadId: string): boolean {
    return this.sessionStore.findByThread(platformId, threadId) !== undefined;
  }

  /**
   * Get persisted session data for a paused session.
   */
  getPersisted(platformId: string, threadId: string): PersistedSession | undefined {
    return this.sessionStore.findByThread(platformId, threadId);
  }

  /**
   * Get persisted session by thread ID alone (searches all platforms).
   *
   * Intentionally includes STALE soft-deleted sessions: when a user replies in
   * a thread whose paused session was soft-deleted by `cleanStale()` on the
   * most recent bot restart, we still want to be able to resume it — that
   * matches the 🔄-reaction resume path (which uses `findByPostId`, also
   * reading raw data) and honors the "send a new message to continue"
   * promise in the timeout message. Sessions permanently deleted by
   * `cleanHistory()` are gone from the file and won't be found here.
   *
   * It excludes `'stopped'` tombstones — see the body, and `EndReason`.
   */
  getPersistedByThreadId(threadId: string, platformId?: string): PersistedSession | undefined {
    const persisted = this.sessionStore.findByThreadIdAnyState(threadId, platformId);
    // Live records and STALE tombstones only. A stale one is aged-out, not
    // ended, and a reply is meant to revive it — that is the whole reason this
    // lookup sees past `cleanedAt` instead of using `load()`.
    //
    // A `'stopped'` tombstone must stay invisible here. This lookup is the gate
    // into the paused-session branch, and that branch CLAIMS the message: a
    // record visible here but not resumable leaves the thread unreachable in
    // both directions — which is exactly how `!stop` used to make a
    // direct-channel-mode channel permanently deaf. Invisible means the message
    // falls through to the new-session path and the user gets the fresh session
    // `!stop` implies.
    return persisted && isRevivable(persisted) ? persisted : undefined;
  }

  /**
   * Get the underlying session store (for persistence operations).
   */
  getSessionStore(): SessionStore {
    return this.sessionStore;
  }

  // ---------------------------------------------------------------------------
  // Public Utilities
  // ---------------------------------------------------------------------------

  /**
   * Check if session exists by composite ID.
   */
  hasById(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Clear all sessions and post mappings.
   */
  clear(): void {
    this.sessions.clear();
    this.postIndex.clear();
  }

  /**
   * Get thread ID for a post ID.
   */
  getThreadIdForPost(postId: string): string | undefined {
    return this.postIndex.get(postId);
  }

  /**
   * Get the sessions map for context building.
   * Used by SessionManager.getContext() to provide session state to operations.
   */
  getSessions(): Map<string, Session> {
    return this.sessions;
  }

  /**
   * Get the post index map for context building.
   * Used by SessionManager.getContext() to provide post mappings to operations.
   */
  getPostIndex(): Map<string, string> {
    return this.postIndex;
  }
}
