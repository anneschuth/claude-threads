/**
 * Tests for RoutinesStore — CRUD, validation, caps, platform scoping,
 * defensive loading. Exercises the actual store per the red-green policy.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  RoutinesStore,
  validateSchedule,
  describeSchedule,
  isValidTimezone,
  type NewRoutine,
} from './routines-store.js';

let dir: string;
let store: RoutinesStore;
let file: string;

const newRoutine = (overrides: Partial<NewRoutine> = {}): NewRoutine => ({
  name: 'Standup summary',
  prompt: 'Summarize open threads',
  schedule: { preset: 'daily', time: '09:00', timezone: 'Europe/Amsterdam' },
  createdBy: 'anne',
  ...overrides,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ct-routines-store-'));
  file = join(dir, 'routines.yaml');
  store = new RoutinesStore(file);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('validateSchedule', () => {
  test('accepts all presets with valid fields', () => {
    expect(validateSchedule({ preset: 'hourly', timezone: 'UTC' })).toBeNull();
    expect(validateSchedule({ preset: 'daily', time: '09:00', timezone: 'Europe/Amsterdam' })).toBeNull();
    expect(validateSchedule({ preset: 'weekdays', time: '23:59', timezone: 'America/New_York' })).toBeNull();
    expect(validateSchedule({ preset: 'weekly', time: '08:30', weekday: 7, timezone: 'Asia/Tokyo' })).toBeNull();
  });

  test('rejects unknown presets (no sub-hourly cadence is representable)', () => {
    expect(validateSchedule({ preset: 'every-5-minutes' as never, timezone: 'UTC' })).toContain('preset');
  });

  test('rejects bad times, weekdays, and timezones', () => {
    expect(validateSchedule({ preset: 'daily', time: '25:00', timezone: 'UTC' })).toContain('time');
    expect(validateSchedule({ preset: 'daily', timezone: 'UTC' })).toContain('time');
    expect(validateSchedule({ preset: 'weekly', time: '09:00', weekday: 8, timezone: 'UTC' })).toContain('weekday');
    expect(validateSchedule({ preset: 'weekly', time: '09:00', timezone: 'UTC' })).toContain('weekday');
    expect(validateSchedule({ preset: 'daily', time: '09:00', timezone: 'Mars/Olympus' })).toContain('timezone');
  });
});

describe('isValidTimezone', () => {
  test('accepts IANA zones, rejects junk', () => {
    expect(isValidTimezone('Europe/Amsterdam')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Not/AZone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone(42)).toBe(false);
  });
});

describe('describeSchedule', () => {
  test('renders each preset', () => {
    expect(describeSchedule({ preset: 'hourly', timezone: 'UTC' })).toBe('hourly (UTC)');
    expect(describeSchedule({ preset: 'weekdays', time: '09:00', timezone: 'UTC' })).toBe('weekdays at 09:00 (UTC)');
    expect(describeSchedule({ preset: 'weekly', time: '08:00', weekday: 1, timezone: 'UTC' })).toContain('Mon');
  });
});

describe('RoutinesStore CRUD', () => {
  test('add/list/get round-trip with bookkeeping defaults', async () => {
    const result = await store.add('mm', newRoutine());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routine.id).toMatch(/^[0-9a-f-]{8}$/);
    expect(result.routine.enabled).toBe(true);
    expect(result.routine.consecutiveFailures).toBe(0);

    const listed = store.list('mm');
    expect(listed).toHaveLength(1);
    expect(store.get('mm', result.routine.id)?.name).toBe('Standup summary');
  });

  test('writes 0600', async () => {
    await store.add('mm', newRoutine());
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('routines never cross platform ids', async () => {
    await store.add('mm', newRoutine());
    expect(store.list('slack')).toHaveLength(0);
  });

  test('rejects invalid schedules at the store boundary', async () => {
    const result = await store.add('mm', newRoutine({ schedule: { preset: 'daily', time: 'bogus', timezone: 'UTC' } }));
    expect(result.ok).toBe(false);
    expect(store.list('mm')).toHaveLength(0);
  });

  test('enforces the per-platform cap', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await store.add('mm', newRoutine({ name: `Routine ${i}` }), 3);
      expect(r.ok).toBe(true);
    }
    const overflow = await store.add('mm', newRoutine({ name: 'One too many' }), 3);
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.error).toContain('limit');
  });

  test('update patches bookkeeping fields', async () => {
    const { routine } = (await store.add('mm', newRoutine())) as { ok: true; routine: { id: string } };
    const updated = await store.update('mm', routine.id, { enabled: false, lastRunStatus: 'failed', consecutiveFailures: 2 });
    expect(updated?.enabled).toBe(false);
    expect(store.get('mm', routine.id)?.consecutiveFailures).toBe(2);
    expect(await store.update('mm', 'nope', { enabled: true })).toBeUndefined();
  });

  test('remove deletes and reports; unknown ids are undefined', async () => {
    const { routine } = (await store.add('mm', newRoutine())) as { ok: true; routine: { id: string } };
    const removed = await store.remove('mm', routine.id);
    expect(removed?.id).toBe(routine.id);
    expect(store.list('mm')).toHaveLength(0);
    expect(await store.remove('mm', routine.id)).toBeUndefined();
  });

  test('concurrent adds serialize (no lost updates)', async () => {
    await Promise.all([
      store.add('mm', newRoutine({ name: 'One' })),
      store.add('mm', newRoutine({ name: 'Two' })),
      store.add('mm', newRoutine({ name: 'Three' })),
    ]);
    expect(store.list('mm')).toHaveLength(3);
  });

  test('corrupt file starts empty instead of crashing; old data gets defensive defaults', async () => {
    writeFileSync(file, 'not: [valid: yaml', 'utf-8');
    expect(store.list('mm')).toEqual([]);

    // Simulate a pre-upgrade record missing newer bookkeeping fields.
    writeFileSync(file, [
      'version: 1',
      'routines:',
      '  mm:',
      '    - id: old1',
      '      name: Legacy',
      '      prompt: do it',
      '      schedule: { preset: daily, time: "09:00", timezone: UTC }',
      '      createdBy: anne',
      '      createdAt: 2026-01-01T00:00:00Z',
    ].join('\n'), 'utf-8');
    const legacy = store.list('mm');
    expect(legacy).toHaveLength(1);
    expect(legacy[0].enabled).toBe(true);
    expect(legacy[0].consecutiveFailures).toBe(0);
  });

  test('env path override is honored', async () => {
    const custom = join(dir, 'custom.yaml');
    const prev = process.env.CLAUDE_THREADS_ROUTINES_PATH;
    process.env.CLAUDE_THREADS_ROUTINES_PATH = custom;
    try {
      const s = new RoutinesStore();
      await s.add('mm', newRoutine());
      expect(readFileSync(custom, 'utf-8')).toContain('Standup summary');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_THREADS_ROUTINES_PATH;
      else process.env.CLAUDE_THREADS_ROUTINES_PATH = prev;
    }
  });
});
