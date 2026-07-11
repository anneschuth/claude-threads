import { describe, it, expect } from 'bun:test';
import { createAgentBackend } from './factory.js';
import { ClaudeCli } from '../claude/cli.js';
import { CodexCli } from './codex/cli.js';
import type { AgentBackendOptions } from './types.js';

describe('createAgentBackend', () => {
  const baseOptions = {
    workingDir: '/tmp',
    skipPermissions: true,
  };

  it('creates a ClaudeCli for agentType claude', () => {
    const backend = createAgentBackend({ ...baseOptions, agentType: 'claude' });
    expect(backend).toBeInstanceOf(ClaudeCli);
    expect(backend.agentType).toBe('claude');
  });

  it('creates a CodexCli for agentType codex', () => {
    const backend = createAgentBackend({ ...baseOptions, agentType: 'codex' });
    expect(backend).toBeInstanceOf(CodexCli);
    expect(backend.agentType).toBe('codex');
  });

  it('throws for unknown agent types', () => {
    const options = { ...baseOptions, agentType: 'gemini' } as unknown as AgentBackendOptions;
    expect(() => createAgentBackend(options)).toThrow('Unknown agent type: gemini');
  });
});
