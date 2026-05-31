import { describe, it, expect, afterEach } from 'bun:test';
import { startReactMeasureCleanup } from './perf-cleanup.js';

describe('startReactMeasureCleanup', () => {
  let timer: ReturnType<typeof setInterval> | null = null;

  afterEach(() => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    performance.clearMeasures?.();
  });

  it('clears buffered measure entries when the interval fires', async () => {
    // Simulate React 19's per-render measures accumulating in the buffer.
    // (Plain measures; the leak is the buffered entries, not their payload,
    // and the runtimes differ on the `{ detail }` form.)
    for (let i = 0; i < 10; i++) {
      performance.measure(`render-${i}`);
    }
    expect(performance.getEntriesByType('measure').length).toBeGreaterThan(0);

    // Short interval so the test doesn't wait the production 60s.
    timer = startReactMeasureCleanup(10);
    expect(timer).not.toBeNull();

    // Poll until the buffer drains, bounded by a generous deadline. This passes
    // as soon as a tick fires (no fixed sleep to race against a loaded CI box),
    // and only fails if cleanup never happens — preserving the RED signal when
    // the fix is removed (#394).
    const deadline = Date.now() + 1000;
    while (
      performance.getEntriesByType('measure').length > 0 &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Without the cleanup these entries would persist (and leak); the helper
    // must have drained the buffer.
    expect(performance.getEntriesByType('measure').length).toBe(0);
  });

  it('returns null and schedules nothing when clearMeasures is unavailable', () => {
    const original = performance.clearMeasures;
    try {
      // @ts-expect-error - intentionally remove for the guard test
      performance.clearMeasures = undefined;
      const result = startReactMeasureCleanup(10);
      expect(result).toBeNull();
    } finally {
      performance.clearMeasures = original;
    }
  });
});
