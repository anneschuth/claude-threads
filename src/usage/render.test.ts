import { describe, it, expect } from 'bun:test';
import { renderUsage, renderProfiles, type UsageLimit } from './render.js';

const limits: UsageLimit[] = [
  { kind: 'session', percent: 14, resetsAt: '11:50pm' },
  { kind: 'weekly_all', percent: 3, resetsAt: 'Sep 2 at 3am' },
  { kind: 'weekly_scoped', percent: 4, resetsAt: 'Sep 2 at 3am', model: 'Fable' },
];

describe('renderUsage', () => {
  it('renders the three blocks in session, weekly-all, weekly-scoped order', () => {
    const out = renderUsage(limits);
    const headings = out.split('\n').filter((l) => l.startsWith('Current'));

    expect(headings).toEqual([
      'Current session',
      'Current week (all models)',
      'Current week (Fable)',
    ]);
  });

  it('prints the reset hint verbatim, as `/usage` phrased it', () => {
    const out = renderUsage(limits);

    expect(out).toContain('Resets 11:50pm');
    expect(out).toContain('Resets Sep 2 at 3am');
  });

  it('omits the reset line entirely when the probe saw no hint', () => {
    // Better a missing line than "Resets undefined" — and better than a
    // fabricated timestamp, which is what parsing the absent hint into a Date
    // would have produced.
    const out = renderUsage([{ kind: 'session', percent: 14 }]);

    expect(out).toContain('14% used');
    expect(out).not.toContain('Resets');
  });

  it('renders a bar whose fill tracks the percentage', () => {
    const out = renderUsage(
      [{ kind: 'session', percent: 50, resetsAt: '11:50pm' }],
      { barWidth: 10 }
    );
    const bar = out.split('\n').find((l) => l.includes('█') || l.includes('░'));

    expect(bar).toContain('█████░░░░░');
    expect(bar).toContain('50% used');
  });

  it('never renders an empty bar for non-zero usage, nor a full bar below 100%', () => {
    const width = 10;
    const tiny = renderUsage(
      [{ kind: 'session', percent: 1, resetsAt: '11:50pm' }],
      { barWidth: width }
    );
    const nearly = renderUsage(
      [{ kind: 'session', percent: 99, resetsAt: '11:50pm' }],
      { barWidth: width }
    );

    // 1% of 10 rounds to 0 and 99% rounds to 10 — both would lie about the state.
    expect(tiny).toContain('█░░░░░░░░░');
    expect(nearly).toContain('█████████░');
  });

  it('omits a limit the API did not return rather than inventing a zero', () => {
    const out = renderUsage([limits[0]]);

    expect(out).toContain('Current session');
    expect(out).not.toContain('Current week');
  });

  it('names the scoped week by its model', () => {
    const out = renderUsage(
      [{ kind: 'weekly_scoped', percent: 7, resetsAt: 'Sep 2 at 3am', model: 'Opus' }]
    );

    expect(out).toContain('Current week (Opus)');
  });
});

describe('renderProfiles', () => {
  it('hides the account email by default', () => {
    // These addresses are new information in a channel several people can
    // read. A bot that posts them because nobody opted out is the wrong
    // default, however useful they are to the operator who turns it on.
    const out = renderProfiles([{ profile: 'vvs', email: 'user@example.test', limits }]);

    expect(out).not.toContain('user@example.test');
    expect(out.split('\n')[0]).toBe('vvs');
  });

  it('shows the full account email, unredacted, when showEmails is on', () => {
    // Knowing WHICH account a seat is logged in as is the whole point when
    // several profiles sit on one machine; a partial address answers nothing.
    const out = renderProfiles([{ profile: 'vvs', email: 'user@example.test', limits }], {
      showEmails: true,
    });

    expect(out).toContain('vvs (user@example.test)');
  });

  it('still heads a profile whose email could not be read', () => {
    const out = renderProfiles([{ profile: 'vvs', limits }]);
    expect(out.split('\n')[0]).toBe('vvs');
  });

  it('names the account on a failed profile too, so you know where to go', () => {
    const out = renderProfiles(
      [{ profile: 'vvs2', email: 'a@b.com', error: 'logged out' }],
      { showEmails: true }
    );
    expect(out).toContain('vvs2 (a@b.com)');
  });

  it('heads each profile with its name', () => {
    const out = renderProfiles(
      [
        { profile: 'vvs', limits },
        { profile: 'almir', limits: [limits[0]] },
      ]
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
      ]
    );

    expect(out).toContain('broken');
    expect(out).toContain('no credentials found');
  });
});
