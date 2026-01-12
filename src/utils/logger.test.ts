import { describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { createLogger, mcpLogger, wsLogger } from './logger.js';

describe('createLogger', () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let consoleWarnSpy: ReturnType<typeof spyOn>;
  const originalEnv = process.env.DEBUG;

  beforeEach(() => {
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.DEBUG;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    if (originalEnv !== undefined) {
      process.env.DEBUG = originalEnv;
    } else {
      delete process.env.DEBUG;
    }
  });

  describe('debug', () => {
    it('does not log when DEBUG is not set', () => {
      const logger = createLogger('test');
      logger.debug('test message');
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('logs to stdout when DEBUG=1 and useStderr=false', () => {
      process.env.DEBUG = '1';
      const logger = createLogger('test');
      logger.debug('test message');
      expect(consoleLogSpy).toHaveBeenCalledWith('  [test] test message');
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('logs to stderr when DEBUG=1 and useStderr=true', () => {
      process.env.DEBUG = '1';
      const logger = createLogger('test', true);
      logger.debug('test message');
      expect(consoleErrorSpy).toHaveBeenCalledWith('  [test] test message');
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('does not log when DEBUG is set to something other than 1', () => {
      process.env.DEBUG = 'true';
      const logger = createLogger('test');
      logger.debug('test message');
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe('info', () => {
    it('always logs to stdout when useStderr=false', () => {
      const logger = createLogger('test');
      logger.info('info message');
      expect(consoleLogSpy).toHaveBeenCalledWith('  [test] info message');
    });

    it('logs to stderr when useStderr=true', () => {
      const logger = createLogger('test', true);
      logger.info('info message');
      expect(consoleErrorSpy).toHaveBeenCalledWith('  [test] info message');
    });

    it('logs even when DEBUG is not set', () => {
      const logger = createLogger('test');
      logger.info('info message');
      expect(consoleLogSpy).toHaveBeenCalled();
    });
  });

  describe('warn', () => {
    it('always logs to console.warn', () => {
      const logger = createLogger('test');
      logger.warn('warn message');
      expect(consoleWarnSpy).toHaveBeenCalledWith('  [test] ⚠️ warn message');
    });

    it('logs even when DEBUG is not set', () => {
      const logger = createLogger('test');
      logger.warn('warn message');
      expect(consoleWarnSpy).toHaveBeenCalled();
    });
  });

  describe('error', () => {
    it('always logs to stderr with error emoji', () => {
      const logger = createLogger('test');
      logger.error('error message');
      expect(consoleErrorSpy).toHaveBeenCalledWith('  [test] ❌ error message');
    });

    it('logs to stderr even when useStderr=false', () => {
      const logger = createLogger('test', false);
      logger.error('error message');
      expect(consoleErrorSpy).toHaveBeenCalledWith('  [test] ❌ error message');
    });

    it('logs even when DEBUG is not set', () => {
      const logger = createLogger('test');
      logger.error('error message');
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('logs error object when DEBUG=1', () => {
      process.env.DEBUG = '1';
      const logger = createLogger('test');
      const testError = new Error('test error');
      logger.error('error message', testError);
      expect(consoleErrorSpy).toHaveBeenCalledWith('  [test] ❌ error message');
      expect(consoleErrorSpy).toHaveBeenCalledWith(testError);
    });

    it('does not log error object when DEBUG is not set', () => {
      const logger = createLogger('test');
      const testError = new Error('test error');
      logger.error('error message', testError);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith('  [test] ❌ error message');
    });
  });

  describe('prefix formatting', () => {
    it('includes component name in brackets with indent in debug messages', () => {
      process.env.DEBUG = '1';
      const logger = createLogger('MyComponent');
      logger.debug('my message');
      expect(consoleLogSpy).toHaveBeenCalledWith('  [MyComponent] my message');
    });

    it('includes component name in brackets with indent in info messages', () => {
      const logger = createLogger('MyComponent');
      logger.info('my message');
      expect(consoleLogSpy).toHaveBeenCalledWith('  [MyComponent] my message');
    });

    it('includes component name in brackets with indent in error messages', () => {
      const logger = createLogger('MyComponent');
      logger.error('my message');
      expect(consoleErrorSpy).toHaveBeenCalledWith('  [MyComponent] ❌ my message');
    });
  });
});

describe('pre-configured loggers', () => {
  // Note: mcpLogger and wsLogger are module-level singletons created at import time.
  // Since they capture console.log/error at creation, we test their behavior by
  // verifying they have the expected interface and configuration.

  describe('mcpLogger', () => {
    it('has debug, info, warn, and error methods', () => {
      expect(typeof mcpLogger.debug).toBe('function');
      expect(typeof mcpLogger.info).toBe('function');
      expect(typeof mcpLogger.warn).toBe('function');
      expect(typeof mcpLogger.error).toBe('function');
    });
  });

  describe('wsLogger', () => {
    it('has debug, info, warn, and error methods', () => {
      expect(typeof wsLogger.debug).toBe('function');
      expect(typeof wsLogger.info).toBe('function');
      expect(typeof wsLogger.warn).toBe('function');
      expect(typeof wsLogger.error).toBe('function');
    });
  });
});

import { setLogHandler } from './logger.js';
import { mock } from 'bun:test';

describe('setLogHandler', () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  const originalEnv = process.env.DEBUG;

  beforeEach(() => {
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    setLogHandler(null);
    delete process.env.DEBUG;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    setLogHandler(null);
    if (originalEnv !== undefined) {
      process.env.DEBUG = originalEnv;
    }
  });

  it('routes logs through custom handler when set', () => {
    const handler = mock(() => {});
    setLogHandler(handler);

    const logger = createLogger('mycomponent');
    logger.info('Test message');

    expect(handler).toHaveBeenCalledWith('info', 'mycomponent', 'Test message', undefined);
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('routes warn logs through custom handler', () => {
    const handler = mock(() => {});
    setLogHandler(handler);

    const logger = createLogger('comp');
    logger.warn('Warning message');

    expect(handler).toHaveBeenCalledWith('warn', 'comp', 'Warning message', undefined);
  });

  it('routes error logs through custom handler', () => {
    const handler = mock(() => {});
    setLogHandler(handler);

    const logger = createLogger('comp');
    logger.error('Error message');

    expect(handler).toHaveBeenCalledWith('error', 'comp', 'Error message', undefined);
  });

  it('routes debug logs through custom handler when DEBUG=1', () => {
    process.env.DEBUG = '1';
    const handler = mock(() => {});
    setLogHandler(handler);

    const logger = createLogger('comp');
    logger.debug('Debug message');

    expect(handler).toHaveBeenCalledWith('debug', 'comp', 'Debug message', undefined);
  });

  it('routes debugJson logs through custom handler when DEBUG=1', () => {
    process.env.DEBUG = '1';
    const handler = mock(() => {});
    setLogHandler(handler);

    const logger = createLogger('comp');
    logger.debugJson('Data', { key: 'value' });

    expect(handler).toHaveBeenCalledWith('debug', 'comp', 'Data: {"key":"value"}', undefined);
  });

  it('reverts to console when handler is set to null', () => {
    const handler = mock(() => {});
    setLogHandler(handler);
    setLogHandler(null);

    const logger = createLogger('test');
    logger.info('Message');

    expect(handler).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalled();
  });
});

describe('forSession', () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  const originalEnv = process.env.DEBUG;

  beforeEach(() => {
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    setLogHandler(null);
    delete process.env.DEBUG;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    setLogHandler(null);
    if (originalEnv !== undefined) {
      process.env.DEBUG = originalEnv;
    }
  });

  it('creates a logger that passes sessionId to handler', () => {
    const handler = mock(() => {});
    setLogHandler(handler);

    const logger = createLogger('test');
    const sessionLogger = logger.forSession('session-123');
    sessionLogger.info('Session message');

    expect(handler).toHaveBeenCalledWith('info', 'test', 'Session message', 'session-123');
  });

  it('returns a logger with all expected methods', () => {
    const logger = createLogger('test');
    const sessionLogger = logger.forSession('session-456');

    expect(typeof sessionLogger.debug).toBe('function');
    expect(typeof sessionLogger.debugJson).toBe('function');
    expect(typeof sessionLogger.info).toBe('function');
    expect(typeof sessionLogger.warn).toBe('function');
    expect(typeof sessionLogger.error).toBe('function');
    expect(typeof sessionLogger.forSession).toBe('function');
  });

  it('can chain forSession calls', () => {
    const handler = mock(() => {});
    setLogHandler(handler);

    const logger = createLogger('test');
    const sessionLogger1 = logger.forSession('session-1');
    const sessionLogger2 = sessionLogger1.forSession('session-2');
    sessionLogger2.info('Nested session');

    // The second forSession should override the sessionId
    expect(handler).toHaveBeenCalledWith('info', 'test', 'Nested session', 'session-2');
  });
});

describe('debugJson', () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  const originalEnv = process.env.DEBUG;

  beforeEach(() => {
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    setLogHandler(null);
    delete process.env.DEBUG;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    setLogHandler(null);
    if (originalEnv !== undefined) {
      process.env.DEBUG = originalEnv;
    }
  });

  it('logs JSON when DEBUG=1', () => {
    process.env.DEBUG = '1';
    const logger = createLogger('test');
    logger.debugJson('Data', { key: 'value' });

    expect(consoleLogSpy).toHaveBeenCalledWith('  [test] Data: {"key":"value"}');
  });

  it('does not log when DEBUG is not set', () => {
    const logger = createLogger('test');
    logger.debugJson('Data', { key: 'value' });

    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('truncates long JSON to default 60 chars', () => {
    process.env.DEBUG = '1';
    const logger = createLogger('test');
    const longData = { message: 'a'.repeat(100) };

    logger.debugJson('Long', longData);

    const call = consoleLogSpy.mock.calls[0] as unknown[];
    const message = call[0] as string;
    expect(message).toContain('…');
    // Message format: "  [test] Long: {truncated JSON}…"
    // JSON should be truncated at 60 chars
  });

  it('respects custom maxLen parameter', () => {
    process.env.DEBUG = '1';
    const logger = createLogger('test');
    const data = { key: 'value12345' };

    logger.debugJson('Short', data, 10);

    const call = consoleLogSpy.mock.calls[0] as unknown[];
    const message = call[0] as string;
    expect(message).toContain('…');
  });

  it('does not truncate short JSON', () => {
    process.env.DEBUG = '1';
    const logger = createLogger('test');
    const data = { x: 1 };

    logger.debugJson('Small', data);

    const call = consoleLogSpy.mock.calls[0] as unknown[];
    const message = call[0] as string;
    expect(message).not.toContain('…');
    expect(message).toBe('  [test] Small: {"x":1}');
  });
});

