/**
 * Tests for the resume-refusal rate limiter (#491).
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  shouldPostResumeRefusal,
  resetResumeRefusalLimiter,
  REFUSAL_WINDOW_MS,
} from './refusal-limiter.js';

describe('shouldPostResumeRefusal', () => {
  beforeEach(() => resetResumeRefusalLimiter());

  it('allows the first refusal and blocks repeats inside the window', () => {
    const t0 = 1_000_000;
    expect(shouldPostResumeRefusal('p', 'thread', 'bot-b', t0)).toBe(true);
    expect(shouldPostResumeRefusal('p', 'thread', 'bot-b', t0 + 1_000)).toBe(false);
    expect(shouldPostResumeRefusal('p', 'thread', 'bot-b', t0 + REFUSAL_WINDOW_MS - 1)).toBe(false);
  });

  it('allows again once the window has elapsed', () => {
    const t0 = 1_000_000;
    expect(shouldPostResumeRefusal('p', 'thread', 'bot-b', t0)).toBe(true);
    expect(shouldPostResumeRefusal('p', 'thread', 'bot-b', t0 + REFUSAL_WINDOW_MS)).toBe(true);
  });

  it('tracks (platform, thread, user) keys independently', () => {
    const t0 = 1_000_000;
    expect(shouldPostResumeRefusal('p', 'thread', 'bot-b', t0)).toBe(true);
    expect(shouldPostResumeRefusal('p', 'thread', 'human', t0)).toBe(true);
    expect(shouldPostResumeRefusal('p', 'other-thread', 'bot-b', t0)).toBe(true);
    expect(shouldPostResumeRefusal('p2', 'thread', 'bot-b', t0)).toBe(true);
    // ...and each of those is now throttled.
    expect(shouldPostResumeRefusal('p', 'thread', 'human', t0 + 1)).toBe(false);
  });

  it('sweeps expired entries instead of growing without bound', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 600; i++) {
      shouldPostResumeRefusal('p', `thread-${i}`, 'bot-b', t0);
    }
    // Far past the window: every old entry is sweepable; new keys keep working
    // and old keys are refusable again.
    const t1 = t0 + REFUSAL_WINDOW_MS * 2;
    expect(shouldPostResumeRefusal('p', 'thread-0', 'bot-b', t1)).toBe(true);
    expect(shouldPostResumeRefusal('p', 'thread-0', 'bot-b', t1 + 1)).toBe(false);
  });
});
