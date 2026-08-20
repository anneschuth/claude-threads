/**
 * RoutinesStore — persistence for scheduled routines (Claude Tag-style
 * recurring work: "every weekday at 9am, summarize open threads").
 *
 * Routines are scoped per platform instance (platformId ≈ one channel — the
 * same hard privacy boundary the memory store uses): a routine created on one
 * platform never fires on, or is visible from, another.
 *
 * Storage: YAML at ~/.config/claude-threads/routines.yaml, 0600 atomic
 * writes, versioned. Override path with CLAUDE_THREADS_ROUTINES_PATH.
 * Mutations serialize through an in-process mutex (single bot process owns
 * the file), mirroring MemoryStore.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import yaml from 'js-yaml';
import { createLogger } from '../utils/logger.js';

const log = createLogger('routines');

const DEFAULT_CONFIG_DIR = join(homedir(), '.config', 'claude-threads');
const DEFAULT_FILE = join(DEFAULT_CONFIG_DIR, 'routines.yaml');

const STORE_VERSION = 1;

/** Routines are disabled after this many consecutive failed runs. */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** Hard cap default; overridable via limits.maxRoutines. */
export const DEFAULT_MAX_ROUTINES = 10;

export const SCHEDULE_PRESETS = ['hourly', 'daily', 'weekdays', 'weekly'] as const;
export type SchedulePreset = (typeof SCHEDULE_PRESETS)[number];

/**
 * A routine's schedule. Sub-hourly cadences are intentionally unrepresentable
 * (the presets are the floor), mirroring Claude Tag's hourly minimum.
 */
export interface RoutineSchedule {
  preset: SchedulePreset;
  /** "HH:MM" 24h local time in `timezone`. Required for all presets except hourly. */
  time?: string;
  /** ISO weekday 1 (Mon) – 7 (Sun). Required for weekly. */
  weekday?: number;
  /** IANA timezone the schedule is evaluated in, e.g. "Europe/Amsterdam". */
  timezone: string;
}

export type RoutineRunStatus = 'ok' | 'failed' | 'skipped';

export interface Routine {
  id: string;
  /** Short human name, shown in lists and as the routine thread's root post. */
  name: string;
  /** The task each run asks Claude to do. */
  prompt: string;
  schedule: RoutineSchedule;
  /**
   * Username the routine fires as. startSession re-gates this against the
   * platform allowlist at every fire — a creator who loses authorization
   * disables the routine (mirrors Claude Tag's "stops when creator removed").
   */
  createdBy: string;
  createdAt: string;
  enabled: boolean;
  lastRunAt?: string;
  lastRunStatus?: RoutineRunStatus;
  consecutiveFailures: number;
}

/** Input for creating a routine; id/bookkeeping fields are filled in by the store. */
export type NewRoutine = Omit<Routine, 'id' | 'createdAt' | 'enabled' | 'consecutiveFailures'>;

interface FileShape {
  version: number;
  /** platformId -> routines */
  routines: Record<string, Routine[]>;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** True when the value is a well-formed IANA timezone this runtime knows. */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a schedule shape (defensively — schedules come from an LLM parse).
 * Returns an error string, or null when valid.
 */
export function validateSchedule(schedule: RoutineSchedule): string | null {
  if (!SCHEDULE_PRESETS.includes(schedule.preset)) {
    return `unknown preset "${String(schedule.preset)}" (expected ${SCHEDULE_PRESETS.join('/')})`;
  }
  if (!isValidTimezone(schedule.timezone)) {
    return `invalid timezone "${String(schedule.timezone)}"`;
  }
  if (schedule.preset === 'hourly') {
    return null; // time/weekday ignored
  }
  if (!schedule.time || !TIME_RE.test(schedule.time)) {
    return `invalid time "${String(schedule.time)}" (expected HH:MM, 24h)`;
  }
  if (schedule.preset === 'weekly') {
    const weekday = schedule.weekday;
    if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      return `invalid weekday "${String(weekday)}" (expected 1=Mon … 7=Sun)`;
    }
  }
  return null;
}

/** Human-readable schedule summary for lists and confirmation posts. */
export function describeSchedule(schedule: RoutineSchedule): string {
  const WEEKDAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  switch (schedule.preset) {
    case 'hourly':
      return `hourly (${schedule.timezone})`;
    case 'daily':
      return `daily at ${schedule.time} (${schedule.timezone})`;
    case 'weekdays':
      return `weekdays at ${schedule.time} (${schedule.timezone})`;
    case 'weekly':
      return `weekly on ${WEEKDAYS[schedule.weekday ?? 0] || '?'} at ${schedule.time} (${schedule.timezone})`;
  }
}

