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

describe('buildRestartCliOptions — DCM approvals scoping', () => {
  const deps = { chromeEnabled: false, permissionTimeoutMs: 120000, account: undefined };

  function dcmSession(approvals: 'owner' | 'all_users') {
    return makeSession({
      threadId: 'dcm:test-platform',
      sessionId: 'test-platform:dcm:test-platform',
      sessionAllowedUsers: new Set(['alice', 'invited']),
      platform: {
        getMcpConfig: () => ({
          type: 'mattermost',
          url: 'https://mm.test',
          token: 't',
          channelId: 'c',
          allowedUsers: ['alice', 'bob', 'carol'],
        }),
        directChannelMode: { enabled: true, respondTo: 'all_messages', approvals },
      },
    } as Record<string, unknown>);
  }

  it('owner mode scopes the MCP allowlist to session participants on respawn', () => {
    const opts = buildRestartCliOptions(dcmSession('owner'), deps as never);
    expect(opts.platformConfig!.allowedUsers!.sort()).toEqual(['alice', 'invited']);
  });

  it('all_users mode keeps the platform allowlist', () => {
    const opts = buildRestartCliOptions(dcmSession('all_users'), deps as never);
    expect(opts.platformConfig!.allowedUsers).toEqual(['alice', 'bob', 'carol']);
  });

  it('classic thread sessions are untouched', () => {
    const opts = buildRestartCliOptions(makeSession(), deps as never);
    expect(opts.platformConfig!.allowedUsers).toBeDefined();
  });
});
