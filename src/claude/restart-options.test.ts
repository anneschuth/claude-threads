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
  const deps = {
    chromeEnabled: false,
    permissionTimeoutMs: 120000,
    account: undefined,
    ops: {
      getPlatformMemoryConfig: () => ({ enabled: true, repoLayer: true, channelLayer: true, distillation: true }),
      isRoutinesEnabled: () => true,
      isWatchesEnabled: () => true,
    },
  };

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

  it('carries the agent-feature gates, including the unattended flag (respawn parity)', () => {
    // A respawn (!cd, !permissions, worktrees) that dropped agentFeatures
    // would silently re-offer propose_* to an unattended session.
    const options = buildRestartCliOptions(makeSession({ unattended: true }), deps);
    expect(options.agentFeatures).toEqual({
      memoryChannel: true,
      routines: true,
      watches: true,
      unattended: true,
    });
  });
});

describe('buildRestartCliOptions — DCM approvals scoping', () => {
  const deps = {
    chromeEnabled: false,
    permissionTimeoutMs: 120000,
    account: undefined,
    ops: {
      getPlatformMemoryConfig: () => ({ enabled: true, repoLayer: true, channelLayer: true, distillation: true }),
      isRoutinesEnabled: () => true,
      isWatchesEnabled: () => true,
    },
  };

  function scopedSession(threadId: string, approvals?: 'owner' | 'all_users') {
    return makeSession({
      threadId,
      sessionId: `test-platform:${threadId}`,
      sessionAllowedUsers: new Set(['alice', 'invited']),
      platform: {
        getMcpConfig: () => ({
          type: 'mattermost',
          url: 'https://mm.test',
          token: 't',
          channelId: 'c',
          allowedUsers: ['alice', 'bob', 'carol'],
        }),
        directChannelMode: { enabled: threadId.startsWith('dcm:'), respondTo: 'all_messages' },
        approvals,
      },
    } as Record<string, unknown>);
  }

  it('DCM default (unset) scopes the MCP allowlist to session participants on respawn', () => {
    const opts = buildRestartCliOptions(scopedSession('dcm:test-platform'), deps as never);
    expect(opts.platformConfig!.allowedUsers!.sort()).toEqual(['alice', 'invited']);
  });

  it('explicit all_users keeps the platform allowlist in DCM', () => {
    const opts = buildRestartCliOptions(scopedSession('dcm:test-platform', 'all_users'), deps as never);
    expect(opts.platformConfig!.allowedUsers).toEqual(['alice', 'bob', 'carol']);
  });

  it('thread default (unset) keeps the platform allowlist — non-breaking', () => {
    const opts = buildRestartCliOptions(scopedSession('thread-1'), deps as never);
    expect(opts.platformConfig!.allowedUsers).toEqual(['alice', 'bob', 'carol']);
  });

  it('explicit owner scopes a classic thread session too', () => {
    const opts = buildRestartCliOptions(scopedSession('thread-1', 'owner'), deps as never);
    expect(opts.platformConfig!.allowedUsers!.sort()).toEqual(['alice', 'invited']);
  });
});
