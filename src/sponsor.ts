/**
 * Sponsor touchpoints — constants and pure helpers for the GitHub Sponsors
 * link shown across the product.
 *
 * Placement principle: the ask appears at moments of delivered value or
 * explicit pull (!help, !release-notes, milestones), never pushed into
 * shared chat space on a per-session basis.
 */
import type { PlatformFormatter } from './platform/formatter.js';

export const SPONSOR_URL = 'https://github.com/sponsors/axolotl-systems';

/**
 * Cumulative per-instance session counts that trigger a short-lived
 * celebration line in the sticky channel message.
 */
export const SESSION_MILESTONES = [100, 250, 500, 1000, 2500, 5000, 10000];

/** How long a milestone celebration stays visible in the sticky. */
export const MILESTONE_VISIBLE_MS = 24 * 60 * 60 * 1000;

/**
 * Returns the milestone number when the given cumulative session count is
 * exactly a milestone, or null otherwise. Exact match only — the counter
 * increments by one per session start, so a milestone can't be skipped.
 */
export function milestoneReached(totalSessions: number): number | null {
  return SESSION_MILESTONES.includes(totalSessions) ? totalSessions : null;
}

/**
 * Whether a reached milestone should still be displayed. Malformed or
 * future-dated timestamps hide the celebration rather than pinning it.
 */
export function milestoneStillFresh(reachedAtIso: string, nowMs: number): boolean {
  const reachedAt = Date.parse(reachedAtIso);
  if (Number.isNaN(reachedAt)) return false;
  const age = nowMs - reachedAt;
  return age >= 0 && age < MILESTONE_VISIBLE_MS;
}

/** One-line footer for on-demand replies (!help, !release-notes). */
export function formatSponsorFooter(formatter: PlatformFormatter): string {
  return formatter.formatItalic(
    `♥ Support claude-threads: ${formatter.formatLink('github.com/sponsors/axolotl-systems', SPONSOR_URL)}`
  );
}

/** Celebration line for the sticky channel message. */
export function formatMilestoneLine(formatter: PlatformFormatter, milestone: number): string {
  return `🎉 ${formatter.formatBold(`Session #${milestone}`)} on this instance — claude-threads is free & open source ${formatter.formatLink('♥ sponsor', SPONSOR_URL)}`;
}
