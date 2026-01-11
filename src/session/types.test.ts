import { describe, it, expect } from 'bun:test';
import { getSessionStatus } from './types.js';
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
