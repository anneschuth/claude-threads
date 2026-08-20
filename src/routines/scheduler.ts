/**
 * RoutineScheduler — fires stored routines on their schedule.
 *
 * Due-ness is computed from the routine's WALL-CLOCK time in its own
 * timezone (via Intl), never from precomputed next-run timestamps — that
 * sidesteps DST arithmetic entirely: "daily at 09:00 Europe/Amsterdam" means
 * whatever instant 09:00 local is that day, on both sides of a DST switch.
 *
 * Double-fire and missed-fire protection is period anchoring: a routine
 * fires at most once per period (hour/day/week), tracked by comparing the
 * period key of `now` against the period key of `lastRunAt`. A window missed
 * entirely (bot down past the tolerance) is skipped, not back-filled —
 * documented v1 policy.
 *
 * The tick loop mirrors SessionMonitor (src/operations/monitor/handler.ts):
 * constructed by SessionManager, started in initialize(), stopped on
 * shutdown. All effects go through injected callbacks so the class is fully
 * unit-testable without a bot.
 */

import { createLogger } from '../utils/logger.js';
import {
  MAX_CONSECUTIVE_FAILURES,
  type Routine,
  type RoutinesStore,
  type RoutineRunStatus,
} from '../persistence/routines-store.js';

const log = createLogger('routines');

const DEFAULT_INTERVAL_MS = 60 * 1000;

/**
 * A firing window stays open this long after the scheduled minute. Wide
 * enough to survive tick jitter and short pauses; period anchoring prevents
 * a second fire inside the same period regardless of the window width.
 */
export const FIRE_WINDOW_MS = 5 * 60 * 1000;

/** Wall-clock parts of an instant in a given IANA timezone. */
export interface LocalParts {
  year: number;
  month: number;   // 1-12
  day: number;     // 1-31
  hour: number;    // 0-23
  minute: number;  // 0-59
  isoWeekday: number; // 1 (Mon) – 7 (Sun)
}

const WEEKDAY_TO_ISO: Record<string, number> = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
};

/** Decompose an instant into wall-clock parts in `timeZone`. */
export function getLocalParts(date: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) {
    parts[p.type] = p.value;
  }
  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    // Intl may render midnight as "24" with hour12: false ("h24" quirk).
    hour: parseInt(parts.hour, 10) % 24,
    minute: parseInt(parts.minute, 10),
    isoWeekday: WEEKDAY_TO_ISO[parts.weekday] ?? 0,
  };
}

/**
 * The period key an instant belongs to for a schedule: at most one fire per
 * key. Hour-granular for hourly, day-granular otherwise (weekly is also
 * day-granular — the weekday gate makes at most one qualifying day per week).
 */
export function periodKey(routine: Routine, date: Date): string {
  const p = getLocalParts(date, routine.schedule.timezone);
  const day = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  return routine.schedule.preset === 'hourly' ? `${day}T${String(p.hour).padStart(2, '0')}` : day;
}

/**
 * Whether the routine's firing window is open at `now` (ignores lastRunAt).
 */
export function isInFireWindow(routine: Routine, now: Date): boolean {
  const { schedule } = routine;
  const p = getLocalParts(now, schedule.timezone);

  if (schedule.preset === 'hourly') {
    return p.minute * 60 * 1000 < FIRE_WINDOW_MS;
  }

  if (schedule.preset === 'weekdays' && (p.isoWeekday < 1 || p.isoWeekday > 5)) return false;
  if (schedule.preset === 'weekly' && p.isoWeekday !== schedule.weekday) return false;

  const [hh, mm] = (schedule.time ?? '00:00').split(':').map((s) => parseInt(s, 10));
  const nowMs = (p.hour * 60 + p.minute) * 60 * 1000;
  const schedMs = (hh * 60 + mm) * 60 * 1000;
  if (nowMs >= schedMs && nowMs - schedMs < FIRE_WINDOW_MS) return true;

  // DST spring-forward: a scheduled time inside the skipped hour (e.g. 02:30
  // Europe/Amsterdam on the last Sunday of March) is never rendered by the
  // wall clock, so the check above stays false all day. If the wall clock
  // jumped OVER the scheduled time within the last window-span, the window is
  // open now: fire at the first minutes after the gap. Same-day guard keeps
  // this from bleeding across midnight into the previous day's schedule.
  const prev = getLocalParts(new Date(now.getTime() - FIRE_WINDOW_MS), schedule.timezone);
  const sameDay = prev.year === p.year && prev.month === p.month && prev.day === p.day;
  const prevMs = (prev.hour * 60 + prev.minute) * 60 * 1000;
  return sameDay && prevMs < schedMs && nowMs >= schedMs;
}

