import { describe, it, expect } from 'bun:test';
import { shouldPostLifecycle, type LifecyclePost } from './lifecycle-visibility.js';

const KINDS: LifecyclePost[] = ['idle-warning', 'timed-out', 'paused', 'abnormal-exit'];

describe('shouldPostLifecycle', () => {
  it('posts everything at full, which is today\'s behaviour', () => {
    for (const kind of KINDS) {
      expect(shouldPostLifecycle('full', kind)).toBe(true);
    }
  });

  it('drops only the predictive warning at minimal', () => {
    // "will timeout in ~N minutes" is advice about something that has not
    // happened and usually never does — the next message resumes anyway. The
    // other three report a state change that already occurred.
    expect(shouldPostLifecycle('minimal', 'idle-warning')).toBe(false);
    expect(shouldPostLifecycle('minimal', 'timed-out')).toBe(true);
    expect(shouldPostLifecycle('minimal', 'paused')).toBe(true);
    expect(shouldPostLifecycle('minimal', 'abnormal-exit')).toBe(true);
  });

  it('keeps an abnormal exit even at hidden', () => {
    // `[Exited: <code>]` is only posted for a non-zero exit: it is a failure
    // report, not overhead. Silencing it would leave a session that died
    // looking exactly like one that finished — the single case where quiet is
    // worse than noisy.
    expect(shouldPostLifecycle('hidden', 'idle-warning')).toBe(false);
    expect(shouldPostLifecycle('hidden', 'timed-out')).toBe(false);
    expect(shouldPostLifecycle('hidden', 'paused')).toBe(false);
    expect(shouldPostLifecycle('hidden', 'abnormal-exit')).toBe(true);
  });

  it('never silences a failure at any level', () => {
    for (const level of ['full', 'minimal', 'hidden'] as const) {
      expect(shouldPostLifecycle(level, 'abnormal-exit')).toBe(true);
    }
  });
});
