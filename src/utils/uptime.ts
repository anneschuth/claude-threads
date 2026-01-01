/**
 * Uptime Formatting Module
 *
 * Formats session duration for display in the status bar.
 */

/**
 * Format a duration from a start time to now.
 * Returns compact format: "5m", "1h23m", "2h", "1d5h"
 */
export function formatUptime(startedAt: Date): string {
  const now = Date.now();
  const elapsed = now - startedAt.getTime();

  // Convert to minutes
  const totalMinutes = Math.floor(elapsed / (1000 * 60));

  if (totalMinutes < 1) {
    return '<1m';
  }

  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);

  if (days > 0) {
    if (hours > 0) {
      return `${days}d${hours}h`;
    }
    return `${days}d`;
  }

  if (hours > 0) {
    if (minutes > 0) {
      return `${hours}h${minutes}m`;
    }
    return `${hours}h`;
  }

  return `${minutes}m`;
}
