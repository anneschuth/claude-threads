/**
 * A host held back by `engines` is not up to date, and `!update` must not say
 * it is: the operator would never learn why the bot stopped updating.
 */
import { describe, it, expect, mock } from 'bun:test';
import { showUpdateStatus, forceUpdateNow, type AutoUpdateManagerInterface } from './handler.js';
import { createMockSessionContext } from '../../test-utils/mock-session-context.js';
import { createMockFormatter } from '../../test-utils/mock-formatter.js';
import type { Session } from '../../session/types.js';
import type { PlatformClient } from '../../platform/index.js';

const blocked = { latestVersion: '2.0.0', reason: 'requires node >=24.0.0, this host runs 22.1.0' };

function setup(blockedUpdate: typeof blocked | null) {
  const createPost = mock(async (content: string) => ({
    id: 'p1', platformId: 'test', channelId: 'c', message: content, createAt: 0, userId: 'bot',
  }));
  const platform = { createPost, getFormatter: () => createMockFormatter() } as unknown as PlatformClient;
  const session = {
    sessionId: 'test-platform:thread-1',
    threadId: 'thread-1',
    startedBy: 'alice',
    sessionAllowedUsers: new Set(['alice']),
    platform,
  } as unknown as Session;
  const forceUpdate = mock(async () => {});
  const updateManager = {
    isEnabled: () => true,
    checkNow: async () => null,
    getBlockedUpdate: () => blockedUpdate,
    forceUpdate,
  } as unknown as AutoUpdateManagerInterface;
  const ctx = createMockSessionContext(() => platform);
  const posted = () => createPost.mock.calls.map((c) => String(c[0])).join('\n');
  return { session, updateManager, ctx, posted, forceUpdate };
}

describe('!update on a host held back by engines', () => {
  it('names the release and the reason instead of "Up to date"', async () => {
    const { session, updateManager, ctx, posted } = setup(blocked);

    await showUpdateStatus(session, updateManager, ctx);

    expect(posted()).toContain('2.0.0');
    expect(posted()).toContain(blocked.reason);
    expect(posted()).not.toContain('Up to date');
  });

  it('still says "Up to date" when nothing is held back', async () => {
    const { session, updateManager, ctx, posted } = setup(null);

    await showUpdateStatus(session, updateManager, ctx);

    expect(posted()).toContain('Up to date');
  });

  it('!update now explains the refusal and installs nothing', async () => {
    const { session, updateManager, posted, forceUpdate } = setup(blocked);

    await forceUpdateNow(session, 'alice', updateManager);

    expect(posted()).toContain(blocked.reason);
    expect(forceUpdate).not.toHaveBeenCalled();
  });
});
