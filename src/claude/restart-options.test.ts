/**
 * Tests for buildRestartCliOptions — the option set carried across Claude
 * respawns (!cd, !permissions interactive, worktree switches).
 */

import { describe, it, expect } from 'bun:test';
import { buildRestartCliOptions } from './restart-options.js';
import type { Session } from '../session/types.js';

function makeSession(overrides: Record<string, unknown> = {}): Session {
  return {
    sessionId: 'test-platform:thread-1',
    platformId: 'test-platform',
    threadId: 'thread-1',
    startedBy: 'alice',
    platform: {
      getMcpConfig: () => ({
        type: 'mattermost',
        url: 'https://chat.example.com',
        token: 't',
        channelId: 'c',
        allowedUsers: ['alice'],
      }),
    },
    ...overrides,
  } as unknown as Session;
}

describe('buildRestartCliOptions', () => {
  const deps = { chromeEnabled: false, permissionTimeoutMs: 120000, account: undefined };

  it('carries the decision-bridge path across respawns', () => {
    // The bridge is session-scoped: losing its path on !cd/!permissions
    // would silently resurrect the competing-prompts bug after a restart.
    const session = makeSession({
      decisionBridge: { path: '/tmp/bridge-1.sock' },
    });
    const options = buildRestartCliOptions(session, deps);
    expect(options.decisionBridgePath).toBe('/tmp/bridge-1.sock');
  });

  it('leaves the bridge path undefined when the session has no bridge', () => {
    const options = buildRestartCliOptions(makeSession(), deps);
    expect(options.decisionBridgePath).toBeUndefined();
  });
});
