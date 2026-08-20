/**
 * Tests for routine due-ness (wall-clock windows, timezones, DST, period
 * anchoring) and the scheduler's fire bookkeeping. These exercise the ACTUAL
 * exported functions per the red-green policy.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getLocalParts,
  periodKey,
  isInFireWindow,
  isRoutineDue,
  RoutineScheduler,
} from './scheduler.js';
import { RoutinesStore, type Routine, MAX_CONSECUTIVE_FAILURES } from '../persistence/routines-store.js';

function makeRoutine(overrides: Omit<Partial<Routine>, 'schedule'> & { schedule?: Partial<Routine['schedule']> } = {}): Routine {
  const { schedule, ...rest } = overrides;
  return {
    id: 'r1',
    name: 'Test routine',
    prompt: 'do the thing',
    schedule: { preset: 'daily', time: '09:00', timezone: 'Europe/Amsterdam', ...schedule },
    createdBy: 'anne',
    createdAt: '2026-01-01T00:00:00Z',
    enabled: true,
    consecutiveFailures: 0,
    ...rest,
  } as Routine;
}

describe('getLocalParts', () => {
  test('decomposes an instant in a timezone', () => {
    // 2026-08-19T07:30Z is 09:30 CEST on a Wednesday
    const p = getLocalParts(new Date('2026-08-19T07:30:00Z'), 'Europe/Amsterdam');
    expect(p).toMatchObject({ year: 2026, month: 8, day: 19, hour: 9, minute: 30, isoWeekday: 3 });
  });

  test('midnight is hour 0, not 24 (Intl h24 quirk)', () => {
    const p = getLocalParts(new Date('2026-08-19T22:00:00Z'), 'Europe/Amsterdam'); // 00:00 CEST next day
    expect(p.hour).toBe(0);
    expect(p.day).toBe(20);
  });
});

describe('isInFireWindow', () => {
  test('daily: open at the scheduled minute, closed before and after the window', () => {
    const r = makeRoutine(); // daily 09:00 Amsterdam (CEST in August = UTC+2 → 07:00Z)
    expect(isInFireWindow(r, new Date('2026-08-19T06:59:00Z'))).toBe(false);
    expect(isInFireWindow(r, new Date('2026-08-19T07:00:00Z'))).toBe(true);
    expect(isInFireWindow(r, new Date('2026-08-19T07:04:00Z'))).toBe(true);
    expect(isInFireWindow(r, new Date('2026-08-19T07:05:00Z'))).toBe(false);
  });

  test('DST spring-forward: 09:00 local tracks the wall clock, not a fixed UTC offset', () => {
    const r = makeRoutine();
    // 2026-03-28 is CET (UTC+1): 09:00 local = 08:00Z
    expect(isInFireWindow(r, new Date('2026-03-28T08:00:00Z'))).toBe(true);
    expect(isInFireWindow(r, new Date('2026-03-28T07:00:00Z'))).toBe(false);
    // 2026-03-29 is the switch day, CEST (UTC+2) by 09:00: 09:00 local = 07:00Z
    expect(isInFireWindow(r, new Date('2026-03-29T07:00:00Z'))).toBe(true);
    expect(isInFireWindow(r, new Date('2026-03-29T08:00:00Z'))).toBe(false);
  });

  test('DST fall-back: same wall-clock behavior on the other switch', () => {
    const r = makeRoutine();
    // 2026-10-24 is CEST: 09:00 = 07:00Z; 2026-10-25 is CET by 09:00: 09:00 = 08:00Z
    expect(isInFireWindow(r, new Date('2026-10-24T07:00:00Z'))).toBe(true);
    expect(isInFireWindow(r, new Date('2026-10-25T08:00:00Z'))).toBe(true);
    expect(isInFireWindow(r, new Date('2026-10-25T07:00:00Z'))).toBe(false);
  });

  test('weekdays: closed on weekends', () => {
    const r = makeRoutine({ schedule: { preset: 'weekdays' } });
    // 2026-08-22 is a Saturday; 09:00 CEST = 07:00Z
    expect(isInFireWindow(r, new Date('2026-08-22T07:00:00Z'))).toBe(false);
    // 2026-08-24 is a Monday
    expect(isInFireWindow(r, new Date('2026-08-24T07:00:00Z'))).toBe(true);
  });

  test('weekly: only on the configured weekday', () => {
    const r = makeRoutine({ schedule: { preset: 'weekly', weekday: 1 } }); // Mondays
    expect(isInFireWindow(r, new Date('2026-08-24T07:00:00Z'))).toBe(true);  // Mon
    expect(isInFireWindow(r, new Date('2026-08-25T07:00:00Z'))).toBe(false); // Tue
  });

  test('hourly: open in the first minutes of each hour', () => {
    const r = makeRoutine({ schedule: { preset: 'hourly', time: undefined } });
    expect(isInFireWindow(r, new Date('2026-08-19T13:02:00Z'))).toBe(true);
    expect(isInFireWindow(r, new Date('2026-08-19T13:30:00Z'))).toBe(false);
  });

  test('a timezone east of UTC crosses the date line correctly', () => {
    const r = makeRoutine({ schedule: { timezone: 'Asia/Tokyo' } }); // 09:00 JST = 00:00Z
    expect(isInFireWindow(r, new Date('2026-08-19T00:00:00Z'))).toBe(true);
    expect(isInFireWindow(r, new Date('2026-08-19T07:00:00Z'))).toBe(false);
  });

  test('DST spring-forward: a schedule inside the skipped hour fires right after the gap', () => {
    // 2026-03-29 Europe/Amsterdam: 02:00 CET jumps to 03:00 CEST — 02:30
    // never exists on the wall clock that day. The window opens at 03:00
    // local (01:00Z), when the clock has just jumped over the scheduled time.
    const r = makeRoutine({ schedule: { time: '02:30' } });
    expect(isInFireWindow(r, new Date('2026-03-29T01:00:00Z'))).toBe(true);  // 03:00 local
    expect(isInFireWindow(r, new Date('2026-03-29T01:04:00Z'))).toBe(true);  // 03:04 local
    expect(isInFireWindow(r, new Date('2026-03-29T01:10:00Z'))).toBe(false); // 03:10 local — gap window closed
    expect(isInFireWindow(r, new Date('2026-03-29T00:50:00Z'))).toBe(false); // 01:50 local — before the jump
    // The day after, 02:30 exists again and the normal window applies
    expect(isInFireWindow(r, new Date('2026-03-30T00:31:00Z'))).toBe(true);  // 02:31 CEST
  });

  test('DST spring-forward does not open a window for schedules outside the gap', () => {
    const r = makeRoutine({ schedule: { time: '09:00' } });
    expect(isInFireWindow(r, new Date('2026-03-29T01:01:00Z'))).toBe(false); // 03:01 local
    expect(isInFireWindow(r, new Date('2026-03-29T07:01:00Z'))).toBe(true);  // 09:01 CEST — normal window
  });
});

describe('isRoutineDue (period anchoring)', () => {
  test('disabled routines are never due', () => {
    const r = makeRoutine({ enabled: false });
    expect(isRoutineDue(r, new Date('2026-08-19T07:00:00Z'))).toBe(false);
  });

  test('daily: due once per local day — not again in the same window after firing', () => {
    const r = makeRoutine();
    expect(isRoutineDue(r, new Date('2026-08-19T07:01:00Z'))).toBe(true);
    const fired = makeRoutine({ lastRunAt: '2026-08-19T07:01:30Z' });
    expect(isRoutineDue(fired, new Date('2026-08-19T07:03:00Z'))).toBe(false);
    // Next day it is due again.
    expect(isRoutineDue(fired, new Date('2026-08-20T07:00:00Z'))).toBe(true);
  });

  test('hourly: once per hour', () => {
    const r = makeRoutine({ schedule: { preset: 'hourly', time: undefined }, lastRunAt: '2026-08-19T13:01:00Z' });
    expect(isRoutineDue(r, new Date('2026-08-19T13:03:00Z'))).toBe(false);
    expect(isRoutineDue(r, new Date('2026-08-19T14:01:00Z'))).toBe(true);
  });

  test('a window missed entirely is skipped, not back-filled', () => {
    // Fired two days ago; now it is 11:00 local (window long closed).
    const r = makeRoutine({ lastRunAt: '2026-08-17T07:01:00Z' });
    expect(isRoutineDue(r, new Date('2026-08-19T09:00:00Z'))).toBe(false);
  });

  test('period keys are computed in the routine timezone', () => {
    const r = makeRoutine({ schedule: { timezone: 'Asia/Tokyo' } });
    // 2026-08-19T23:30Z is already Aug 20 in Tokyo.
    expect(periodKey(r, new Date('2026-08-19T23:30:00Z'))).toBe('2026-08-20');
    expect(periodKey(r, new Date('2026-08-19T10:00:00Z'))).toBe('2026-08-19');
  });
});

describe('RoutineScheduler.fire bookkeeping', () => {
  let dir: string;
  let store: RoutinesStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ct-routines-test-'));
    store = new RoutinesStore(join(dir, 'routines.yaml'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function addRoutine(): Promise<Routine> {
    const result = await store.add('mm', {
      name: 'Standup',
      prompt: 'summarize',
      schedule: { preset: 'daily', time: '09:00', timezone: 'Europe/Amsterdam' },
      createdBy: 'anne',
    });
    if (!result.ok) throw new Error(result.error);
    return result.routine;
  }

  function makeScheduler(fireResult: () => Promise<'ok' | 'failed' | 'skipped' | 'unauthorized'>, notices: string[]) {
    return new RoutineScheduler({
      store,
      listPlatformIds: () => ['mm'],
      isRoutinesEnabled: () => true,
      fireRoutine: fireResult,
      notifyDisabled: async (_pid, routine, reason) => {
        notices.push(`${routine.name}: ${reason}`);
      },
    });
  }

  test('a successful fire anchors the period and resets failures', async () => {
    const routine = await addRoutine();
    await store.update('mm', routine.id, { consecutiveFailures: 2 });
    const scheduler = makeScheduler(async () => 'ok', []);
    await scheduler.fire('mm', store.get('mm', routine.id)!, new Date('2026-08-19T07:01:00Z'));
    const updated = store.get('mm', routine.id)!;
    expect(updated.lastRunStatus).toBe('ok');
    expect(updated.lastRunAt).toBe('2026-08-19T07:01:00.000Z');
    expect(updated.consecutiveFailures).toBe(0);
  });

  test('skipped runs do not anchor the period (retry within the window)', async () => {
    const routine = await addRoutine();
    const scheduler = makeScheduler(async () => 'skipped', []);
    await scheduler.fire('mm', routine, new Date('2026-08-19T07:01:00Z'));
    const updated = store.get('mm', routine.id)!;
    expect(updated.lastRunAt).toBeUndefined();
    expect(updated.lastRunStatus).toBe('skipped');
    expect(isRoutineDue(updated, new Date('2026-08-19T07:02:00Z'))).toBe(true);
  });

  test('auto-disables after consecutive failures, with a notice', async () => {
    const routine = await addRoutine();
    const notices: string[] = [];
    const scheduler = makeScheduler(async () => 'failed', notices);
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      await scheduler.fire('mm', store.get('mm', routine.id)!, new Date(`2026-08-${19 + i}T07:01:00Z`));
    }
    const updated = store.get('mm', routine.id)!;
    expect(updated.enabled).toBe(false);
    expect(updated.consecutiveFailures).toBe(MAX_CONSECUTIVE_FAILURES);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('consecutive runs failed');
  });

  test('an unauthorized creator disables the routine immediately', async () => {
    const routine = await addRoutine();
    const notices: string[] = [];
    const scheduler = makeScheduler(async () => 'unauthorized', notices);
    await scheduler.fire('mm', routine, new Date('2026-08-19T07:01:00Z'));
    expect(store.get('mm', routine.id)!.enabled).toBe(false);
    expect(notices[0]).toContain('no longer authorized');
  });

  test('a manual run (anchorPeriod=false) does not consume the scheduled fire', async () => {
    const routine = await addRoutine();
    const scheduler = makeScheduler(async () => 'ok', []);
    await scheduler.fire('mm', routine, new Date('2026-08-19T06:00:00Z'), false);
    const updated = store.get('mm', routine.id)!;
    expect(updated.lastRunAt).toBeUndefined();
    expect(isRoutineDue(updated, new Date('2026-08-19T07:01:00Z'))).toBe(true);
  });

  test('manual runs never touch the scheduled-run failure streak', async () => {
    const routine = await addRoutine();
    await store.update('mm', routine.id, { consecutiveFailures: 2 });
    const notices: string[] = [];

    // A manual failure must not push the streak to 3 (which would auto-disable)
    const failing = makeScheduler(async () => 'failed', notices);
    await failing.fire('mm', store.get('mm', routine.id)!, new Date('2026-08-19T06:00:00Z'), false);
    let updated = store.get('mm', routine.id)!;
    expect(updated.consecutiveFailures).toBe(2);
    expect(updated.enabled).toBe(true);
    expect(updated.lastRunStatus).toBe('failed');
    expect(notices).toHaveLength(0);

    // A manual success must not reset the streak either (a third scheduled
    // failure should still disable the routine)
    const succeeding = makeScheduler(async () => 'ok', notices);
    await succeeding.fire('mm', store.get('mm', routine.id)!, new Date('2026-08-19T06:05:00Z'), false);
    updated = store.get('mm', routine.id)!;
    expect(updated.consecutiveFailures).toBe(2);
    expect(updated.lastRunAt).toBeUndefined();
  });

  test('fire() never rejects when the store write fails (a crash here would kill the bot)', async () => {
    // The scheduler's tick promises float (setInterval callback) and the
    // manual-run path awaits fire() from a command handler: a store-write
    // rejection escaping fire() becomes an unhandled rejection → process exit.
    const brokenStore = {
      list: () => [],
      get: () => undefined,
      add: () => Promise.reject(new Error('disk full')),
      update: () => Promise.reject(new Error('disk full')),
      remove: () => Promise.reject(new Error('disk full')),
    } as unknown as RoutinesStore;
    const scheduler = new RoutineScheduler({
      store: brokenStore,
      listPlatformIds: () => ['mm'],
      isRoutinesEnabled: () => true,
      fireRoutine: async () => 'ok',
      notifyDisabled: async () => {},
    });
    // Every status path hits at least one store.update — none may reject out.
    await expect(scheduler.fire('mm', makeRoutine(), new Date('2026-08-19T07:01:00Z'))).resolves.toBe('ok');
    await expect(scheduler.fire('mm', makeRoutine(), new Date('2026-08-19T07:01:00Z'), false)).resolves.toBe('ok');

    const failing = new RoutineScheduler({
      store: brokenStore,
      listPlatformIds: () => ['mm'],
      isRoutinesEnabled: () => true,
      fireRoutine: async () => 'failed',
      notifyDisabled: async () => {},
    });
    await expect(failing.fire('mm', makeRoutine(), new Date('2026-08-19T07:01:00Z'))).resolves.toBe('failed');
  });

  test('start() runs an immediate tick so a restart inside a window does not miss it', () => {
    const scheduler = makeScheduler(async () => 'ok', []);
    let ticks = 0;
    scheduler.tick = async () => { ticks++; };
    scheduler.start();
    try {
      expect(ticks).toBe(1);
    } finally {
      scheduler.stop();
    }
  });

  test('tick fires only due routines on enabled platforms', async () => {
    const routine = await addRoutine();
    const fired: string[] = [];
    const scheduler = new RoutineScheduler({
      store,
      listPlatformIds: () => ['mm'],
      isRoutinesEnabled: () => true,
      fireRoutine: async (_pid, r) => {
        fired.push(r.id);
        return 'ok';
      },
      notifyDisabled: async () => {},
    });
    await scheduler.tick(new Date('2026-08-19T06:00:00Z')); // window closed
    expect(fired).toHaveLength(0);
    await scheduler.tick(new Date('2026-08-19T07:01:00Z')); // window open
    expect(fired).toEqual([routine.id]);
    await scheduler.tick(new Date('2026-08-19T07:02:00Z')); // anchored — no double fire
    expect(fired).toEqual([routine.id]);
  });
});
