/**
 * Tests for claude/cli.ts - ClaudeCli class
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  ClaudeCli,
  buildClaudeChildEnv,
  type ClaudeCliOptions,
  type StatusLineData,
} from './cli.js';

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

  describe('rate-limit emit guard', () => {
    /**
     * The ClaudeCli class exposes `'rate-limit'` events through a private
     * `maybeEmitRateLimit` guard. The guard must dedupe repeat hits at the
     * same severity (avoiding spam from stderr chunks) but still forward a
     * new hit whose cooldown deadline moves FORWARD — otherwise
     * `AccountPool.markCooling` (extend-only) would never see the wider
     * window and the account would stay cool for only the shorter of the
     * two deadlines.
     *
     * Using `(cli as any)` to reach the private method keeps the test tiny
     * and hits exactly the code path that parseOutput / stderr handler use.
     */
    const callGuard = (cli: ClaudeCli, text: string) =>
      (cli as unknown as { maybeEmitRateLimit: (t: string) => void }).maybeEmitRateLimit(text);

    test('emits on first hit, dedupes identical repeats', () => {
      const cli = new ClaudeCli({ workingDir: '/test' });
      const hits: unknown[] = [];
      cli.on('rate-limit', (h) => hits.push(h));

      callGuard(cli, 'Usage limit reached. Resets in 10 minutes.');
      callGuard(cli, 'Usage limit reached. Resets in 10 minutes.');  // same
      callGuard(cli, 'Usage limit reached. Resets in 10 minutes.');  // same

      expect(hits).toHaveLength(1);
    });

    test('re-emits when a later hit extends the cooldown deadline', () => {
      const cli = new ClaudeCli({ workingDir: '/test' });
      const hits: unknown[] = [];
      cli.on('rate-limit', (h) => hits.push(h));

      callGuard(cli, 'Usage limit reached. Resets in 10 minutes.');
      callGuard(cli, 'Usage limit reached. Resets in 2 hours.');  // longer

      expect(hits).toHaveLength(2);
    });

    test('does not re-emit when a later hit would not advance the deadline', () => {
      const cli = new ClaudeCli({ workingDir: '/test' });
      const hits: unknown[] = [];
      cli.on('rate-limit', (h) => hits.push(h));

      callGuard(cli, 'Usage limit reached. Resets in 2 hours.');
      callGuard(cli, 'Usage limit reached. Resets in 10 minutes.');  // earlier

      expect(hits).toHaveLength(1);
    });

    test('ignores non-rate-limit text', () => {
      const cli = new ClaudeCli({ workingDir: '/test' });
      const hits: unknown[] = [];
      cli.on('rate-limit', (h) => hits.push(h));

      callGuard(cli, 'some unrelated stderr line');
      callGuard(cli, 'context limit approaching');

      expect(hits).toHaveLength(0);
    });
  });

  describe('buildClaudeChildEnv', () => {
    test('applies always-on tuning flags when parent env has none', () => {
      const env = buildClaudeChildEnv({ PATH: '/usr/bin' });
      expect(env.MCP_CONNECTION_NONBLOCKING).toBe('true');
      expect(env.ENABLE_PROMPT_CACHING_1H).toBe('true');
      expect(env.PATH).toBe('/usr/bin');
    });

    test('respects parent overrides for tuning flags', () => {
      const env = buildClaudeChildEnv({
        MCP_CONNECTION_NONBLOCKING: 'false',
        ENABLE_PROMPT_CACHING_1H: '0',
      });
      expect(env.MCP_CONNECTION_NONBLOCKING).toBe('false');
      expect(env.ENABLE_PROMPT_CACHING_1H).toBe('0');
    });

    test('passes through opt-in hardening flags like SUBPROCESS_ENV_SCRUB', () => {
      const env = buildClaudeChildEnv({ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' });
      expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
    });

    test('account.home swaps HOME and clears competing credentials', () => {
      const parent = {
        HOME: '/home/bot',
        ANTHROPIC_API_KEY: 'sk-bot',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-bot',
      };
      const env = buildClaudeChildEnv(parent, { id: 'a', home: '/home/alt' });
      expect(env.HOME).toBe('/home/alt');
      expect(env.USERPROFILE).toBe('/home/alt');
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    test('account.apiKey overrides key and clears inherited OAuth token', () => {
      const parent = {
        HOME: '/home/bot',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-bot',
      };
      const env = buildClaudeChildEnv(parent, { id: 'b', apiKey: 'sk-alt' });
      expect(env.ANTHROPIC_API_KEY).toBe('sk-alt');
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      // HOME must not move when only apiKey is set.
      expect(env.HOME).toBe('/home/bot');
    });

    test('does not mutate the passed-in parent env', () => {
      const parent: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
      buildClaudeChildEnv(parent);
      expect(parent.MCP_CONNECTION_NONBLOCKING).toBeUndefined();
      expect(parent.ENABLE_PROMPT_CACHING_1H).toBeUndefined();
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
