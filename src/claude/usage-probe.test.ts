import { describe, it, expect } from 'bun:test';
import { parseUsageOutput, usageLoadScore } from './usage-probe.js';

const REAL_OUTPUT = `You are currently using your subscription to power your Claude Code usage

Current session: 4% used · resets Jul 4 at 2:20am (Asia/Bangkok)
Current week (all models): 6% used · resets Jul 5 at 4pm (Asia/Bangkok)
Current week (Fable): 0% used

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.

Last 24h · 302 requests · 3 sessions
  98% of your usage came from sessions active for 8+ hours`;

describe('parseUsageOutput', () => {
  it('parses a real /usage report', () => {
    const usage = parseUsageOutput(REAL_OUTPUT);
    expect(usage).not.toBeNull();
    expect(usage!.sessionPct).toBe(4);
    expect(usage!.weekAllModelsPct).toBe(6);
    expect(usage!.weekPerModelPct).toBe(0);
    expect(usage!.sessionResetsAt).toBe('Jul 4 at 2:20am (Asia/Bangkok)');
    expect(usage!.weekResetsAt).toBe('Jul 5 at 4pm (Asia/Bangkok)');
  });

  it('takes the highest per-model weekly percentage', () => {
    const usage = parseUsageOutput(
      `Current session: 10% used
Current week (all models): 20% used
Current week (Fable): 5% used
Current week (Opus): 40% used`
    );
    expect(usage!.weekPerModelPct).toBe(40);
  });

  it('does not treat the (all models) line as a per-model line', () => {
    const usage = parseUsageOutput(
      `Current session: 1% used
Current week (all models): 90% used`
    );
    expect(usage!.weekAllModelsPct).toBe(90);
    expect(usage!.weekPerModelPct).toBeNull();
  });

  it('accepts a bare "Current week:" line without the (all models) qualifier', () => {
    // Guards against a CLI phrasing change silently zeroing the weekly %.
    const usage = parseUsageOutput(
      `Current session: 3% used
Current week: 80% used · resets Jul 5 at 4pm`
    );
    expect(usage!.weekAllModelsPct).toBe(80);
    expect(usage!.weekPerModelPct).toBeNull();
    expect(usage!.weekResetsAt).toBe('Jul 5 at 4pm');
  });

  it('handles missing reset hints', () => {
    const usage = parseUsageOutput(
      `Current session: 50% used
Current week (all models): 12% used`
    );
    expect(usage!.sessionResetsAt).toBeNull();
    expect(usage!.weekResetsAt).toBeNull();
  });

  it('clamps out-of-range percentages', () => {
    const usage = parseUsageOutput(`Current session: 150% used
Current week (all models): 0% used`);
    expect(usage!.sessionPct).toBe(100);
  });

  it('returns null for non-subscription / unrecognized output', () => {
    expect(parseUsageOutput('some unrelated text')).toBeNull();
    expect(parseUsageOutput('')).toBeNull();
  });
});

describe('usageLoadScore', () => {
  it('returns the most-constrained window', () => {
    expect(
      usageLoadScore({
        sessionPct: 4,
        weekAllModelsPct: 6,
        weekPerModelPct: 0,
        sessionResetsAt: null,
        weekResetsAt: null,
      })
    ).toBe(6);
  });

  it('counts a throttled single model against headroom', () => {
    expect(
      usageLoadScore({
        sessionPct: 4,
        weekAllModelsPct: 6,
        weekPerModelPct: 95,
        sessionResetsAt: null,
        weekResetsAt: null,
      })
    ).toBe(95);
  });

  it('tolerates a null per-model percentage', () => {
    expect(
      usageLoadScore({
        sessionPct: 30,
        weekAllModelsPct: 10,
        weekPerModelPct: null,
        sessionResetsAt: null,
        weekResetsAt: null,
      })
    ).toBe(30);
  });
});