/**
 * True when the routine should fire now: enabled, window open, and not
 * already fired in this period.
 */
export function isRoutineDue(routine: Routine, now: Date): boolean {
  if (!routine.enabled) return false;
  if (!isInFireWindow(routine, now)) return false;
  if (routine.lastRunAt) {
    const last = new Date(routine.lastRunAt);
    if (!Number.isNaN(last.getTime()) && periodKey(routine, last) === periodKey(routine, now)) {
      return false;
    }
  }
  return true;
}

export interface RoutineSchedulerOptions {
  store: RoutinesStore;
  /** Platform ids to scan each tick (only connected/registered platforms). */
  listPlatformIds(): string[];
  /** Per-platform feature toggle. */
  isRoutinesEnabled(platformId: string): boolean;
  /**
   * Fire one routine. Returns the run status; throwing counts as 'failed'.
   * 'skipped' (e.g. MAX_SESSIONS reached) does not advance the period anchor
   * or the failure counter — the routine retries within its window.
   * 'unauthorized' disables the routine (creator lost authorization).
   */
  fireRoutine(platformId: string, routine: Routine): Promise<RoutineRunStatus | 'unauthorized'>;
  /** Post a channel notice when a routine is auto-disabled. Best-effort. */
  notifyDisabled(platformId: string, routine: Routine, reason: string): Promise<void>;
  intervalMs?: number;
}

export class RoutineScheduler {
  private readonly opts: RoutineSchedulerOptions;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(opts: RoutineSchedulerOptions) {
    this.opts = opts;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick(new Date());
    }, this.intervalMs);
    // Immediate first pass: a restart that lands inside a firing window must
    // not lose the window to interval alignment (the first interval tick can
    // land just after the window closes).
    void this.tick(new Date());
    log.debug(`Routine scheduler started (interval: ${this.intervalMs / 1000}s)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One scheduler pass. Public for tests and for `!routines run` reuse. */
  async tick(now: Date): Promise<void> {
    if (this.ticking) return; // a slow tick must not overlap the next
    this.ticking = true;
    try {
      for (const platformId of this.opts.listPlatformIds()) {
        if (!this.opts.isRoutinesEnabled(platformId)) continue;
        for (const routine of this.opts.store.list(platformId)) {
          if (!isRoutineDue(routine, now)) continue;
          await this.fire(platformId, routine, now);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Fire one routine and record the outcome. Shared by the tick loop and the
   * manual `!routines run` path (manual runs pass `anchorPeriod: false` so
   * they never consume the scheduled fire of the current period).
   */
  async fire(platformId: string, routine: Routine, now: Date, anchorPeriod = true): Promise<RoutineRunStatus | 'unauthorized'> {
    let status: RoutineRunStatus | 'unauthorized';
    try {
      status = await this.opts.fireRoutine(platformId, routine);
    } catch (err) {
      log.warn(`Routine "${routine.name}" (${platformId}) failed: ${(err as Error).message}`);
      status = 'failed';
    }

    if (status === 'unauthorized') {
      await this.opts.store.update(platformId, routine.id, { enabled: false, lastRunStatus: 'failed' });
      await this.opts.notifyDisabled(platformId, routine,
        `its creator @${routine.createdBy} is no longer authorized on this platform`);
      return status;
    }

    if (status === 'skipped') {
      // No anchor, no failure count: retry within the window, next tick.
      await this.opts.store.update(platformId, routine.id, { lastRunStatus: 'skipped' });
      return status;
    }

    if (!anchorPeriod) {
      // Manual `!routines run`: record the outcome, but never touch the
      // scheduled-run failure streak — three manual retries of a broken
      // routine must not auto-disable it, and a manual success must not mask
      // scheduled failures that should disable it.
      await this.opts.store.update(platformId, routine.id, { lastRunStatus: status });
      return status;
    }

    const failures = status === 'failed' ? routine.consecutiveFailures + 1 : 0;
    await this.opts.store.update(platformId, routine.id, {
      lastRunAt: now.toISOString(),
      lastRunStatus: status,
      consecutiveFailures: failures,
    });

    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      await this.opts.store.update(platformId, routine.id, { enabled: false });
      await this.opts.notifyDisabled(platformId, routine,
        `${failures} consecutive runs failed`);
    }
    return status;
  }
}
