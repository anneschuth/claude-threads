/**
 * resolvePlatformMcpPosture (#560): the startup resolution of mcpServers /
 * strictMcpConfig / claudeAiConnectors per platform, including the
 * enterprise managed-MCP downgrade.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import { resolvePlatformMcpPosture } from './mcp-posture.js';
import type { PlatformInstanceConfig } from './types.js';

const platform = (extra: Partial<PlatformInstanceConfig> = {}): PlatformInstanceConfig => ({
  id: 'mm', type: 'mattermost', displayName: 'MM', ...extra,
} as PlatformInstanceConfig);

describe('resolvePlatformMcpPosture', () => {
  it('fills the defaults in place: no declared servers, connectors off, strict off', () => {
    const p = platform();
    const { warnings } = resolvePlatformMcpPosture([p], undefined, () => false);
    expect(p.mcpServers).toEqual({});
    expect(p.claudeAiConnectors).toBe(false);
    expect(p.strictMcpConfig).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('merges top-level and platform servers, platform winning', () => {
    const p = platform({ mcpServers: { gh: { command: 'gh-platform' } } });
    resolvePlatformMcpPosture([p], { gh: { command: 'gh-global' }, docs: { type: 'http', url: 'https://d/' } }, () => false);
    expect(Object.keys(p.mcpServers!).sort()).toEqual(['docs', 'gh']);
    expect(p.mcpServers!.gh).toEqual({ type: 'stdio', command: 'gh-platform', args: [], env: {} });
  });

  it('keeps an explicit strict / connectors choice', () => {
    const p = platform({ strictMcpConfig: true, claudeAiConnectors: true });
    resolvePlatformMcpPosture([p], undefined, () => false);
    expect(p.strictMcpConfig).toBe(true);
    expect(p.claudeAiConnectors).toBe(true);
  });

  it('downgrades strict with a warning when an enterprise managed MCP config is present', () => {
    const strict = platform({ id: 'a', strictMcpConfig: true });
    const lax = platform({ id: 'b' });
    const { warnings } = resolvePlatformMcpPosture([strict, lax], undefined, () => true);
    expect(strict.strictMcpConfig).toBe(false);
    expect(lax.strictMcpConfig).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('platforms[a].strictMcpConfig ignored');
    expect(warnings[0]).toContain('--strict-mcp-config');
  });

  it('does not probe for the managed file when no platform asks for strict', () => {
    let probed = 0;
    resolvePlatformMcpPosture([platform(), platform({ id: 'x' })], undefined, () => { probed++; return true; });
    expect(probed).toBe(0);
  });

  it('throws with the field path on a malformed server entry', () => {
    const p = platform({ id: 'mm', mcpServers: { bad: { arg: ['x'] } as never } });
    expect(() => resolvePlatformMcpPosture([p], undefined, () => false)).toThrow(/platforms\[mm\]\.mcpServers\.bad/);
  });

  it('warns and defaults on a non-boolean posture value instead of throwing', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const p = platform({ strictMcpConfig: 'yes' as never, claudeAiConnectors: 1 as never });
      resolvePlatformMcpPosture([p], undefined, () => false);
      expect(p.strictMcpConfig).toBe(false);
      expect(p.claudeAiConnectors).toBe(false);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});
