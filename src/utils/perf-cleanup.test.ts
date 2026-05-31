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

    // Wait for at least one tick.
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Without the cleanup these entries would persist (and leak); the helper
    // must have drained the buffer (#394).
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
