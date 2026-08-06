/**
 * Tests for rate-limit detection.
 */
import { describe, it, expect } from 'bun:test';
import { detectRateLimit, cooldownDeadline, parseRateLimitEvent } from './rate-limit-detector.js';

const NOW = 1_700_000_000_000; // fixed reference timestamp

describe('detectRateLimit', () => {
  it('returns detected: false for empty input', () => {
    expect(detectRateLimit('', NOW).detected).toBe(false);
    expect(detectRateLimit(' ', NOW).detected).toBe(false);
  });

  it('returns detected: false for unrelated errors', () => {
    expect(detectRateLimit('file not found', NOW).detected).toBe(false);
    expect(detectRateLimit('Claude Code v2.1.2', NOW).detected).toBe(false);
  });

  it('matches "Usage limit reached"', () => {
    const hit = detectRateLimit('ERROR: Usage limit reached. Try again later.', NOW);
    expect(hit.detected).toBe(true);
    expect(hit.matched?.toLowerCase()).toContain('usage limit reached');
  });

  it('matches rate_limit_error from API error body', () => {
    const hit = detectRateLimit('{"error":{"type":"rate_limit_error"}}', NOW);
    expect(hit.detected).toBe(true);
  });

  it('matches 429 in context', () => {
    const hit = detectRateLimit('HTTP 429 rate limit exceeded', NOW);
    expect(hit.detected).toBe(true);
  });

  it('does not match bare 429', () => {
    // Bare status code without context shouldn't cool an account down
    const hit = detectRateLimit('got 429 status', NOW);
    expect(hit.detected).toBe(false);
  });

  it('matches "quota exceeded"', () => {
    const hit = detectRateLimit('your quota has been exceeded', NOW);
    expect(hit.detected).toBe(true);
  });
});

describe('reset-time extraction', () => {
  it('parses "retry after N seconds"', () => {
    const hit = detectRateLimit('rate_limit_error: retry after 120 seconds', NOW);
    expect(hit.resetAtEpochMs).toBe(NOW + 120_000);
  });

  it('parses "Resets in N hours"', () => {
    const hit = detectRateLimit('Usage limit reached. Resets in 2 hours.', NOW);
    expect(hit.resetAtEpochMs).toBe(NOW + 2 * 3_600_000);
  });

  it('parses "Resets in N minutes"', () => {
    const hit = detectRateLimit('usage limit reached. Resets in 45 minutes', NOW);
    expect(hit.resetAtEpochMs).toBe(NOW + 45 * 60_000);
  });

  it('parses unix seconds in JSON', () => {
    const resetSec = 1_700_003_600;
    const hit = detectRateLimit(
      `{"error":{"type":"rate_limit_error","reset_at":${resetSec}}}`,
      NOW
    );
    expect(hit.resetAtEpochMs).toBe(resetSec * 1000);
  });

  it('parses unix milliseconds in JSON', () => {
    const resetMs = 1_700_003_600_000;
    const hit = detectRateLimit(
      `{"error":{"type":"rate_limit_error","reset":${resetMs}}}`,
      NOW
    );
    expect(hit.resetAtEpochMs).toBe(resetMs);
  });

  it('parses clock time "resets at HH:MM" and rolls to tomorrow when in past', () => {
    // NOW is 2023-11-14 ~22:13:20 UTC; "05:00 UTC" is earlier today → tomorrow
    const hit = detectRateLimit('Usage limit reached. Resets at 05:00 UTC.', NOW);
    expect(hit.resetAtEpochMs).toBeGreaterThan(NOW);
    // Should be within the next 24 hours
    expect(hit.resetAtEpochMs! - NOW).toBeLessThan(24 * 3_600_000);
  });

  it('returns undefined reset when no hint present', () => {
    const hit = detectRateLimit('rate_limit_error occurred', NOW);
    expect(hit.detected).toBe(true);
    expect(hit.resetAtEpochMs).toBeUndefined();
  });

  // Regression: the reset-time regex must not match other fields whose names
  // contain "reset" as a substring. Before word-boundary anchors, both of the
  // cases below extracted a bogus epoch and silently misrouted the cooldown.
  it('does not match "preset": N (word-boundary regression)', () => {
    const hit = detectRateLimit(
      `rate_limit_error, "preset": 1700003600`,
      NOW
    );
    // Phrase still triggers detection, but no reset extracted from "preset".
    expect(hit.detected).toBe(true);
    expect(hit.resetAtEpochMs).toBeUndefined();
  });

  it('does not match reset_after=N (relative hint, not absolute epoch)', () => {
    const hit = detectRateLimit(
      `rate_limit_error reset_after=1700003600`,
      NOW
    );
    expect(hit.detected).toBe(true);
    // reset_after would be a *relative* retry-after; interpreting it as an
    // absolute epoch would put cooldown decades into the future.
    expect(hit.resetAtEpochMs).toBeUndefined();
  });
});

