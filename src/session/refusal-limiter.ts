/**
 * Rate limiter for session-resume refusal posts (#491).
 *
 * The refusal carries the same information every time it fires: when two bots
 * get into a refusal loop the posts repeat seconds apart, while a human who
 * wanders back later still deserves to be told why nothing happened. One
 * refusal per (platform, thread, user) per window covers both.
 */

const lastRefusalAt = new Map<string, number>();

/** One refusal per (platform, thread, user) per this window. */
export const REFUSAL_WINDOW_MS = 5 * 60 * 1000;

/** Cleanup threshold — expired entries are swept when the map grows past this. */
const CLEANUP_THRESHOLD = 500;

/**
 * Whether a resume-refusal post should be made for this (platform, thread,
 * user) right now. Returns true at most once per REFUSAL_WINDOW_MS per key
 * and records the attempt.
 */
export function shouldPostResumeRefusal(
  platformId: string,
  threadId: string,
  username: string,
  now: number = Date.now()
): boolean {
  const key = `${platformId}:${threadId}:${username}`;
  const last = lastRefusalAt.get(key);
  if (last !== undefined && now - last < REFUSAL_WINDOW_MS) {
    return false;
  }
  // Opportunistic sweep keeps the map bounded without a timer.
  if (lastRefusalAt.size >= CLEANUP_THRESHOLD) {
    for (const [k, t] of lastRefusalAt) {
      if (now - t >= REFUSAL_WINDOW_MS) lastRefusalAt.delete(k);
    }
  }
  lastRefusalAt.set(key, now);
  return true;
}

/** Test hook: forget all recorded refusals. */
export function resetResumeRefusalLimiter(): void {
  lastRefusalAt.clear();
}
