import { describe, it, expect } from 'bun:test';
import { renderUsage, renderProfiles, type UsageLimit } from './render.js';

const TZ = 'Europe/London';
// 2026-09-01 20:00 UTC = 21:00 Europe/London (BST), so "today" in London.
const NOW = new Date('2026-09-01T20:00:00Z');

const limits: UsageLimit[] = [
  { kind: 'session', percent: 14, resetsAt: new Date('2026-09-01T22:50:00Z') },
  { kind: 'weekly_all', percent: 3, resetsAt: new Date('2026-09-02T02:00:00Z') },
  { kind: 'weekly_scoped', percent: 4, resetsAt: new Date('2026-09-02T02:00:00Z'), model: 'Fable' },
];

describe('renderUsage', () => {
  it('renders the three blocks in session, weekly-all, weekly-scoped order', () => {
    const out = renderUsage(limits, { now: NOW, timeZone: TZ });
    const headings = out.split('\n').filter((l) => l.startsWith('Current'));

    expect(headings).toEqual([
      'Current session',
      'Current week (all models)',
      'Current week (Fable)',
    ]);
  });

  it('shows a reset later today as a bare time, and a later day with its date', () => {
    const out = renderUsage(limits, { now: NOW, timeZone: TZ });

    expect(out).toContain('Resets 11:50pm (Europe/London)');
    expect(out).toContain('Resets Sep 2 at 3am (Europe/London)');
  });

  it('renders a bar whose fill tracks the percentage', () => {
    const out = renderUsage(
      [{ kind: 'session', percent: 50, resetsAt: new Date('2026-09-01T22:50:00Z') }],
      { now: NOW, timeZone: TZ, barWidth: 10 }
    );
    const bar = out.split('\n').find((l) => l.includes('█') || l.includes('░'));

    expect(bar).toContain('█████░░░░░');
    expect(bar).toContain('50% used');
  });

  it('never renders an empty bar for non-zero usage, nor a full bar below 100%', () => {
    const width = 10;
    const tiny = renderUsage(
      [{ kind: 'session', percent: 1, resetsAt: new Date('2026-09-01T22:50:00Z') }],
      { now: NOW, timeZone: TZ, barWidth: width }
    );
    const nearly = renderUsage(
      [{ kind: 'session', percent: 99, resetsAt: new Date('2026-09-01T22:50:00Z') }],
      { now: NOW, timeZone: TZ, barWidth: width }
    );

    // 1% of 10 rounds to 0 and 99% rounds to 10 — both would lie about the state.
    expect(tiny).toContain('█░░░░░░░░░');
    expect(nearly).toContain('█████████░');
  });

  it('omits a limit the API did not return rather than inventing a zero', () => {
    const out = renderUsage([limits[0]], { now: NOW, timeZone: TZ });

    expect(out).toContain('Current session');
    expect(out).not.toContain('Current week');
  });

  it('names the scoped week by its model', () => {
    const out = renderUsage(
      [{ kind: 'weekly_scoped', percent: 7, resetsAt: NOW, model: 'Opus' }],
      { now: NOW, timeZone: TZ }
    );

    expect(out).toContain('Current week (Opus)');
  });
});

describe('renderProfiles', () => {
  it('shows the full account email beside the profile name, unredacted', () => {
    const out = renderProfiles(
      [{ profile: 'vvs', email: 'user@example.test', limits }],
      { now: NOW, timeZone: TZ }
    );

    // Knowing WHICH account a seat is logged in as is the whole point when
    // several profiles sit on one machine; a partial address answers nothing.
    expect(out).toContain('vvs (user@example.test)');
  });

  it('still heads a profile whose email could not be read', () => {
    const out = renderProfiles([{ profile: 'vvs', limits }], { now: NOW, timeZone: TZ });
    expect(out.split('\n')[0]).toBe('vvs');
  });

  it('names the account on a failed profile too, so you know where to go', () => {
    const out = renderProfiles(
      [{ profile: 'vvs2', email: 'a@b.com', error: 'logged out' }],
      { now: NOW, timeZone: TZ }
    );
    expect(out).toContain('vvs2 (a@b.com)');
  });

  it('heads each profile with its name', () => {
    const out = renderProfiles(
      [
        { profile: 'vvs', limits },
        { profile: 'almir', limits: [limits[0]] },
      ],
      { now: NOW, timeZone: TZ }
    );

    expect(out).toContain('vvs');
    expect(out).toContain('almir');
    expect(out.indexOf('vvs')).toBeLessThan(out.indexOf('almir'));
  });

  it('reports a profile that failed instead of dropping it silently', () => {
    const out = renderProfiles(
      [
        { profile: 'vvs', limits },
        { profile: 'broken', error: 'no credentials found' },
      ],
      { now: NOW, timeZone: TZ }
    );

    expect(out).toContain('broken');
    expect(out).toContain('no credentials found');
  });
});
