import { describe, it, expect } from 'bun:test';
import { nextPermissionMode, PERMISSION_MODE_CYCLE } from './permission-mode-cycle.js';

describe('nextPermissionMode', () => {
  it('cycles default → auto → bypass → default', () => {
    expect(nextPermissionMode('default')).toBe('auto');
    expect(nextPermissionMode('auto')).toBe('bypass');
    expect(nextPermissionMode('bypass')).toBe('default');
  });

  it('covers every mode in the cycle exactly once before repeating', () => {
    const seen = new Set<string>();
    let mode = PERMISSION_MODE_CYCLE[0];
    for (let i = 0; i < PERMISSION_MODE_CYCLE.length; i++) {
      seen.add(mode);
      mode = nextPermissionMode(mode);
    }
    expect(seen.size).toBe(PERMISSION_MODE_CYCLE.length);
    // After a full rotation we're back to the start.
    expect(mode).toBe(PERMISSION_MODE_CYCLE[0]);
  });

  it('defensively falls back to the first mode on an unknown input', () => {
    // Not reachable at the type level; this guards against malformed
    // runtime data (e.g. a future mode added to persisted settings).
    expect(nextPermissionMode('something-unknown' as never)).toBe(PERMISSION_MODE_CYCLE[0]);
  });
});
