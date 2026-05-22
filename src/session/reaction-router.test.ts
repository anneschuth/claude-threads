/**
 * Tests for ReactionRouter — the reaction dispatch module extracted from
 * `SessionManager` in PR 4.
 *
 * Focus:
 * - Security gate (unauthorized users never reach dispatch).
 * - Dispatch priority (session-level reactions checked before
 *   MessageManager delegation).
 * - Emoji normalization (`thumbsup` vs `+1`).
 * - Same-platform check (reaction from a different platform dropped).
 *
 * These are integration-shaped (the router is plumbed to real deps via a
 * lightweight fake), not unit tests — the point is to pin the contract
 * that `handleReaction` presents to platform clients.
 */

import { describe, test, expect, mock } from 'bun:test';
import { handleReaction, type ReactionRouterDeps } from './reaction-router.js';
import type { Session } from './types.js';
import type { PlatformClient } from '../platform/index.js';
import type { SessionRegistry } from './registry.js';
import type { SessionStore } from '../persistence/session-store.js';
import type { ResolvedLimits } from '../config/index.js';
import type { SessionContext } from '../operations/session-context/index.js';
import type { ContextPromptHandler } from '../operations/context-prompt/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    platformId: 'test',
    threadId: 't1',
    sessionId: 'test:t1',
    startedBy: 'alice',
    sessionAllowedUsers: new Set(['alice']),
    sessionStartPostId: null,
    worktreePromptPostId: undefined,
    pendingWorktreeSuggestions: undefined,
    lastError: undefined,
    platform: {
      isUserAllowed: mock(() => false),
    } as unknown as PlatformClient,
    messageManager: {
      handleReaction: mock(() => Promise.resolve(false)),
    } as any,
    ...overrides,
  } as unknown as Session;
}

function makeDeps(
  session: Session | null,
  overrides: Partial<ReactionRouterDeps> = {},
): ReactionRouterDeps {
  const registry: Partial<SessionRegistry> = {
    findByPost: mock(() => session ?? undefined),
    hasById: mock(() => false),
    get size() { return 0; },
  };
  const sessionStore: Partial<SessionStore> = {
    findByPostId: mock(() => undefined),
  };
  return {
    registry: registry as SessionRegistry,
    sessionStore: sessionStore as SessionStore,
    platforms: new Map(),
    limits: { maxSessions: 5 } as ResolvedLimits,
    getContext: () => ({} as SessionContext),
    getContextPromptHandler: () => ({} as ContextPromptHandler),
    persistSession: mock(() => {}),
    createAndSwitchToWorktree: mock(() => Promise.resolve()),
    ...overrides,
  };
}

