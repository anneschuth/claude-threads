import { describe, test, expect } from 'bun:test';
import {
  SPONSOR_URL,
  SESSION_MILESTONES,
  MILESTONE_VISIBLE_MS,
  milestoneReached,
  milestoneStillFresh,
  formatSponsorFooter,
  formatMilestoneLine,
} from './sponsor.js';
import { createMockFormatter } from './test-utils/mock-formatter.js';

describe('milestoneReached', () => {
  test('returns the milestone for exact matches', () => {
    for (const m of SESSION_MILESTONES) {
      expect(milestoneReached(m)).toBe(m);
    }
  });

  test('returns null for non-milestone counts', () => {
    expect(milestoneReached(0)).toBeNull();
    expect(milestoneReached(1)).toBeNull();
    expect(milestoneReached(99)).toBeNull();
    expect(milestoneReached(101)).toBeNull();
    expect(milestoneReached(499)).toBeNull();
    expect(milestoneReached(10001)).toBeNull();
  });
});

describe('milestoneStillFresh', () => {
  const now = Date.parse('2026-08-03T12:00:00Z');

  test('fresh within the visibility window', () => {
    expect(milestoneStillFresh('2026-08-03T11:00:00Z', now)).toBe(true);
    expect(milestoneStillFresh(new Date(now - MILESTONE_VISIBLE_MS + 1000).toISOString(), now)).toBe(true);
  });

  test('stale after the visibility window', () => {
    expect(milestoneStillFresh(new Date(now - MILESTONE_VISIBLE_MS).toISOString(), now)).toBe(false);
    expect(milestoneStillFresh('2026-08-01T11:00:00Z', now)).toBe(false);
  });

  test('rejects malformed and future timestamps', () => {
    expect(milestoneStillFresh('not-a-date', now)).toBe(false);
    expect(milestoneStillFresh('', now)).toBe(false);
    expect(milestoneStillFresh(new Date(now + 60_000).toISOString(), now)).toBe(false);
  });
});

describe('formatting', () => {
  const formatter = createMockFormatter();

  test('footer links to the sponsor page', () => {
    const footer = formatSponsorFooter(formatter);
    expect(footer).toContain(SPONSOR_URL);
    expect(footer).toContain('♥');
    expect(footer).toStartWith('_');
  });

  test('milestone line mentions the session number and sponsor link', () => {
    const line = formatMilestoneLine(formatter, 500);
    expect(line).toContain('Session #500');
    expect(line).toContain(SPONSOR_URL);
    expect(line).toContain('🎉');
  });
});
