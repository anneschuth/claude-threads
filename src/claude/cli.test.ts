/**
 * Tests for claude/cli.ts - ClaudeCli class
 */

import { describe, test, expect, beforeEach, afterEach, it } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ClaudeCli,
  buildClaudeChildEnv,
  buildInlineSettings,
  materializeMcpConfig,
  buildPermissionArgs,
  type ClaudeCliOptions,
  type StatusLineData,
  type McpConfigBlob,
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
        memory: null, agentFeatures: null,
      };
      const cli = new ClaudeCli(options);
      expect(cli).toBeDefined();
      expect(cli.isRunning()).toBe(false);
    });

    test('creates instance with all options', () => {
      const options: ClaudeCliOptions = {
        workingDir: '/test/dir',
        threadId: 'thread-123',
        permissionMode: 'bypass',
        sessionId: 'session-uuid',
        resume: false,
        chrome: true,
        appendSystemPrompt: 'test prompt',
        logSessionId: 'log-session-id',
        memory: null, agentFeatures: null,
      };
      const cli = new ClaudeCli(options);
      expect(cli).toBeDefined();
    });

    test('sets debug mode from environment', () => {
      process.env.DEBUG = '1';
      const cli = new ClaudeCli({ workingDir: '/test', memory: null, agentFeatures: null });
      expect(cli.debug).toBe(true);
    });
  });

  describe('isRunning', () => {
    test('returns false when not started', () => {
      const cli = new ClaudeCli({ workingDir: '/test', memory: null, agentFeatures: null });
      expect(cli.isRunning()).toBe(false);
    });
  });

  describe('getStatusFilePath', () => {
    test('returns null before start', () => {
      const cli = new ClaudeCli({ workingDir: '/test', memory: null, agentFeatures: null });
      expect(cli.getStatusFilePath()).toBeNull();
    });
  });

  describe('getStatusData', () => {
    test('returns null when no status file path', () => {
      const cli = new ClaudeCli({ workingDir: '/test', memory: null, agentFeatures: null });
      expect(cli.getStatusData()).toBeNull();
    });
  });

  describe('getLastStderr', () => {
    test('returns empty string initially', () => {
      const cli = new ClaudeCli({ workingDir: '/test', memory: null, agentFeatures: null });
      expect(cli.getLastStderr()).toBe('');
    });
  });

  describe('isPermanentFailure', () => {
    test('returns false with empty stderr', () => {
      const cli = new ClaudeCli({ workingDir: '/test', memory: null, agentFeatures: null });
      expect(cli.isPermanentFailure()).toBe(false);
    });
  });

  describe('getPermanentFailureReason', () => {
    test('returns null with empty stderr', () => {
      const cli = new ClaudeCli({ workingDir: '/test', memory: null, agentFeatures: null });
      expect(cli.getPermanentFailureReason()).toBeNull();
    });
  });

  describe('kill', () => {
    test('resolves immediately when not running', async () => {
      const cli = new ClaudeCli({ workingDir: '/test', memory: null, agentFeatures: null });
      await cli.kill(); // Should not throw
    });
  });

  describe('interrupt', () => {
    test('returns false when not running', () => {
      const cli = new ClaudeCli({ workingDir: '/test', memory: null, agentFeatures: null });
      expect(cli.interrupt()).toBe(false);
    });
  });

  describe('sendMessage', () => {
    test('throws when not running', () => {
      const cli = new ClaudeCli({ workingDir: '/test', memory: null, agentFeatures: null });
      expect(() => cli.sendMessage('test')).toThrow('Not running');
    });
  });

  describe('sendToolResult', () => {
    test('throws when not running', () => {
      const cli = new ClaudeCli({ workingDir: '/test', memory: null, agentFeatures: null });
      expect(() => cli.sendToolResult('tool-id', 'result')).toThrow('Not running');
    });
  });

  describe('start', () => {
    test('throws when permissionMode is not bypass but platformConfig is missing', () => {
      const cli = new ClaudeCli({ workingDir: '/test', permissionMode: 'default', memory: null, agentFeatures: null });
      expect(() => cli.start()).toThrow('platformConfig is required');
    });
  });

  describe('status file operations', () => {
    test('startStatusWatch does nothing without status file path', () => {
      const cli = new ClaudeCli({ workingDir: '/test', memory: null, agentFeatures: null });
      // Should not throw
      cli.startStatusWatch();
    });

    test('stopStatusWatch does nothing without status file path', () => {
      const cli = new ClaudeCli({ workingDir: '/test', memory: null, agentFeatures: null });
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
      const cli = new ClaudeCli({ workingDir: '/test', memory: null, agentFeatures: null });
      const hits: unknown[] = [];
      cli.on('rate-limit', (h) => hits.push(h));

      callGuard(cli, 'Usage limit reached. Resets in 10 minutes.');
      callGuard(cli, 'Usage limit reached. Resets in 10 minutes.');  // same
      callGuard(cli, 'Usage limit reached. Resets in 10 minutes.');  // same

      expect(hits).toHaveLength(1);
    });

    test('re-emits when a later hit extends the cooldown deadline', () => {
      const cli = new ClaudeCli({ workingDir: '/test', memory: null, agentFeatures: null });
      const hits: unknown[] = [];
      cli.on('rate-limit', (h) => hits.push(h));

      callGuard(cli, 'Usage limit reached. Resets in 10 minutes.');
      callGuard(cli, 'Usage limit reached. Resets in 2 hours.');  // longer

      expect(hits).toHaveLength(2);
    });

    test('does not re-emit when a later hit would not advance the deadline', () => {
      const cli = new ClaudeCli({ workingDir: '/test', memory: null, agentFeatures: null });
      const hits: unknown[] = [];
      cli.on('rate-limit', (h) => hits.push(h));

      callGuard(cli, 'Usage limit reached. Resets in 2 hours.');
      callGuard(cli, 'Usage limit reached. Resets in 10 minutes.');  // earlier

      expect(hits).toHaveLength(1);
    });

    test('ignores non-rate-limit text', () => {
      const cli = new ClaudeCli({ workingDir: '/test', memory: null, agentFeatures: null });
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

    test('sets MCP_TOOL_TIMEOUT when a decision bridge is in play', () => {
      const env = buildClaudeChildEnv({ PATH: '/usr/bin' }, undefined, { decisionBridge: true });
      expect(env.MCP_TOOL_TIMEOUT).toBe('3600000');
    });

    test('leaves MCP_TOOL_TIMEOUT unset without a decision bridge', () => {
      expect(buildClaudeChildEnv({ PATH: '/usr/bin' }).MCP_TOOL_TIMEOUT).toBeUndefined();
      expect(
        buildClaudeChildEnv({ PATH: '/usr/bin' }, undefined, { decisionBridge: false }).MCP_TOOL_TIMEOUT
      ).toBeUndefined();
    });

    test('respects a parent-env MCP_TOOL_TIMEOUT override', () => {
      const env = buildClaudeChildEnv({ MCP_TOOL_TIMEOUT: '120000' }, undefined, {
        decisionBridge: true,
      });
      expect(env.MCP_TOOL_TIMEOUT).toBe('120000');
    });

    test('ClaudeCli wires decisionBridgePath through to MCP_TOOL_TIMEOUT', () => {
      // Pin the private buildChildEnv() wiring, not just the pure function:
      // deleting the opts pass-through must fail this test.
      const withBridge = new ClaudeCli({ workingDir: '/test', decisionBridgePath: '/tmp/b.sock', memory: null, agentFeatures: null });
      const without = new ClaudeCli({ workingDir: '/test', memory: null, agentFeatures: null });
      const call = (cli: ClaudeCli) =>
        (cli as unknown as { buildChildEnv(): NodeJS.ProcessEnv }).buildChildEnv();
      const hadParent = process.env.MCP_TOOL_TIMEOUT;
      delete process.env.MCP_TOOL_TIMEOUT;
      try {
        expect(call(withBridge).MCP_TOOL_TIMEOUT).toBe('3600000');
        expect(call(without).MCP_TOOL_TIMEOUT).toBeUndefined();
      } finally {
        if (hadParent !== undefined) process.env.MCP_TOOL_TIMEOUT = hadParent;
      }
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

// ============================================================================
// materializeMcpConfig — production always writes to an owner-only tempfile
// so the platform token does not appear in `ps`. The `inline` opt is kept
// for tests only.
// ============================================================================
describe('materializeMcpConfig', () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'mcp-config-test-'));
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  function makeConfig(): McpConfigBlob {
    return {
      mcpServers: {
        'claude-threads-mcp': {
          type: 'stdio',
          command: 'node',
          args: ['/path/to/mcp-server.js'],
          env: { PLATFORM_TOKEN: 'SECRET-TOKEN', PLATFORM_TYPE: 'mattermost' },
        },
      },
    };
  }

  it('writes config to a tempfile with mode 0o600 by default (Unix)', () => {
    if (process.platform === 'win32') return; // mode bits are emulated on Windows
    const result = materializeMcpConfig(makeConfig(), 'session-abc', { tmpDirOverride: scratchDir });
    expect(result.mode).toBe('file');
    if (result.mode !== 'file') return;
    expect(existsSync(result.path)).toBe(true);
    const mode = statSync(result.path).mode & 0o777;
    expect(mode).toBe(0o600);
    rmSync(result.path);
  });

  it('writes the full config JSON to the tempfile (round-trips)', () => {
    const result = materializeMcpConfig(makeConfig(), 'session-xyz', { tmpDirOverride: scratchDir });
    if (result.mode !== 'file') throw new Error('expected file mode');
    const parsed = JSON.parse(readFileSync(result.path, 'utf8')) as McpConfigBlob;
    const server = parsed.mcpServers['claude-threads-mcp'];
    expect(server.env.PLATFORM_TOKEN).toBe('SECRET-TOKEN');
    rmSync(result.path);
  });

  it('puts the sessionId in the filename for cross-session debugging', () => {
    const result = materializeMcpConfig(makeConfig(), 'abc-123', { tmpDirOverride: scratchDir });
    if (result.mode !== 'file') throw new Error('expected file mode');
    expect(result.path).toContain('abc-123');
    rmSync(result.path);
  });

  it('returns inline JSON when the opt-in is explicitly set (test-only)', () => {
    const result = materializeMcpConfig(makeConfig(), 'session-abc', { inline: true, tmpDirOverride: scratchDir });
    expect(result.mode).toBe('inline');
    if (result.mode !== 'inline') return;
    expect(result.value).toContain('SECRET-TOKEN');
    // Critical: no stray file written when inline mode selected.
    expect(readdirOrEmpty(scratchDir)).toEqual([]);
  });
});

function readdirOrEmpty(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ============================================================================
// buildPermissionArgs — verifies the three-mode permission spawn logic
// (bypass → --dangerously-skip-permissions; default → MCP server only;
//  auto → MCP server + --permission-mode auto).
// ============================================================================
describe('buildPermissionArgs', () => {
  const baseOpts = {
    mcpServerPath: '/path/to/mcp-server.js',
    platformConfig: {
      type: 'mattermost' as const,
      url: 'https://example.test',
      token: 'SECRET-TOKEN',
      channelId: 'c-1',
      allowedUsers: ['alice'],
    },
    threadId: 't-1',
    sessionId: 's-1',
    permissionTimeoutMs: 120_000,
    debug: false,
    inline: true, // keep tests off disk
  };

  it("bypass: still spawns the MCP server so send_file is available, but no --permission-prompt-tool", () => {
    const { args } = buildPermissionArgs({ ...baseOpts, permissionMode: 'bypass' });
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('--mcp-config');
    // Bypass means no prompts ever — the prompt tool flag would be a no-op
    // anyway, but explicitly omit it so the contract stays clean.
    expect(args).not.toContain('--permission-prompt-tool');
    expect(args).not.toContain('--permission-mode');
    // Critical: the token is NOT in the argv. It's in the MCP config blob,
    // which lives in a tempfile (or inline JSON for tests).
    const argvWithoutMcpConfig = args.filter((_, i) => args[i - 1] !== '--mcp-config');
    expect(argvWithoutMcpConfig.join(' ')).not.toContain('SECRET-TOKEN');
  });

  it("bypass without platformConfig still works (legacy / dry-run path)", () => {
    // The original behavior: someone running with bypass + no platform
    // (e.g. headless test fixtures) gets the dangerous-skip flag and no
    // MCP server. send_file is unavailable in this case but that's
    // documented — the choice is theirs.
    const { args, tempFile } = buildPermissionArgs({
      ...baseOpts,
      platformConfig: undefined,
      permissionMode: 'bypass',
    });
    expect(args).toEqual(['--dangerously-skip-permissions']);
    expect(tempFile).toBeNull();
  });

  it("default: emits --mcp-config + --permission-prompt-tool, no --permission-mode", () => {
    const { args } = buildPermissionArgs({ ...baseOpts, permissionMode: 'default' });
    expect(args).toContain('--mcp-config');
    expect(args).toContain('--permission-prompt-tool');
    expect(args).toContain('mcp__claude-threads-mcp__permission_prompt');
    expect(args).not.toContain('--permission-mode');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('runs a built .js MCP server under node', () => {
    const { args } = buildPermissionArgs({ ...baseOpts, permissionMode: 'default' });
    const blob = JSON.parse(args[args.indexOf('--mcp-config') + 1]) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(blob.mcpServers['claude-threads-mcp'].command).toBe('node');
    expect(blob.mcpServers['claude-threads-mcp'].args).toEqual(['/path/to/mcp-server.js']);
  });

  it('runtimeForScriptPath: node for built .js, current runtime for source .ts', async () => {
    const { runtimeForScriptPath } = await import('./cli.js');
    expect(runtimeForScriptPath('/opt/app/dist/statusline/writer.js')).toBe('node');
    expect(runtimeForScriptPath('/repo/src/statusline/writer.ts')).toBe(process.execPath);
  });

  it('runs a source-mode .ts MCP server under the current runtime (dev mode)', () => {
    // Source/dev runs have no dist build: getMcpServerPath resolves the .ts,
    // which node cannot execute — the config must use the current runtime.
    const { args } = buildPermissionArgs({
      ...baseOpts,
      mcpServerPath: '/repo/src/mcp/mcp-server.ts',
      permissionMode: 'default',
    });
    const blob = JSON.parse(args[args.indexOf('--mcp-config') + 1]) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(blob.mcpServers['claude-threads-mcp'].command).toBe(process.execPath);
    expect(blob.mcpServers['claude-threads-mcp'].args).toEqual(['/repo/src/mcp/mcp-server.ts']);
  });

  it("auto: emits --mcp-config AND --permission-mode auto", () => {
    const { args } = buildPermissionArgs({ ...baseOpts, permissionMode: 'auto' });
    expect(args).toContain('--mcp-config');
    expect(args).toContain('--permission-prompt-tool');
    expect(args).toContain('--permission-mode');
    // The `auto` value must follow `--permission-mode` (commander-style argv).
    const modeIndex = args.indexOf('--permission-mode');
    expect(args[modeIndex + 1]).toBe('auto');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it("default + auto throw if platformConfig is missing (MCP path can't run without credentials)", () => {
    expect(() => buildPermissionArgs({
      ...baseOpts,
      platformConfig: undefined,
      permissionMode: 'default',
    })).toThrow(/platformConfig is required/);

    expect(() => buildPermissionArgs({
      ...baseOpts,
      platformConfig: undefined,
      permissionMode: 'auto',
    })).toThrow(/platformConfig is required/);
  });

  it("bypass without platformConfig does not throw (legacy path supported)", () => {
    expect(() => buildPermissionArgs({
      ...baseOpts,
      platformConfig: undefined,
      permissionMode: 'bypass',
    })).not.toThrow();
  });

  it("inline mode returns tempFile=null (rollback flag path)", () => {
    const { tempFile } = buildPermissionArgs({ ...baseOpts, permissionMode: 'default', inline: true });
    expect(tempFile).toBeNull();
  });

  it("file mode returns a path for later cleanup", () => {
    const scratch = mkdtempSync(join(tmpdir(), 'perm-args-'));
    try {
      // Temporarily override the tmpdir the test will write to.
      const { tempFile } = buildPermissionArgs({
        ...baseOpts,
        permissionMode: 'default',
        inline: false,
      });
      expect(tempFile).toBeString();
      if (tempFile) rmSync(tempFile);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  // Helper: in inline mode, --mcp-config is followed by the JSON blob, so we
  // can parse it and inspect the env vars the permission server will see.
  function getMcpEnv(args: string[]): Record<string, string> {
    const idx = args.indexOf('--mcp-config');
    expect(idx).toBeGreaterThanOrEqual(0);
    const blob = JSON.parse(args[idx + 1]);
    return blob.mcpServers['claude-threads-mcp'].env;
  }

  it("forwards SESSION_WORKING_DIR and SESSION_UPLOAD_DIR to the MCP child", () => {
    const { args } = buildPermissionArgs({
      ...baseOpts,
      permissionMode: 'default',
      workingDir: '/srv/work',
      uploadDir: '/tmp/uploads/X',
    });
    const env = getMcpEnv(args);
    expect(env.SESSION_WORKING_DIR).toBe('/srv/work');
    expect(env.SESSION_UPLOAD_DIR).toBe('/tmp/uploads/X');
  });

  it('forwards DECISION_BRIDGE_PATH (and the timeout override) to the MCP child', () => {
    const prev = process.env.DECISION_BRIDGE_TIMEOUT_MS;
    process.env.DECISION_BRIDGE_TIMEOUT_MS = '120000';
    try {
      const { args } = buildPermissionArgs({
        ...baseOpts,
        permissionMode: 'default',
        decisionBridgePath: '/tmp/bridge-X.sock',
      });
      const env = getMcpEnv(args);
      expect(env.DECISION_BRIDGE_PATH).toBe('/tmp/bridge-X.sock');
      // Stdio MCP children get an explicit env — without forwarding, the
      // operator's timeout knob would be unreachable.
      expect(env.DECISION_BRIDGE_TIMEOUT_MS).toBe('120000');
    } finally {
      if (prev === undefined) delete process.env.DECISION_BRIDGE_TIMEOUT_MS;
      else process.env.DECISION_BRIDGE_TIMEOUT_MS = prev;
    }
  });

  it('omits DECISION_BRIDGE_PATH when no bridge exists', () => {
    const { args } = buildPermissionArgs({ ...baseOpts, permissionMode: 'default' });
    const env = getMcpEnv(args);
    expect(env.DECISION_BRIDGE_PATH).toBeUndefined();
    expect(env.DECISION_BRIDGE_TIMEOUT_MS).toBeUndefined();
  });

  it('emits the agent-feature gates only for enabled features (and only with a bridge)', () => {
    const { args } = buildPermissionArgs({
      ...baseOpts,
      permissionMode: 'default',
      decisionBridgePath: '/tmp/bridge-X.sock',
      agentFeatures: { memoryChannel: true, routines: false, watches: true, unattended: true, dcm: false },
    });
    const env = getMcpEnv(args);
    expect(env.CT_MEMORY_CHANNEL_ENABLED).toBe('1');
    expect(env.CT_ROUTINES_ENABLED).toBeUndefined();
    expect(env.CT_WATCHES_ENABLED).toBe('1');
    expect(env.CT_UNATTENDED).toBe('1');
  });

  it('emits NO agent-feature gates without a bridge (no path to the stores)', () => {
    const { args } = buildPermissionArgs({
      ...baseOpts,
      permissionMode: 'default',
      agentFeatures: { memoryChannel: true, routines: true, watches: true, unattended: false, dcm: false },
    });
    const env = getMcpEnv(args);
    expect(env.CT_MEMORY_CHANNEL_ENABLED).toBeUndefined();
    expect(env.CT_ROUTINES_ENABLED).toBeUndefined();
    expect(env.CT_WATCHES_ENABLED).toBeUndefined();
  });

  it('emits CT_DCM for direct-channel-mode sessions', () => {
    const { args } = buildPermissionArgs({
      ...baseOpts,
      permissionMode: 'default',
      decisionBridgePath: '/tmp/bridge-X.sock',
      agentFeatures: { memoryChannel: false, routines: true, watches: true, unattended: false, dcm: true },
    });
    const env = getMcpEnv(args);
    expect(env.CT_DCM).toBe('1');
  });

  it('agentFeatures: null emits no gates even with a bridge', () => {
    const { args } = buildPermissionArgs({
      ...baseOpts,
      permissionMode: 'default',
      decisionBridgePath: '/tmp/bridge-X.sock',
      agentFeatures: null,
    });
    const env = getMcpEnv(args);
    expect(env.CT_MEMORY_CHANNEL_ENABLED).toBeUndefined();
    expect(env.CT_UNATTENDED).toBeUndefined();
  });

  it("omits the upload-related env vars entirely when no roots provided", () => {
    const { args } = buildPermissionArgs({ ...baseOpts, permissionMode: 'default' });
    const env = getMcpEnv(args);
    expect(env.SESSION_WORKING_DIR).toBeUndefined();
    expect(env.SESSION_UPLOAD_DIR).toBeUndefined();
    expect(env.OUTBOUND_FILES_ENABLED).toBeUndefined();
    expect(env.OUTBOUND_FILES_MAX_BYTES).toBeUndefined();
  });

  it("emits OUTBOUND_FILES_ENABLED=0 only when explicitly disabled", () => {
    const enabledArgs = buildPermissionArgs({
      ...baseOpts,
      permissionMode: 'default',
      outboundFiles: { enabled: true },
    }).args;
    expect(getMcpEnv(enabledArgs).OUTBOUND_FILES_ENABLED).toBeUndefined();

    const disabledArgs = buildPermissionArgs({
      ...baseOpts,
      permissionMode: 'default',
      outboundFiles: { enabled: false },
    }).args;
    expect(getMcpEnv(disabledArgs).OUTBOUND_FILES_ENABLED).toBe('0');
  });

  it("forwards a custom maxBytes cap", () => {
    const { args } = buildPermissionArgs({
      ...baseOpts,
      permissionMode: 'default',
      outboundFiles: { maxBytes: 5_000_000 },
    });
    expect(getMcpEnv(args).OUTBOUND_FILES_MAX_BYTES).toBe('5000000');
  });

  it("drops invalid maxBytes values (negative, zero, NaN, Infinity)", () => {
    for (const bad of [-1, 0, NaN, Infinity, -Infinity]) {
      const { args } = buildPermissionArgs({
        ...baseOpts,
        permissionMode: 'default',
        outboundFiles: { maxBytes: bad },
      });
      expect(getMcpEnv(args).OUTBOUND_FILES_MAX_BYTES).toBeUndefined();
    }
  });

  it("bypass + platformConfig forwards outbound-env so send_file works", () => {
    // Regression guard: pre-fix, bypass took an early return and never
    // emitted the SESSION_WORKING_DIR / SESSION_UPLOAD_DIR vars, which made
    // send_file silently unavailable in the mode operators most often use.
    const { args } = buildPermissionArgs({
      ...baseOpts,
      permissionMode: 'bypass',
      workingDir: '/srv/work',
      uploadDir: '/tmp/uploads/X',
    });
    const env = getMcpEnv(args);
    expect(env.SESSION_WORKING_DIR).toBe('/srv/work');
    expect(env.SESSION_UPLOAD_DIR).toBe('/tmp/uploads/X');
  });
});

describe('rate-limit emit guard - structured/reset-less interplay', () => {
  const callGuard = (cli: ClaudeCli, text: string) =>
    (cli as unknown as { maybeEmitRateLimit: (t: string) => void }).maybeEmitRateLimit(text);
  const callHit = (cli: ClaudeCli, hit: unknown) =>
    (cli as unknown as { maybeEmitRateLimitHit: (h: unknown) => void }).maybeEmitRateLimitHit(hit);

  test('a reset-less hit is suppressed while a precise structured deadline is cooling', () => {
    const cli = new ClaudeCli({ workingDir: '/test', memory: null, agentFeatures: null });
    const hits: unknown[] = [];
    cli.on('rate-limit', (h) => hits.push(h));

    // Structured rejected event with an exact reset 30 min out
    callHit(cli, {
      detected: true,
      resetAtEpochMs: Date.now() + 30 * 60_000,
      matched: 'rate_limit_event status=rejected',
    });
    // Same turn's error body: phrase matches but carries no reset time —
    // without suppression the 1h default would stretch the cooldown past
    // the real reset (the pool only ever extends).
    callGuard(cli, 'Usage limit reached.');

    expect(hits).toHaveLength(1);
  });

  test('reset-less repeats during a reset-less cooldown still re-emit and extend', () => {
    const cli = new ClaudeCli({ workingDir: '/test', memory: null, agentFeatures: null });
    const hits: unknown[] = [];
    cli.on('rate-limit', (h) => hits.push(h));

    callGuard(cli, 'Usage limit reached.'); // reset-less → 1h default
    // Simulate 50 minutes passing: rewind the recorded deadline
    (cli as unknown as { lastEmittedRateLimitDeadline: number }).lastEmittedRateLimitDeadline =
      Date.now() + 10 * 60_000;
    callGuard(cli, 'Usage limit reached.'); // still limited → must extend

    expect(hits).toHaveLength(2);
  });

  test('a reset-less hit after the structured deadline expired emits normally', () => {
    const cli = new ClaudeCli({ workingDir: '/test', memory: null, agentFeatures: null });
    const hits: unknown[] = [];
    cli.on('rate-limit', (h) => hits.push(h));

    callHit(cli, {
      detected: true,
      resetAtEpochMs: Date.now() + 30 * 60_000,
      matched: 'rate_limit_event status=rejected',
    });
    // Simulate the deadline having passed
    (cli as unknown as { lastEmittedRateLimitDeadline: number }).lastEmittedRateLimitDeadline =
      Date.now() - 1000;
    callGuard(cli, 'Usage limit reached.');

    expect(hits).toHaveLength(2);
  });

  test('parseOutput wires structured rate_limit_event rejections to the rate-limit emitter', () => {
    const cli = new ClaudeCli({ workingDir: '/test', memory: null, agentFeatures: null });
    const hits: Array<{ resetAtEpochMs?: number }> = [];
    cli.on('rate-limit', (h) => hits.push(h as { resetAtEpochMs?: number }));
    const parse = (line: string) =>
      (cli as unknown as { parseOutput: (d: string) => void }).parseOutput(line + '\n');

    const resetsAt = Math.floor(Date.now() / 1000) + 1800;
    // Healthy every-turn event: must NOT emit
    parse(JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', resetsAt, rateLimitType: 'five_hour' },
    }));
    expect(hits).toHaveLength(0);
    // Warning: must NOT emit either
    parse(JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed_warning', resetsAt, utilization: 0.8 },
    }));
    expect(hits).toHaveLength(0);
    // Rejection: emits with the converted deadline
    parse(JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' },
    }));
    expect(hits).toHaveLength(1);
    expect(hits[0].resetAtEpochMs).toBe(resetsAt * 1000);
  });

  test("a throwing 'event' listener neither skips the rate-limit scan nor masquerades as parse noise", () => {
    // Session persistence (and other side effects) run synchronously inside
    // the 'event' listener chain. If a listener throws (e.g. disk full during
    // a turn-end persist), the error must not abort the rate-limit scan for
    // that same event — error-flavored results are exactly the events that
    // carry rate-limit signals — nor be silently eaten by the JSON-parse
    // catch for partial lines.
    const cli = new ClaudeCli({ workingDir: '/test', memory: null, agentFeatures: null });
    const hits: unknown[] = [];
    cli.on('rate-limit', (h) => hits.push(h));
    cli.on('event', () => { throw new Error('listener boom (persist failed)'); });
    const parse = (line: string) =>
      (cli as unknown as { parseOutput: (d: string) => void }).parseOutput(line + '\n');

    parse(JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'Claude AI usage limit reached|' + Math.floor(Date.now() / 1000 + 1800),
    }));

    expect(hits).toHaveLength(1);
  });
});

describe('rate-limit emit guard - suppressed explicit hit keeps its explicitness', () => {
  const callGuard = (cli: ClaudeCli, text: string) =>
    (cli as unknown as { maybeEmitRateLimit: (t: string) => void }).maybeEmitRateLimit(text);
  const callHit = (cli: ClaudeCli, hit: unknown) =>
    (cli as unknown as { maybeEmitRateLimitHit: (h: unknown) => void }).maybeEmitRateLimitHit(hit);

  test('opposite arrival order: text guess first, precise reset second, reset-less repeat third', () => {
    const cli = new ClaudeCli({ workingDir: '/test', memory: null, agentFeatures: null });
    const hits: unknown[] = [];
    cli.on('rate-limit', (h) => hits.push(h));

    // (1) reset-less stderr hit arrives first: emit, 1h default guess
    callGuard(cli, 'Usage limit reached.');
    // (2) the same turn's structured event carries the REAL reset, 30 min out
    //     — suppressed by MIN_ADVANCE (shorter deadline), but its explicitness
    //     must be recorded
    callHit(cli, {
      detected: true,
      resetAtEpochMs: Date.now() + 30 * 60_000,
      matched: 'rate_limit_event status=rejected',
    });
    expect(hits).toHaveLength(1);
    // (3) a reset-less repeat must now be suppressed — extending the guess
    //     past the known real reset is exactly what this prevents. Simulate
    //     time passing so MIN_ADVANCE alone would NOT suppress it.
    (cli as unknown as { lastEmittedRateLimitDeadline: number }).lastEmittedRateLimitDeadline =
      Date.now() + 10 * 60_000;
    callGuard(cli, 'Usage limit reached.');

    expect(hits).toHaveLength(1);
  });
});

describe('buildInlineSettings (memory + statusLine)', () => {
  test('returns null when nothing needs settings (pre-memory behavior preserved)', () => {
    expect(buildInlineSettings(undefined, null)).toBeNull();
  });

  test('statusLine only when no memory', () => {
    const settings = buildInlineSettings('node writer.js abc', null)!;
    expect(settings.statusLine).toMatchObject({ type: 'command', command: 'node writer.js abc' });
    expect(settings.autoMemoryEnabled).toBeUndefined();
    expect(settings.autoMemoryDirectory).toBeUndefined();
  });

  test('memory redirect only when no sessionId/statusLine', () => {
    const settings = buildInlineSettings(undefined, { autoMemoryDir: '/mem/mm/repos/x' })!;
    expect(settings.autoMemoryEnabled).toBe(true);
    expect(settings.autoMemoryDirectory).toBe('/mem/mm/repos/x');
    expect(settings.statusLine).toBeUndefined();
  });

  test('statusLine and memory coexist in one settings object', () => {
    const settings = buildInlineSettings('node w.js s1', { autoMemoryDir: '/mem/dir' })!;
    expect(settings.statusLine).toBeDefined();
    expect(settings.autoMemoryDirectory).toBe('/mem/dir');
  });
});

describe('buildClaudeChildEnv — auto-memory kill switch', () => {
  test('disableAutoMemory sets CLAUDE_CODE_DISABLE_AUTO_MEMORY=1', () => {
    const env = buildClaudeChildEnv({}, undefined, { disableAutoMemory: true });
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
  });

  test('overrides a parent env value (privacy measure, not tuning)', () => {
    // With an account pool, $HOME is shared by sessions from other channels —
    // native auto-memory writing there would leak context across privacy
    // boundaries, so memory-off must win even over an explicit parent value.
    const env = buildClaudeChildEnv({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' }, undefined, {
      disableAutoMemory: true,
    });
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
  });

  test('leaves the env alone when memory is enabled', () => {
    const env = buildClaudeChildEnv({}, undefined, { disableAutoMemory: false });
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
  });

  test('ClaudeCli wires memory: null, agentFeatures: null through to the kill switch', () => {
    const cli = new ClaudeCli({ workingDir: '/test', memory: null, agentFeatures: null });
    const env = (cli as unknown as { buildChildEnv(): NodeJS.ProcessEnv }).buildChildEnv();
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
  });

  test('ClaudeCli does not set the kill switch when memory is configured', () => {
    const cli = new ClaudeCli({ workingDir: '/test', memory: { autoMemoryDir: '/mem' }, agentFeatures: null });
    const env = (cli as unknown as { buildChildEnv(): NodeJS.ProcessEnv }).buildChildEnv();
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
  });
});