describe('ReactionRouter.handleReaction', () => {
  describe('no session', () => {
    test('is a no-op when no session matches the post', async () => {
      const deps = makeDeps(null);
      // Non-resume emoji on unknown post: no crash, no dispatch.
      await expect(
        handleReaction(deps, 'test', 'unknown-post', 'x', 'alice', 'added'),
      ).resolves.toBeUndefined();
      expect(deps.registry.findByPost).toHaveBeenCalledWith('unknown-post');
    });

    test('checks the persistence store when the emoji is a resume emoji', async () => {
      const deps = makeDeps(null);
      // 🔄 (arrows_counterclockwise) is the resume emoji — the router must
      // probe the session store to see if a timed-out session can be revived.
      await handleReaction(deps, 'test', 'any-post', 'arrows_counterclockwise', 'alice', 'added');
      expect(deps.sessionStore.findByPostId).toHaveBeenCalled();
    });
  });

  describe('security gate', () => {
    test('drops reactions from users not in sessionAllowedUsers nor platform allowlist', async () => {
      const session = makeSession();
      const deps = makeDeps(session);
      await handleReaction(deps, 'test', 'any', 'x', 'mallory', 'added');
      // MessageManager must not have been consulted.
      expect(session.messageManager!.handleReaction).not.toHaveBeenCalled();
    });

    test('allows users in sessionAllowedUsers through to dispatch', async () => {
      const session = makeSession();
      const deps = makeDeps(session);
      await handleReaction(deps, 'test', 'any', 'x', 'alice', 'added');
      // MessageManager IS consulted for unknown postId — no session-level
      // handler matched so the reaction falls through.
      expect(session.messageManager!.handleReaction).toHaveBeenCalled();
    });

    test('allows users permitted by the platform allowlist even if not session-local', async () => {
      // Session allowlist is `{alice}` (from the default fixture) and does
      // NOT contain `bob`. Only the platform's `isUserAllowed` returning
      // true can open the gate — if the router ever stopped consulting it,
      // `bob` would be dropped and `handleReaction` would never be called.
      const isUserAllowed = mock((user: string) => user === 'bob');
      const session = makeSession({
        platform: { isUserAllowed } as unknown as PlatformClient,
      });
      const deps = makeDeps(session);
      await handleReaction(deps, 'test', 'any', 'x', 'bob', 'added');
      expect(isUserAllowed).toHaveBeenCalledWith('bob');
      expect(session.messageManager!.handleReaction).toHaveBeenCalled();
    });
  });

  describe('resume-from-reaction authorization (#388)', () => {
    // A timed-out session lives only in the persistence store. The resume
    // path can't use the live session's allowlist, so it authorizes against
    // the persisted sessionAllowedUsers + the platform allowlist via the same
    // isAuthorizedForSession helper as the lifecycle sinks. These tests guard
    // that an unauthorized user reacting 🔄 cannot revive someone's session.
    function persistedFixture() {
      return {
        threadId: 'thread-paused',
        platformId: 'test',
        sessionAllowedUsers: ['alice'],
        startedBy: 'alice',
      };
    }

    test('rejects an unauthorized resumer with a not-authorized post', async () => {
      const createPost = mock(() => Promise.resolve({ id: 'p' }));
      const platform = {
        isUserAllowed: mock((u: string) => u === 'alice'),
        createPost,
      } as unknown as PlatformClient;
      const deps = makeDeps(null, {
        sessionStore: {
          findByPostId: mock(() => persistedFixture()),
        } as unknown as SessionStore,
        platforms: new Map([['test', platform]]),
      });

      await handleReaction(deps, 'test', 'header-post', 'arrows_counterclockwise', 'mallory', 'added');

      // mallory is in neither the persisted session allowlist nor the platform
      // allowlist, so the resume is refused and the rejection is posted.
      expect(createPost).toHaveBeenCalledWith(
        expect.stringContaining('not authorized'),
        'thread-paused',
      );
    });

    test('lets the session owner past the resume gate (no rejection post)', async () => {
      const createPost = mock((_message: string, _threadId: string) => Promise.resolve({ id: 'p' }));
      const platform = {
        isUserAllowed: mock((u: string) => u === 'alice'),
        createPost,
        getFormatter: mock(() => ({ formatBold: (s: string) => s })),
      } as unknown as PlatformClient;
      // registry.size >= maxSessions would trip the capacity guard; keep it 0.
      const deps = makeDeps(null, {
        sessionStore: {
          findByPostId: mock(() => persistedFixture()),
        } as unknown as SessionStore,
        platforms: new Map([['test', platform]]),
      });

      await handleReaction(deps, 'test', 'header-post', 'arrows_counterclockwise', 'alice', 'added');

      // alice owns the session: the gate must not post a not-authorized message.
      const postedNotAuthorized = createPost.mock.calls.some(
        (call) => typeof call[0] === 'string' && call[0].includes('not authorized'),
      );
      expect(postedNotAuthorized).toBe(false);
    });
  });

  describe('cross-platform isolation', () => {
    test('ignores a reaction from a different platform than the session', async () => {
      const session = makeSession({ platformId: 'mattermost' });
      const deps = makeDeps(session);
      await handleReaction(deps, 'slack', 'any', 'x', 'alice', 'added');
      // Even though alice is allowed, the platform mismatch drops it before
      // dispatch.
      expect(session.messageManager!.handleReaction).not.toHaveBeenCalled();
    });
  });

  describe('emoji normalization', () => {
    test('normalizes thumbsup to +1 before dispatch', async () => {
      const session = makeSession();
      const deps = makeDeps(session);
      await handleReaction(deps, 'test', 'any', 'thumbsup', 'alice', 'added');
      // MessageManager receives the normalized form — this is what executors
      // depend on for consistent emoji matching across platforms.
      expect(session.messageManager!.handleReaction).toHaveBeenCalledWith(
        'any',
        '+1',
        'alice',
        'added',
      );
    });
  });

  describe('MessageManager fallthrough', () => {
    test('skips MessageManager if the session has none (edge case)', async () => {
      const session = makeSession({ messageManager: undefined });
      const deps = makeDeps(session);
      // Should not throw.
      await expect(
        handleReaction(deps, 'test', 'any', 'x', 'alice', 'added'),
      ).resolves.toBeUndefined();
    });
  });
});
