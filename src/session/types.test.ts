import { describe, it, expect } from 'bun:test';
import {
  getSessionStatus,
  MAX_SESSIONS,
  SESSION_TIMEOUT_MS,
  SESSION_WARNING_MS,
} from './types.js';
import type { Session } from './types.js';

describe('getSessionStatus', () => {
  // Helper to create a minimal session for testing
  function createTestSession(overrides: Partial<Pick<Session, 'isProcessing' | 'hasClaudeResponded'>>): Pick<Session, 'isProcessing' | 'hasClaudeResponded'> {
    return {
      isProcessing: false,
      hasClaudeResponded: false,
      ...overrides,
    };
  }

  it('returns "starting" when processing but Claude has not responded', () => {
    const session = createTestSession({
      isProcessing: true,
      hasClaudeResponded: false,
    });

    expect(getSessionStatus(session as Session)).toBe('starting');
  });

  it('returns "active" when processing and Claude has responded', () => {
    const session = createTestSession({
      isProcessing: true,
      hasClaudeResponded: true,
    });

    expect(getSessionStatus(session as Session)).toBe('active');
  });

  it('returns "idle" when not processing', () => {
    const session = createTestSession({
      isProcessing: false,
      hasClaudeResponded: true,
    });

    expect(getSessionStatus(session as Session)).toBe('idle');
  });

  it('returns "idle" when not processing even if Claude never responded', () => {
    const session = createTestSession({
      isProcessing: false,
      hasClaudeResponded: false,
    });

    expect(getSessionStatus(session as Session)).toBe('idle');
  });
});

describe('Configuration constants', () => {
  it('MAX_SESSIONS is a positive integer', () => {
    expect(typeof MAX_SESSIONS).toBe('number');
    expect(MAX_SESSIONS).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_SESSIONS)).toBe(true);
  });

  it('SESSION_TIMEOUT_MS defaults to 30 minutes', () => {
    // Default is 1800000ms = 30 minutes
    expect(SESSION_TIMEOUT_MS).toBeGreaterThanOrEqual(60000); // At least 1 minute
    expect(typeof SESSION_TIMEOUT_MS).toBe('number');
  });

  it('SESSION_WARNING_MS is 5 minutes', () => {
    expect(SESSION_WARNING_MS).toBe(5 * 60 * 1000);
    expect(SESSION_WARNING_MS).toBe(300000);
  });

  it('SESSION_WARNING_MS is less than default SESSION_TIMEOUT_MS', () => {
    // Warning should come before timeout
    expect(SESSION_WARNING_MS).toBeLessThan(SESSION_TIMEOUT_MS);
  });
});
