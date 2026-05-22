/**
 * Authorization decision helper for the session paths that invoke Claude.
 *
 * This is the single authoritative place that decides whether a given user is
 * allowed to drive Claude in a session. Every user-driven path routes through
 * it: startSession, sendFollowUp, resumePausedSession, and resume-from-reaction.
 * The two system-triggered resume paths (bulk restore after a bot restart)
 * carry no user identity and stay ungated by design.
 *
 * The decision is fail-closed: a missing, empty, or 'unknown' username is
 * denied. Authorization is granted only when the platform's global allowlist
 * accepts the user (which already returns true for an empty allowlist, i.e.
 * allow-all mode), or when the user is in the session's own allowlist (owner
 * plus anyone added via !invite or approved mid-session).
 */

import type { PlatformClient } from '../platform/index.js';

export interface AuthorizationCheck {
  /** Username of the person trying to reach Claude. */
  username: string | undefined;
  /** Platform client whose global allowlist governs this session. */
  platform: PlatformClient;
  /**
   * Per-session allowlist (owner + invited/approved collaborators). Undefined
   * for a brand-new session that has no session allowlist yet, in which case
   * only the global allowlist applies.
   */
  sessionAllowedUsers?: Set<string>;
}

/**
 * Decide whether `username` may drive Claude in this session.
 *
 * Returns true when the platform's global allowlist accepts the user (empty
 * allowlist means allow-all), or when the user is present in the session's own
 * allowlist. Returns false for any missing, empty, or 'unknown' username.
 */
export function isAuthorizedForSession(check: AuthorizationCheck): boolean {
  const { username, platform, sessionAllowedUsers } = check;

  // Fail closed on a missing identity. 'unknown' is the sentinel some callers
  // use when they could not resolve a real username, so it is never authorized.
  if (!username || username === 'unknown') {
    return false;
  }

  if (platform.isUserAllowed(username)) {
    return true;
  }

  return sessionAllowedUsers?.has(username) ?? false;
}