export class RoutinesStore {
  private readonly file: string;
  private readonly configDir: string;
  /** In-process write mutex (single bot process owns the file). */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(filePath?: string) {
    const effective = filePath ?? process.env.CLAUDE_THREADS_ROUTINES_PATH;
    if (effective) {
      this.file = effective;
      this.configDir = join(effective, '..');
    } else {
      this.file = DEFAULT_FILE;
      this.configDir = DEFAULT_CONFIG_DIR;
    }
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    }
  }

  /** All routines for a platform, in creation order. */
  list(platformId: string): Routine[] {
    return this.loadRaw().routines[platformId] ?? [];
  }

  get(platformId: string, id: string): Routine | undefined {
    return this.list(platformId).find((r) => r.id === id);
  }

  /**
   * Add a routine. Rejects (returns an error string) on invalid schedules or
   * when the platform is at `maxRoutines` — validation lives here so no
   * caller can bypass it.
   */
  add(platformId: string, routine: NewRoutine, maxRoutines = DEFAULT_MAX_ROUTINES): Promise<{ ok: true; routine: Routine } | { ok: false; error: string }> {
    return this.runExclusive(() => {
      const scheduleError = validateSchedule(routine.schedule);
      if (scheduleError) return { ok: false as const, error: scheduleError };
      const name = routine.name.trim().slice(0, 80);
      const prompt = routine.prompt.trim().slice(0, 2000);
      if (!name || !prompt) return { ok: false as const, error: 'name and prompt are required' };

      const data = this.loadRaw();
      const existing = data.routines[platformId] ?? [];
      if (existing.length >= maxRoutines) {
        return { ok: false as const, error: `routine limit reached (${maxRoutines}); delete one first` };
      }
      const full: Routine = {
        ...routine,
        name,
        prompt,
        id: randomUUID().slice(0, 8),
        createdAt: new Date().toISOString(),
        enabled: true,
        consecutiveFailures: 0,
      };
      data.routines[platformId] = [...existing, full];
      this.writeAtomic(data);
      log.info(`Routine "${full.name}" created on ${platformId} by @${full.createdBy}`);
      return { ok: true as const, routine: full };
    });
  }

  /** Merge a partial update into one routine. Returns the updated routine or undefined. */
  update(platformId: string, id: string, patch: Partial<Pick<Routine, 'enabled' | 'lastRunAt' | 'lastRunStatus' | 'consecutiveFailures'>>): Promise<Routine | undefined> {
    return this.runExclusive(() => {
      const data = this.loadRaw();
      const routines = data.routines[platformId] ?? [];
      const idx = routines.findIndex((r) => r.id === id);
      if (idx < 0) return undefined;
      routines[idx] = { ...routines[idx], ...patch };
      this.writeAtomic(data);
      return routines[idx];
    });
  }

  /** Remove a routine. Returns the removed routine or undefined. */
  remove(platformId: string, id: string): Promise<Routine | undefined> {
    return this.runExclusive(() => {
      const data = this.loadRaw();
      const routines = data.routines[platformId] ?? [];
      const idx = routines.findIndex((r) => r.id === id);
      if (idx < 0) return undefined;
      const [removed] = routines.splice(idx, 1);
      if (routines.length === 0) delete data.routines[platformId];
      this.writeAtomic(data);
      log.info(`Routine "${removed.name}" removed from ${platformId}`);
      return removed;
    });
  }

  // ---------------------------------------------------------------------------

  private runExclusive<T>(fn: () => T): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }

  private loadRaw(): FileShape {
    if (!existsSync(this.file)) {
      return { version: STORE_VERSION, routines: {} };
    }
    try {
      const parsed = yaml.load(readFileSync(this.file, 'utf-8')) as Partial<FileShape> | undefined;
      if (!parsed || typeof parsed !== 'object') {
        return { version: STORE_VERSION, routines: {} };
      }
      const routines = (parsed.routines && typeof parsed.routines === 'object')
        ? parsed.routines as Record<string, Routine[]>
        : {};
      // Defensive defaults for forward/backward compatibility.
      for (const list of Object.values(routines)) {
        for (const r of list) {
          r.enabled = r.enabled ?? true;
          r.consecutiveFailures = r.consecutiveFailures ?? 0;
        }
      }
      return { version: parsed.version ?? STORE_VERSION, routines };
    } catch (err) {
      log.warn(`Failed to read ${this.file}: ${(err as Error).message} — starting empty`);
      return { version: STORE_VERSION, routines: {} };
    }
  }

  private writeAtomic(data: FileShape): void {
    const tempFile = `${this.file}.tmp`;
    const text = yaml.dump(data, { sortKeys: true, lineWidth: -1 });
    writeFileSync(tempFile, text, { encoding: 'utf-8', mode: 0o600 });
    renameSync(tempFile, this.file);
    chmodSync(this.file, 0o600);
  }
}
