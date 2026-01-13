import { describe, it, expect } from 'bun:test';
import { getSessionStatus, createSessionLifecycle } from './types.js';
import type { Session, SessionLifecycle } from './types.js';

describe('getSessionStatus', () => {
  // Helper to create a minimal session for testing
  function createTestSession(overrides: { isProcessing: boolean; hasClaudeResponded: boolean }): Pick<Session, 'isProcessing' | 'lifecycle'> {
    const lifecycle: SessionLifecycle = {
      ...createSessionLifecycle(),
      hasClaudeResponded: overrides.hasClaudeResponded,
    };
    return {
      isProcessing: overrides.isProcessing,
      lifecycle,
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
