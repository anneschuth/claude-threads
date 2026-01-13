import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import {
  SessionError,
  handleError,
  withErrorHandling,
  logAndNotify,
  type ErrorContext,
} from './index.js';
import type { Session } from '../../session/types.js';
import { createSessionTimers, createSessionLifecycle } from '../../session/types.js';

// Mock session for testing - returns a minimal mock that satisfies the Session interface
// for error handler testing purposes
function createMockSession(): Session {
  return {
    // Identity
    platformId: 'test-platform',
    threadId: 'thread-123',
    sessionId: 'test-platform:thread-123',
    claudeSessionId: 'claude-session-1',
    startedBy: 'testuser',
    startedAt: new Date(),
    lastActivityAt: new Date(),
    sessionNumber: 1,

    // Platform reference
    platform: {
      createPost: mock(() => Promise.resolve({ id: 'post-1' })),
      getFormatter: () => ({
        formatBold: (text: string) => `**${text}**`,
      }),
    } as any,

    // Working directory
    workingDir: '/test',

    // Claude process
    claude: {} as any,

    // Post state
    currentPostId: null,
    currentPostContent: '',

    // Interactive state
    pendingApproval: null,
    pendingQuestionSet: null,
    planApproved: false,

    // Collaboration
    sessionAllowedUsers: new Set(['testuser']),
    forceInteractivePermissions: false,

    // Display state
    sessionStartPostId: null,

    // Flags
    timeoutWarningPosted: false,

    // Message counter
    messageCount: 0,

    // Processing state
    isProcessing: false,
    recentEvents: [],
    messageManager: undefined,

    // Timers and lifecycle
    timers: createSessionTimers(),
    lifecycle: createSessionLifecycle(),
  } as Session;
}

describe('SessionError', () => {
  it('creates error with basic properties', () => {
    const error = new SessionError('test action', 'test message');

    expect(error.name).toBe('SessionError');
    expect(error.action).toBe('test action');
    expect(error.message).toBe('test message');
    expect(error.severity).toBe('recoverable');
    expect(error.sessionId).toBeUndefined();
    expect(error.originalError).toBeUndefined();
  });

  it('includes session ID when provided', () => {
    const session = createMockSession();
    const error = new SessionError('test action', 'test message', { session });

    expect(error.sessionId).toBe('thread-123');
  });

  it('includes custom severity', () => {
    const error = new SessionError('test action', 'test message', {
      severity: 'session-fatal'
    });

    expect(error.severity).toBe('session-fatal');
  });

  it('captures original error', () => {
    const cause = new Error('original error');
    const error = new SessionError('test action', 'test message', { cause });

    expect(error.originalError).toBe(cause);
    expect(error.stack).toContain('Caused by:');
  });
});

describe('handleError', () => {
  let originalConsoleWarn: typeof console.warn;
  let originalConsoleError: typeof console.error;
  let warnMock: ReturnType<typeof mock>;
  let errorMock: ReturnType<typeof mock>;

  beforeEach(() => {
    originalConsoleWarn = console.warn;
    originalConsoleError = console.error;
    warnMock = mock(() => {});
    errorMock = mock(() => {});
    console.warn = warnMock;
    console.error = errorMock;
  });

  afterEach(() => {
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
  });

  it('logs recoverable errors as warnings', async () => {
    const error = new Error('test error');
    const context: ErrorContext = { action: 'Test action' };

    await handleError(error, context, 'recoverable');

    expect(warnMock).toHaveBeenCalled();
  });

  it('logs fatal errors as errors', async () => {
    const error = new Error('test error');
    const context: ErrorContext = { action: 'Test action' };

    try {
      await handleError(error, context, 'session-fatal');
    } catch {
      // Expected to throw
    }

    expect(errorMock).toHaveBeenCalled();
  });

  it('does not throw for recoverable errors', async () => {
    const error = new Error('test error');
    const context: ErrorContext = { action: 'Test action' };

    // Should not throw
    await handleError(error, context, 'recoverable');
  });

  it('throws SessionError for session-fatal errors', async () => {
    const error = new Error('test error');
    const context: ErrorContext = { action: 'Test action' };

    await expect(handleError(error, context, 'session-fatal')).rejects.toBeInstanceOf(SessionError);
  });

  it('throws SessionError for system-fatal errors', async () => {
    const error = new Error('test error');
    const context: ErrorContext = { action: 'Test action' };

    await expect(handleError(error, context, 'system-fatal')).rejects.toBeInstanceOf(SessionError);
  });

  it('notifies user when notifyUser is true', async () => {
    const session = createMockSession();
    const error = new Error('test error');
    const context: ErrorContext = {
      action: 'Test action',
      session,
      notifyUser: true
    };

    await handleError(error, context, 'recoverable');

    expect(session.platform.createPost).toHaveBeenCalledWith(
      expect.stringContaining('Error'),
      'thread-123'
    );
  });

  it('does not notify user when notifyUser is false', async () => {
    const session = createMockSession();
    const error = new Error('test error');
    const context: ErrorContext = {
      action: 'Test action',
      session,
      notifyUser: false
    };

    await handleError(error, context, 'recoverable');

    expect(session.platform.createPost).not.toHaveBeenCalled();
  });

  it('handles string errors', async () => {
    const context: ErrorContext = { action: 'Test action' };

    await handleError('string error', context, 'recoverable');

    expect(warnMock).toHaveBeenCalled();
  });

  it('re-throws existing SessionError without wrapping', async () => {
    const sessionError = new SessionError('original', 'original message');
    const context: ErrorContext = { action: 'Test action' };

    try {
      await handleError(sessionError, context, 'session-fatal');
    } catch (err) {
      expect(err).toBe(sessionError);
    }
  });
});

describe('withErrorHandling', () => {
  it('returns result on success', async () => {
    const operation = async () => 'success';
    const context: ErrorContext = { action: 'Test' };

    const result = await withErrorHandling(operation, context);

    expect(result).toBe('success');
  });

  it('returns undefined on recoverable error', async () => {
    const operation = async () => {
      throw new Error('test error');
    };
    const context: ErrorContext = { action: 'Test' };

    const result = await withErrorHandling(operation, context, 'recoverable');

    expect(result).toBeUndefined();
  });

  it('throws on fatal error', async () => {
    const operation = async () => {
      throw new Error('test error');
    };
    const context: ErrorContext = { action: 'Test' };

    await expect(
      withErrorHandling(operation, context, 'session-fatal')
    ).rejects.toThrow();
  });
});

describe('logAndNotify', () => {
  let originalConsoleWarn: typeof console.warn;

  beforeEach(() => {
    originalConsoleWarn = console.warn;
    console.warn = mock(() => {});
  });

  afterEach(() => {
    console.warn = originalConsoleWarn;
  });

  it('logs error and notifies user', async () => {
    const session = createMockSession();
    const error = new Error('test error');
    const context: ErrorContext = { action: 'Test', session };

    await logAndNotify(error, context);

    expect(session.platform.createPost).toHaveBeenCalled();
  });
});