describe('false-positive guards (regression for M2)', () => {
  // The rate-limit detector is now only invoked from error-flavored result
  // events and from stderr (see cli.ts:parseOutput). These tests document that
  // the phrase matchers themselves are intentionally permissive — the
  // tightening lives in the caller. A test in cli-level code would pair this
  // with the caller's gating logic.
  it('still matches when asked, so the caller gating matters', () => {
    // This is assistant-generated text answering a question about rate limits.
    // The detector intentionally still matches — the caller must filter out
    // successful result events so this text never reaches detectRateLimit.
    const assistantText = 'A rate_limit_error is returned when Anthropic\'s API is...';
    expect(detectRateLimit(assistantText, NOW).detected).toBe(true);
  });

  it('does not match benign mentions of "limit" or "quota"', () => {
    expect(detectRateLimit('context limit approaching', NOW).detected).toBe(false);
    expect(detectRateLimit('your disk quota is 100GB', NOW).detected).toBe(false);
    expect(detectRateLimit('429 is the HTTP status for Too Many Requests', NOW).detected).toBe(false);
  });
});

describe('cooldownDeadline', () => {
  it('uses extracted reset when available', () => {
    const hit = { detected: true, resetAtEpochMs: NOW + 5_000 };
    expect(cooldownDeadline(hit, NOW)).toBe(NOW + 5_000);
  });

  it('falls back to default 1-hour cooldown when no reset hint', () => {
    const hit = { detected: true };
    expect(cooldownDeadline(hit, NOW)).toBe(NOW + 3_600_000);
  });

  it('returns now when not detected', () => {
    expect(cooldownDeadline({ detected: false }, NOW)).toBe(NOW);
  });
});

describe('parseRateLimitEvent', () => {
  it('ignores healthy allowed events', () => {
    const hit = parseRateLimitEvent({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', resetsAt: 1786072200, rateLimitType: 'five_hour' },
    });
    expect(hit.detected).toBe(false);
  });

  it('detects non-allowed statuses and converts resetsAt seconds to ms', () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const hit = parseRateLimitEvent({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' },
    });
    expect(hit.detected).toBe(true);
    expect(hit.resetAtEpochMs).toBe(resetsAt * 1000);
    expect(hit.matched).toContain('rejected');
  });

  it('drops implausible resetsAt values but still detects', () => {
    const hit = parseRateLimitEvent({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 123 },
    });
    expect(hit.detected).toBe(true);
    expect(hit.resetAtEpochMs).toBeUndefined();
  });

  it('returns not-detected for malformed events', () => {
    expect(parseRateLimitEvent({ type: 'rate_limit_event' }).detected).toBe(false);
    expect(parseRateLimitEvent(null).detected).toBe(false);
    expect(parseRateLimitEvent({ rate_limit_info: 'weird' }).detected).toBe(false);
    expect(parseRateLimitEvent({ rate_limit_info: {} }).detected).toBe(false);
  });
});

describe('parseRateLimitEvent - status semantics (SDK: allowed | allowed_warning | rejected)', () => {
  it('does NOT treat allowed_warning as a hit (request went through, account merely near a limit)', () => {
    const hit = parseRateLimitEvent({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed_warning',
        resetsAt: Math.floor(NOW / 1000) + 6 * 86_400, // weekly reset, well inside plausibility window
        rateLimitType: 'seven_day',
        utilization: 0.8,
      },
    }, NOW);
    expect(hit.detected).toBe(false);
  });

  it('ignores unknown future statuses instead of treating them as hits', () => {
    const hit = parseRateLimitEvent({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'some_new_status', resetsAt: Math.floor(NOW / 1000) + 60 },
    }, NOW);
    expect(hit.detected).toBe(false);
  });

  it('clamps a slightly-past resetsAt to a brief cooldown instead of the 1h default', () => {
    const hit = parseRateLimitEvent({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: Math.floor(NOW / 1000) - 30 },
    }, NOW);
    expect(hit.detected).toBe(true);
    expect(hit.resetAtEpochMs).toBe(NOW + 60_000);
  });

  it('drops a resetsAt far in the past (falls back to default cooldown)', () => {
    const hit = parseRateLimitEvent({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: Math.floor(NOW / 1000) - 3600 },
    }, NOW);
    expect(hit.detected).toBe(true);
    expect(hit.resetAtEpochMs).toBeUndefined();
  });
});
