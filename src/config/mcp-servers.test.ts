/**
 * MCP server scope (#560): `mcpServers` validation/merge and the
 * `strictMcpConfig` default. Pure functions; no CLI spawned.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import {
  BOT_MCP_SERVER_NAME,
  resolveClaudeAiConnectors,
  resolveMcpServers,
  resolveStrictMcpConfig,
  validateMcpServers,
} from './types.js';

describe('validateMcpServers', () => {
  it('treats an absent map as no servers', () => {
    expect(validateMcpServers(undefined, 'mcpServers')).toEqual({});
    expect(validateMcpServers(null, 'mcpServers')).toEqual({});
  });

  it('normalizes a minimal stdio server', () => {
    expect(validateMcpServers({ fs: { command: 'mcp-fs' } }, 'mcpServers')).toEqual({
      fs: { type: 'stdio', command: 'mcp-fs', args: [], env: {} },
    });
  });

  it('keeps args and env on a stdio server', () => {
    expect(
      validateMcpServers({ gh: { command: 'npx', args: ['-y', 'gh-mcp'], env: { TOKEN: 't' } } }, 'mcpServers').gh,
    ).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'], env: { TOKEN: 't' } });
  });

  it('infers http for a url without a type, and passes sse headers through', () => {
    const out = validateMcpServers(
      {
        docs: { url: 'https://mcp.example.test/' },
        feed: { type: 'sse', url: 'https://sse.example.test/', headers: { Authorization: 'Bearer x' } },
      },
      'mcpServers',
    );
    expect(out.docs).toEqual({ type: 'http', url: 'https://mcp.example.test/' });
    expect(out.feed).toEqual({ type: 'sse', url: 'https://sse.example.test/', headers: { Authorization: 'Bearer x' } });
  });

  it("refuses the bot's own server name", () => {
    expect(() => validateMcpServers({ [BOT_MCP_SERVER_NAME]: { command: 'x' } }, 'mcpServers')).toThrow(
      /claude-threads-mcp.*cannot be redefined/,
    );
  });

  it('refuses names the CLI cannot turn into tool names', () => {
    expect(() => validateMcpServers({ 'bad name': { command: 'x' } }, 'mcpServers')).toThrow(/server names/);
  });

  it('refuses a list, a non-object entry, a stdio server without a command, a remote one without a url', () => {
    expect(() => validateMcpServers([{ command: 'x' }], 'mcpServers')).toThrow(/expected a map/);
    expect(() => validateMcpServers({ a: 'mcp-fs' }, 'mcpServers')).toThrow(/mcpServers\.a: expected an object/);
    expect(() => validateMcpServers({ a: { args: ['x'] } }, 'mcpServers')).toThrow(/needs a command/);
    expect(() => validateMcpServers({ a: { type: 'http' } }, 'mcpServers')).toThrow(/needs a url/);
  });

  it('refuses non-string args, env and headers, and unknown types', () => {
    expect(() => validateMcpServers({ a: { command: 'x', args: [1] } }, 'mcpServers')).toThrow(/\.args/);
    expect(() => validateMcpServers({ a: { command: 'x', env: { N: 1 } } }, 'mcpServers')).toThrow(/\.env/);
    expect(() => validateMcpServers({ a: { type: 'http', url: 'u', headers: { H: 1 } } }, 'mcpServers')).toThrow(/\.headers/);
    expect(() => validateMcpServers({ a: { type: 'grpc', url: 'u' } }, 'mcpServers')).toThrow(/\.type/);
  });

  it('rejects unknown keys, naming them, so a typo cannot pass as an empty option', () => {
    expect(() => validateMcpServers({ a: { command: 'x', arg: ['y'] } }, 'mcpServers')).toThrow(/unknown key\(s\) arg/);
    expect(() => validateMcpServers({ a: { command: 'x', cwd: '/tmp' } }, 'mcpServers')).toThrow(/unknown key\(s\) cwd/);
    expect(() => validateMcpServers({ a: { type: 'http', url: 'u', command: 'rm' } }, 'mcpServers')).toThrow(/both command/);
    expect(() => validateMcpServers({ a: { type: 'sse', url: 'u', timeout: 5 } }, 'mcpServers')).toThrow(/unknown key\(s\) timeout/);
  });

  it('treats a YAML null (an empty "args:" or "env:" line) as an absent key', () => {
    expect(validateMcpServers({ a: { command: 'x', args: null, env: null } }, 'mcpServers').a).toEqual({
      type: 'stdio', command: 'x', args: [], env: {},
    });
    expect(validateMcpServers({ a: { type: 'http', url: 'u', headers: null } }, 'mcpServers').a).toEqual({ type: 'http', url: 'u' });
  });

  it('names the offending field path', () => {
    expect(() => validateMcpServers({ a: {} }, 'platforms[mm].mcpServers')).toThrow(/platforms\[mm\]\.mcpServers\.a/);
  });
});

describe('resolveMcpServers', () => {
  it('merges top-level and platform maps, the platform winning on a clash', () => {
    const out = resolveMcpServers(
      { shared: { command: 'shared-mcp' }, gh: { command: 'gh-global' } },
      { gh: { command: 'gh-platform' }, local: { command: 'local-mcp' } },
      'platforms[mm].mcpServers',
    );
    expect(Object.keys(out).sort()).toEqual(['gh', 'local', 'shared']);
    expect(out.gh).toEqual({ type: 'stdio', command: 'gh-platform', args: [], env: {} });
  });

  it('validates both maps', () => {
    expect(() => resolveMcpServers({ a: {} }, undefined, 'p')).toThrow(/mcpServers\.a/);
    expect(() => resolveMcpServers(undefined, { a: {} }, 'platforms[mm].mcpServers')).toThrow(/platforms\[mm\]\.mcpServers\.a/);
  });
});

describe('resolveStrictMcpConfig', () => {
  it('is opt-in: defaults to false', () => {
    expect(resolveStrictMcpConfig(undefined)).toBe(false);
    expect(resolveStrictMcpConfig(null)).toBe(false);
  });

  it('honors an explicit boolean', () => {
    expect(resolveStrictMcpConfig(false)).toBe(false);
    expect(resolveStrictMcpConfig(true)).toBe(true);
  });

  it('warns and stays off on garbage', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveStrictMcpConfig('nope', 'platforms[mm].strictMcpConfig')).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('platforms[mm].strictMcpConfig');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('resolveClaudeAiConnectors', () => {
  it('defaults to off', () => {
    expect(resolveClaudeAiConnectors(undefined)).toBe(false);
    expect(resolveClaudeAiConnectors(null)).toBe(false);
  });

  it('honors an explicit boolean', () => {
    expect(resolveClaudeAiConnectors(true)).toBe(true);
    expect(resolveClaudeAiConnectors(false)).toBe(false);
  });

  it('warns and stays off on garbage', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveClaudeAiConnectors('yes', 'platforms[mm].claudeAiConnectors')).toBe(false);
      expect(String(warn.mock.calls[0][0])).toContain('platforms[mm].claudeAiConnectors');
    } finally {
      warn.mockRestore();
    }
  });
});
