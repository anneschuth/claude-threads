/**
 * Format Utilities
 *
 * Centralizes common formatting patterns used throughout the codebase.
 * This eliminates duplication of ID formatting and console logging patterns.
 *
 * Benefits:
 * - DRY: Single implementation for all formatting
 * - Consistency: Standard output formats
 * - Maintainability: Easy to change formats globally
 */

import { VERSION } from '../version.js';
import { getClaudeCliVersion } from '../claude/version-check.js';

// =============================================================================
// ID Formatting
// =============================================================================

/**
 * Extract the thread ID from a composite session ID.
 * Composite IDs are in format "platformId:threadId".
 *
 * @param sessionId - The composite session ID or plain thread ID
 * @returns The thread ID portion
 */
export function extractThreadId(sessionId: string): string {
  const colonIndex = sessionId.indexOf(':');
  return colonIndex >= 0 ? sessionId.substring(colonIndex + 1) : sessionId;
}

/**
 * Format a session/thread ID for display.
 * Shows first 8 characters followed by ellipsis.
 * Handles both composite IDs (platformId:threadId) and plain thread IDs.
 *
 * @param id - The full ID string (composite or plain)
 * @returns Shortened ID like "abc12345…"
 */
export function formatShortId(id: string): string {
  const threadId = extractThreadId(id);
  if (threadId.length <= 8) return threadId;
  return `${threadId.substring(0, 8)}…`;
}

// =============================================================================
// Console Logging
// =============================================================================

// =============================================================================
// Time Formatting
// =============================================================================

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted string like "5m 30s" or "2h 15m"
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }

  if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }

  return `${seconds}s`;
}

/**
 * Format a relative time from a date to now (short format).
 * Used in compact displays like sticky messages.
 *
 * @param date - The date to format relative to now
 * @returns Formatted string like "5m ago", "2h ago", "3d ago"
 */
export function formatRelativeTimeShort(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return '<1m ago';
}

// =============================================================================
// Version Formatting
// =============================================================================

/**
 * Format version string for status bar display.
 * CT = claude-threads, CC = Claude Code (the CLI).
 *
 * @returns Formatted string like "CT v1.3.1 · CC v2.1.12" or "CT v1.3.1" if no CLI version
 */
export function formatVersionString(): string {
  const claudeVersion = getClaudeCliVersion().version;
  return claudeVersion ? `CT v${VERSION} · CC v${claudeVersion}` : `CT v${VERSION}`;
}

// =============================================================================
// String Formatting
// =============================================================================

/**
 * Truncate a string at a word boundary with ellipsis.
 * Tries to break at the last space, but falls back to hard truncation
 * if the last space is too early (< 70% of maxLength).
 *
 * @param str - The string to truncate
 * @param maxLength - Maximum length including ellipsis
 * @returns Truncated string with ellipsis if truncated
 */
export function truncateAtWord(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;

  const truncated = str.substring(0, maxLength - 1); // Leave room for ellipsis
  const lastSpace = truncated.lastIndexOf(' ');

  // Break at word boundary if the last space is reasonably far into the string (>70%)
  if (lastSpace > maxLength * 0.7) {
    return truncated.substring(0, lastSpace) + '…';
  }

  // Fall back to hard truncation
  return truncated + '…';
}
