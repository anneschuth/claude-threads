/**
 * Unit tests for the mock Claude CLI's pure pieces (arg parsing, scenario
 * loading). These run in the normal `bun test` pass — no platform needed —
 * and guard the contract the integration suites depend on.
 */
import { describe, it, expect } from 'bun:test';
import { parseArgs, loadScenario } from './runner.js';

describe('mock-claude parseArgs', () => {
  it('parses --session-id', () => {
    const args = parseArgs(['--session-id', 'abc-123']);
    expect(args.sessionId).toBe('abc-123');
    expect(args.resumed).toBe(false);
  });

  it('parses --resume as a resumed session with that id', () => {
    const args = parseArgs(['--resume', 'prev-456']);
    expect(args.sessionId).toBe('prev-456');
    expect(args.resumed).toBe(true);
  });

  it('generates a session id when none is given', () => {
    const args = parseArgs([]);
    expect(args.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('parses permission flags', () => {
    const bypass = parseArgs(['--dangerously-skip-permissions']);
    expect(bypass.bypassPermissions).toBe(true);

    const interactive = parseArgs([
      '--mcp-config', '/tmp/mcp.json',
      '--permission-prompt-tool', 'mcp__claude-threads-mcp__permission_prompt',
      '--permission-mode', 'auto',
    ]);
    expect(interactive.bypassPermissions).toBe(false);
    expect(interactive.mcpConfigRaw).toBe('/tmp/mcp.json');
    expect(interactive.permissionPromptTool).toBe('mcp__claude-threads-mcp__permission_prompt');
    expect(interactive.permissionMode).toBe('auto');
  });

  it('skips value-carrying flags without swallowing later args', () => {
    // --append-system-prompt takes a value; --session-id must still parse
    const args = parseArgs([
      '--append-system-prompt', 'some long system prompt',
      '--settings', '{"statusLine":{}}',
      '--model', 'claude-haiku-4-5-20251001',
      '--session-id', 'sid-789',
    ]);
    expect(args.sessionId).toBe('sid-789');
  });
});

describe('mock-claude loadScenario', () => {
  it('loads a real scenario with turns', () => {
    const scenario = loadScenario('task-list');
    expect(scenario.name).toBe('task-list');
    expect(Array.isArray(scenario.turns)).toBe(true);
    expect(scenario.turns.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to default for unknown scenarios', () => {
    const scenario = loadScenario('definitely-not-a-scenario');
    expect(scenario.name).toBe('default');
  });

  it('every checked-in scenario is valid v2 (turn-based)', async () => {
    const { readdirSync } = await import('fs');
    const { join, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'scenarios');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const name = file.replace(/\.json$/, '');
      const scenario = loadScenario(name);
      // A legacy (non-turn-based) scenario silently degrades to default —
      // that's exactly the drift this test exists to catch.
      expect(scenario.name).toBe(name);
      expect(Array.isArray(scenario.turns)).toBe(true);
      for (const turn of scenario.turns) {
        expect(Array.isArray(turn.steps)).toBe(true);
        expect(turn.steps.length).toBeGreaterThan(0);
      }
    }
  });
});
