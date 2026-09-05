/**
 * Mapping the probe's percentages onto the three rendered windows.
 */

import { describe, it, expect } from 'bun:test';
import { toLimits } from './index.js';
import type { AccountUsage } from '../claude/usage-probe.js';

function usage(overrides: Partial<AccountUsage> = {}): AccountUsage {
  return {
    sessionPct: 14,
    weekAllModelsPct: 3,
    weekPerModelPct: 62,
    sessionResetsAt: '11:50pm',
    weekResetsAt: 'Sep 2 at 3am',
    ...overrides,
  };
}

describe('toLimits', () => {
  it('maps the three windows in the order the renderer expects', () => {
    expect(toLimits(usage()).map((l) => [l.kind, l.percent])).toEqual([
      ['session', 14],
      ['weekly_all', 3],
      ['weekly_scoped', 62],
    ]);
  });

  it('keeps the scoped week separate from the all-models week', () => {
    // The trap this command exists for: a seat reads 3% overall and 100% on
    // its model-scoped week. Collapsing them into one number reports headroom
    // that is not there.
    const limits = toLimits(usage({ weekAllModelsPct: 3, weekPerModelPct: 100 }));

    expect(limits.find((l) => l.kind === 'weekly_all')?.percent).toBe(3);
    expect(limits.find((l) => l.kind === 'weekly_scoped')?.percent).toBe(100);
  });

  it('omits the scoped row when the probe saw no per-model line', () => {
    // `null` means "not reported", which is not the same as 0% used. A zero
    // row would render as measured headroom on a window nobody measured.
    const limits = toLimits(usage({ weekPerModelPct: null }));

    expect(limits.map((l) => l.kind)).toEqual(['session', 'weekly_all']);
  });

  it('carries the reset hints through verbatim, and absent ones as absent', () => {
    const withHints = toLimits(usage());
    expect(withHints[0].resetsAt).toBe('11:50pm');
    expect(withHints[1].resetsAt).toBe('Sep 2 at 3am');

    // `null` from the probe must become `undefined`, not the string "null" —
    // the renderer decides to omit the line on undefined.
    const without = toLimits(usage({ sessionResetsAt: null, weekResetsAt: null }));
    expect(without.every((l) => l.resetsAt === undefined)).toBe(true);
  });
});
