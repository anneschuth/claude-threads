/**
 * Rate-limit detection from Claude CLI output.
 *
 * Claude CLI surfaces rate-limit errors in two places:
 * 1. stderr — plaintext messages like "Usage limit reached. Resets at 14:00 UTC."
 * 2. stream-json `result` events with `subtype: "error"` and an error body that
 *    mirrors the Anthropic API shape, including `error.type === "rate_limit_error"`
 *    and sometimes a retry-after header.
 *
 * This module parses either form and returns a normalized result. It is pure
 * and synchronous so it can be unit-tested without touching the CLI process.
 */

export interface RateLimitHit {
  /** True if the input contained a rate-limit signal. */
  detected: boolean;
  /** Epoch ms when the limit resets. Undefined when we can't extract one. */
  resetAtEpochMs?: number;
  /** Original matched phrase, useful for logging / debugging. */
  matched?: string;
}

/**
 * Phrases that reliably indicate a rate-limit condition. Matching is case-
 * insensitive. We keep the list short and high-confidence — anything fuzzy
 * goes in a follow-up so a single noisy log line doesn't put the account into
 * cooldown.
 */
const RATE_LIMIT_PHRASES = [
  /usage limit reached/i,
  /rate[_\s-]?limit[_\s-]?error/i,
  /you have hit the rate limit/i,
  /quota (has been )?exceeded/i,
  /\b429\b.*(rate|limit|quota)/i,
];

/**
 * Duration fallbacks if no explicit reset is given. Keep conservative — the
 * worst case is we re-probe the account once in a while.
 */
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/**
 * Parse arbitrary CLI output (stderr line, JSON error body, etc.) and decide
 * whether it signals a rate limit. Never throws; on ambiguity returns
 * `detected: true` with no `resetAtEpochMs` so the caller can fall back to
 * the default cooldown.
 */
export function detectRateLimit(text: string, now: number = Date.now()): RateLimitHit {
  if (!text) return { detected: false };

  let matched: string | undefined;
  for (const phrase of RATE_LIMIT_PHRASES) {
    const m = text.match(phrase);
    if (m) {
      matched = m[0];
      break;
    }
  }
  if (!matched) return { detected: false };

  const resetAtEpochMs = extractResetAt(text, now);
  return { detected: true, matched, resetAtEpochMs };
}

/**
 * Derive the cooldown deadline from the parsed hit. Callers feed this straight
 * into `AccountPool.markCooling(id, deadline)`.
 */
export function cooldownDeadline(hit: RateLimitHit, now: number = Date.now()): number {
  if (!hit.detected) return now;
  return hit.resetAtEpochMs ?? now + DEFAULT_COOLDOWN_MS;
}

/**
 * Try hard to find when the limit resets. Accepts a handful of common shapes:
 * - `"Resets in 2 hours"` / `"retry after 600 seconds"` — relative offsets
 * - `"resets at 14:00 UTC"` — absolute UTC clock time (today or tomorrow)
 * - `"reset_at": 1761234567` — unix seconds inside a JSON blob
 *
 * Returns undefined when no hint is present — the caller will use the default
 * cooldown.
 */
function extractResetAt(text: string, now: number): number | undefined {
  // "retry after N seconds" / "Resets in N minutes|hours|seconds"
  const relative = text.match(
    /(?:retry[_\s-]?after|resets?\s+in)\s+(\d+)\s*(second|minute|hour|day)s?/i
  );
  if (relative) {
    const value = parseInt(relative[1], 10);
    const unit = relative[2].toLowerCase();
    const unitMs: Record<string, number> = {
      second: 1000,
      minute: 60_000,
      hour: 3_600_000,
      day: 86_400_000,
    };
    return now + value * unitMs[unit];
  }

  // JSON-ish: "reset_at": 1234567890  (seconds).
  // Word-boundary anchors keep this from matching "preset": ... (the `p`
  // has no \b before `r`) or reset_after=... (a relative retry-after hint,
  // which would be silently misread here as an absolute epoch).
  const unix = text.match(/\breset(?:_at)?\b\s*["']?\s*[:=]\s*(\d{10,13})/);
  if (unix) {
    const raw = parseInt(unix[1], 10);
    // 10 digits = seconds, 13 = ms
    return unix[1].length === 13 ? raw : raw * 1000;
  }

  // "resets at 14:00 [UTC]" — pick next occurrence (today or tomorrow)
  const clock = text.match(/resets?\s+at\s+(\d{1,2}):(\d{2})\s*(utc|gmt)?/i);
  if (clock) {
    const hh = parseInt(clock[1], 10);
    const mm = parseInt(clock[2], 10);
    if (hh < 24 && mm < 60) {
      const reference = new Date(now);
      const target = new Date(
        Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate(), hh, mm)
      ).getTime();
      return target > now ? target : target + 86_400_000;
    }
  }

  return undefined;
}

/**
 * Parse a structured `rate_limit_event` from the CLI's stream-json output
 * (present since the 2.1.2xx line). Shape:
 *
 *   { "type": "rate_limit_event",
 *     "rate_limit_info": { "status": "allowed", "resetsAt": 1786072200,
 *                          "rateLimitType": "five_hour", ... } }
 *
 * The SDK type for `status` is `'allowed' | 'allowed_warning' | 'rejected'`
 * (SDKRateLimitInfo). Only `'rejected'` means a request was actually blocked:
 * `'allowed'` is emitted on perfectly healthy turns and `'allowed_warning'`
 * merely means the account is approaching a limit (~70%+ utilization) — the
 * request went through. Treating a warning as a hit would bench a healthy
 * account for up to a week (cooldowns only ever extend), so the predicate is
 * strict equality on 'rejected', not "anything non-allowed". That is also
 * forward-safe against new statuses. `resetsAt` is epoch seconds (from the
 * anthropic-ratelimit-unified-reset header).
 */
export function parseRateLimitEvent(event: unknown, now: number = Date.now()): RateLimitHit {
  const info = (event as { rate_limit_info?: unknown })?.rate_limit_info;
  if (!info || typeof info !== 'object') return { detected: false };

  const { status, resetsAt } = info as { status?: unknown; resetsAt?: unknown };
  if (status !== 'rejected') return { detected: false };

  // Plausibility window keeps a bogus resetsAt (wrong unit, far-future) from
  // cooling an account for years: accept only timestamps at most 8 days out
  // (the longest real window is weekly). A resetsAt slightly in the past
  // (clock skew, window rolling over mid-turn) is clamped to a brief cooldown
  // instead of being dropped — dropping it would fall back to the 1h default,
  // cooling an account whose limit just reset.
  const PAST_SKEW_TOLERANCE_MS = 2 * 60_000;
  let resetAtEpochMs: number | undefined;
  if (typeof resetsAt === 'number') {
    const ms = resetsAt * 1000;
    if (ms > now && ms - now < 8 * 86_400_000) {
      resetAtEpochMs = ms;
    } else if (ms <= now && now - ms < PAST_SKEW_TOLERANCE_MS) {
      resetAtEpochMs = now + 60_000;
    }
  }

  return { detected: true, matched: `rate_limit_event status=${status}`, resetAtEpochMs };
}
