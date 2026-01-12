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
import type { SessionStore, PersistedSession } from '../persistence/session-store.js';

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
    return `${platformId}:${threadId}`;
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
   * Find active session by thread ID alone (searches all platforms).
   * Use when platformId is not readily available.
   */
  findByThreadId(threadId: string): Session | undefined {
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
   */
  getPersistedByThreadId(threadId: string): PersistedSession | undefined {
    // Search through all persisted sessions for this threadId
    const all = this.sessionStore.load();
    for (const session of all.values()) {
      if (session.threadId === threadId) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * Get the underlying session store (for persistence operations).
   */
  getSessionStore(): SessionStore {
    return this.sessionStore;
  }

  // ---------------------------------------------------------------------------
  // Internal Access (for migration - will be removed)
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
   * Get all post entries for iteration.
   * @internal - for migration, prefer using clearPostsForThread
   */
  _getPostEntries(): IterableIterator<[string, string]> {
    return this.postIndex.entries();
  }

  /**
   * Get raw sessions map - for migration from SessionManager.
   * @internal
   */
  _getSessions(): Map<string, Session> {
    return this.sessions;
  }

  /**
   * Get raw post index - for migration from SessionManager.
   * @internal
   */
  _getPostIndex(): Map<string, string> {
    return this.postIndex;
  }
}
