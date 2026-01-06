/**
 * Tests for claude/cli.ts - ClaudeCli class
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeCli, type ClaudeCliOptions, type StatusLineData } from './cli.js';

describe('ClaudeCli', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('constructor', () => {
    test('creates instance with required options', () => {
      const options: ClaudeCliOptions = {
        workingDir: '/test/dir',
      };
      const cli = new ClaudeCli(options);
      expect(cli).toBeDefined();
      expect(cli.isRunning()).toBe(false);
    });

    test('creates instance with all options', () => {
      const options: ClaudeCliOptions = {
        workingDir: '/test/dir',
        threadId: 'thread-123',
        skipPermissions: true,
        sessionId: 'session-uuid',
        resume: false,
        chrome: true,
        appendSystemPrompt: 'test prompt',
        logSessionId: 'log-session-id',
      };
      const cli = new ClaudeCli(options);
      expect(cli).toBeDefined();
    });

    test('sets debug mode from environment', () => {
      process.env.DEBUG = '1';
      const cli = new ClaudeCli({ workingDir: '/test' });
      expect(cli.debug).toBe(true);
    });
  });

  describe('isRunning', () => {
    test('returns false when not started', () => {
      const cli = new ClaudeCli({ workingDir: '/test' });
      expect(cli.isRunning()).toBe(false);
    });
  });

  describe('getStatusFilePath', () => {
    test('returns null before start', () => {
      const cli = new ClaudeCli({ workingDir: '/test' });
      expect(cli.getStatusFilePath()).toBeNull();
    });
  });

  describe('getStatusData', () => {
    test('returns null when no status file path', () => {
      const cli = new ClaudeCli({ workingDir: '/test' });
      expect(cli.getStatusData()).toBeNull();
    });
  });

  describe('getLastStderr', () => {
    test('returns empty string initially', () => {
      const cli = new ClaudeCli({ workingDir: '/test' });
      expect(cli.getLastStderr()).toBe('');
    });
  });

  describe('isPermanentFailure', () => {
    test('returns false with empty stderr', () => {
      const cli = new ClaudeCli({ workingDir: '/test' });
      expect(cli.isPermanentFailure()).toBe(false);
    });
  });

  describe('getPermanentFailureReason', () => {
    test('returns null with empty stderr', () => {
      const cli = new ClaudeCli({ workingDir: '/test' });
      expect(cli.getPermanentFailureReason()).toBeNull();
    });
  });

  describe('kill', () => {
    test('resolves immediately when not running', async () => {
      const cli = new ClaudeCli({ workingDir: '/test' });
      await cli.kill(); // Should not throw
    });
  });

  describe('interrupt', () => {
    test('returns false when not running', () => {
      const cli = new ClaudeCli({ workingDir: '/test' });
      expect(cli.interrupt()).toBe(false);
    });
  });

  describe('sendMessage', () => {
    test('throws when not running', () => {
      const cli = new ClaudeCli({ workingDir: '/test' });
      expect(() => cli.sendMessage('test')).toThrow('Not running');
    });
  });

  describe('sendToolResult', () => {
    test('throws when not running', () => {
      const cli = new ClaudeCli({ workingDir: '/test' });
      expect(() => cli.sendToolResult('tool-id', 'result')).toThrow('Not running');
    });
  });

  describe('start', () => {
    test('throws when skipPermissions is false but no platformConfig', () => {
      const cli = new ClaudeCli({ workingDir: '/test', skipPermissions: false });
      expect(() => cli.start()).toThrow('platformConfig is required');
    });
  });

  describe('status file operations', () => {
    test('startStatusWatch does nothing without status file path', () => {
      const cli = new ClaudeCli({ workingDir: '/test' });
      // Should not throw
      cli.startStatusWatch();
    });

    test('stopStatusWatch does nothing without status file path', () => {
      const cli = new ClaudeCli({ workingDir: '/test' });
      // Should not throw
      cli.stopStatusWatch();
    });
  });
});

describe('StatusLineData interface', () => {
  test('accepts valid status data', () => {
    const data: StatusLineData = {
      context_window_size: 200000,
      total_input_tokens: 1000,
      total_output_tokens: 500,
      current_usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      model: {
        id: 'claude-opus-4-5-20251101',
        display_name: 'Opus 4.5',
      },
      cost: {
        total_cost_usd: 0.05,
      },
      timestamp: Date.now(),
    };
    expect(data.context_window_size).toBe(200000);
    expect(data.model?.display_name).toBe('Opus 4.5');
  });

  test('accepts minimal status data with nulls', () => {
    const data: StatusLineData = {
      context_window_size: 200000,
      total_input_tokens: 0,
      total_output_tokens: 0,
      current_usage: null,
      model: null,
      cost: null,
      timestamp: Date.now(),
    };
    expect(data.current_usage).toBeNull();
    expect(data.model).toBeNull();
    expect(data.cost).toBeNull();
  });
});
