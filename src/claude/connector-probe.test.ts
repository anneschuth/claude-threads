import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseConnectorNames, probeClaudeAiConnectors } from './connector-probe.js';

const init = (servers: Array<{ name: string; status?: string }>) =>
  JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: servers });

describe('parseConnectorNames', () => {
  test('returns connector names without the prefix, keeping other servers out', () => {
    const out = parseConnectorNames(
      init([{ name: 'claude-threads-mcp', status: 'connected' }, { name: 'claude.ai Gmail', status: 'connected' }, { name: 'claude.ai Google Drive', status: 'pending' }]) +
      '\n' + JSON.stringify({ type: 'result', subtype: 'success' }) + '\n',
    );
    expect(out).toEqual(['Gmail', 'Google Drive']);
  });

  test('returns an empty list for an init without connectors, null without an init', () => {
    expect(parseConnectorNames(init([{ name: 'claude-threads-mcp' }]))).toEqual([]);
    expect(parseConnectorNames('')).toBeNull();
    expect(parseConnectorNames('not json\n' + JSON.stringify({ type: 'result' }))).toBeNull();
  });
});

describe('probeClaudeAiConnectors', () => {
  test('runs the CLI with the connectors enabled and reads them from system/init', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-connector-probe-'));
    const stub = join(dir, 'fake-claude');
    // Echo the env var into a server name so the test can see the probe did
    // not disable the connectors it is looking for; then linger like a real
    // CLI would, to prove the probe resolves on the init line.
    writeFileSync(
      stub,
      `#!/usr/bin/env bash\nprintf '%s\\n' '{"type":"system","subtype":"init","mcp_servers":[{"name":"claude.ai Gmail"},{"name":"claude.ai flag='"\${ENABLE_CLAUDEAI_MCP_SERVERS:-unset}"'"}]}'\nsleep 5\n`,
      { mode: 0o755 },
    );
    chmodSync(stub, 0o755);
    const prevPath = process.env.CLAUDE_PATH;
    const prevFlag = process.env.ENABLE_CLAUDEAI_MCP_SERVERS;
    process.env.CLAUDE_PATH = stub;
    process.env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
    try {
      const started = Date.now();
      const names = await probeClaudeAiConnectors(undefined, { timeoutMs: 10_000 });
      expect(names).toEqual(['Gmail', 'flag=false']);
      expect(Date.now() - started).toBeLessThan(4000); // resolved on init, not on exit
    } finally {
      if (prevPath === undefined) delete process.env.CLAUDE_PATH; else process.env.CLAUDE_PATH = prevPath;
      if (prevFlag === undefined) delete process.env.ENABLE_CLAUDEAI_MCP_SERVERS; else process.env.ENABLE_CLAUDEAI_MCP_SERVERS = prevFlag;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resolves null when the CLI produces no init event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-connector-probe-'));
    const stub = join(dir, 'fake-claude');
    writeFileSync(stub, `#!/usr/bin/env bash\necho nope\nexit 1\n`, { mode: 0o755 });
    chmodSync(stub, 0o755);
    const prevPath = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = stub;
    try {
      expect(await probeClaudeAiConnectors(undefined, { timeoutMs: 5000 })).toBeNull();
    } finally {
      if (prevPath === undefined) delete process.env.CLAUDE_PATH; else process.env.CLAUDE_PATH = prevPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
