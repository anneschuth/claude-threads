/**
 * Natural-language routine parsing: "!routine every weekday at 9am,
 * summarize the open review threads" → a structured, validated schedule.
 *
 * One haiku pass (quickQuery) produces strict JSON; everything it returns is
 * re-validated here (validateSchedule + field checks), so the model can never
 * smuggle an invalid or sub-hourly schedule into the store. Nothing is saved
 * without the human confirming the parsed result (handled by the caller).
 */

import { quickQuery } from '../claude/quick-query.js';
import {
  validateSchedule,
  isValidTimezone,
  SCHEDULE_PRESETS,
  type RoutineSchedule,
} from '../persistence/routines-store.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('routines');

const PARSE_TIMEOUT_MS = 15000;

export interface ParsedRoutineRequest {
  name: string;
  prompt: string;
  schedule: RoutineSchedule;
}

export type ParseRoutineResult =
  | { ok: true; parsed: ParsedRoutineRequest; timezoneDefaulted: boolean }
  | { ok: false; error: string };

/** The bot host's IANA timezone — the default when the request names none. */
export function hostTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function buildParsePrompt(request: string, defaultTimezone: string): string {
  return `Parse this scheduled-routine request from a chat user into JSON.

Request: ${request}

Output ONLY a JSON object, no other text, with exactly these fields:
- "name": short descriptive name for the routine (max 6 words)
- "prompt": the task to perform on each run, as an instruction (everything that is not the schedule)
- "preset": one of "hourly", "daily", "weekdays", "weekly" (the closest match; sub-hourly is not supported — if the user asked for more often than hourly, use "hourly")
- "time": "HH:MM" 24-hour (omit for hourly)
- "weekday": 1-7 where 1=Monday (only for weekly)
- "timezone": IANA timezone ONLY if the user named one (e.g. "9am Pacific" -> "America/Los_Angeles"); otherwise omit and ${defaultTimezone} will be used

If the request is not actually asking for a recurring schedule, output exactly: {"error": "reason"}`;
}

/**
 * Extract the first JSON object from model output (tolerates chatter or code
 * fences around it). Returns undefined when nothing parses.
 */
export function extractJsonObject(output: string): Record<string, unknown> | undefined {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(output.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Validate raw parsed fields into a ParsedRoutineRequest. Pure — exported so
 * tests can exercise the validation matrix without an LLM call.
 */
export function validateParsedRoutine(
  raw: Record<string, unknown>,
  defaultTimezone: string,
): ParseRoutineResult {
  if (typeof raw.error === 'string' && raw.error) {
    return { ok: false, error: raw.error };
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  const preset = raw.preset as RoutineSchedule['preset'];
  if (!name) return { ok: false, error: 'could not derive a routine name' };
  if (!prompt) return { ok: false, error: 'could not tell what the routine should do' };
  if (!SCHEDULE_PRESETS.includes(preset)) {
    return { ok: false, error: `could not map the schedule to ${SCHEDULE_PRESETS.join('/')}` };
  }

  const timezoneDefaulted = !(typeof raw.timezone === 'string' && raw.timezone);
  const timezone = timezoneDefaulted ? defaultTimezone : (raw.timezone as string);
  if (!isValidTimezone(timezone)) {
    return { ok: false, error: `unknown timezone "${String(raw.timezone)}"` };
  }

  const schedule: RoutineSchedule = {
    preset,
    timezone,
    ...(preset !== 'hourly' && typeof raw.time === 'string' ? { time: raw.time } : {}),
    ...(preset === 'weekly' && typeof raw.weekday === 'number' ? { weekday: raw.weekday } : {}),
  };
  const scheduleError = validateSchedule(schedule);
  if (scheduleError) return { ok: false, error: scheduleError };

  return { ok: true, parsed: { name, prompt, schedule }, timezoneDefaulted };
}

/**
 * Parse a natural-language routine request via haiku. Fails with a
 * user-postable error string; never throws.
 */
export async function parseRoutineRequest(
  request: string,
  defaultTimezone = hostTimezone(),
): Promise<ParseRoutineResult> {
  const result = await quickQuery({
    prompt: buildParsePrompt(request, defaultTimezone),
    model: 'haiku',
    timeout: PARSE_TIMEOUT_MS,
  });
  if (!result.success || !result.response) {
    log.debug(`Routine parse quickQuery failed: ${result.error ?? 'no response'}`);
    return { ok: false, error: 'could not reach the parsing model — try again in a moment' };
  }
  const raw = extractJsonObject(result.response);
  if (!raw) {
    return { ok: false, error: 'could not understand the schedule — try e.g. "every weekday at 9:00, <task>"' };
  }
  return validateParsedRoutine(raw, defaultTimezone);
}
