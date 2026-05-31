/**
 * Periodically clear buffered Performance API "measure" entries.
 *
 * React 19 enables user timing when both `console.timeStamp` and
 * `performance.measure` exist, which is the case on Node.js 25+ (the runtime
 * the bot ships against). Every component re-render then calls
 * `performance.measure()` with a structured-clone'd prop-diff `detail`, and
 * Node buffers each `PerformanceMeasure` entry indefinitely (~50-205 KB each,
 * ~2 GB after a long uptime → OOM). Nothing in the bot reads these entries,
 * so we drop them on a timer.
 *
 * The `typeof ... === 'function'` guard keeps this safe across Node versions
 * and non-Node runtimes. The returned interval is `.unref()`'d so it never
 * blocks a clean process exit; callers may also clear it explicitly.
 *
 * @param intervalMs - How often to clear (default 60s).
 * @returns The interval timer, or `null` if the runtime has no usable
 *          `performance.clearMeasures` (in which case nothing was scheduled).
 */
export function startReactMeasureCleanup(
  intervalMs = 60_000
): ReturnType<typeof setInterval> | null {
  if (
    typeof performance === 'undefined' ||
    typeof performance.clearMeasures !== 'function'
  ) {
    return null;
  }

  const timer = setInterval(() => {
    performance.clearMeasures();
  }, intervalMs);

  // Don't keep the event loop alive solely for this housekeeping timer.
  timer.unref?.();

  return timer;
}
