/**
 * Factory for creating agent backends.
 *
 * All places that spawn (or respawn) an agent CLI go through this factory
 * so that per-session agent selection works uniformly.
 */

import { ClaudeCli } from '../claude/cli.js';
import { CodexCli } from './codex/cli.js';
import type { AgentBackend, AgentBackendOptions } from './types.js';

export function createAgentBackend(options: AgentBackendOptions): AgentBackend {
  switch (options.agentType) {
    case 'claude':
      return new ClaudeCli(options);
    case 'codex':
      return new CodexCli(options);
    default: {
      const exhaustive: never = options.agentType;
      throw new Error(`Unknown agent type: ${String(exhaustive)}`);
    }
  }
}
