/**
 * Shared mock SessionContext for unit tests. Extracted from
 * lifecycle.test.ts and commands/handler.test.ts, which carried
 * byte-identical 96-line copies.
 */

import { mock } from 'bun:test';
import type { Session } from '../session/types.js';
import type { SessionContext } from '../operations/session-context/index.js';

/**
 * The two source files' platform mocks genuinely differ (e.g. isUserAllowed
 * true vs false), so the platform stays injected — each test file passes its
 * own factory through a thin local wrapper.
 */
export function createMockSessionContext(makePlatform: () => import('../platform/index.js').PlatformClient, sessions: Map<string, Session> = new Map()): SessionContext {
  return {
    config: {
      workingDir: '/test',
      permissionMode: 'bypass',
      chromeEnabled: false,
      debug: false,
      maxSessions: 5,
    },
    state: {
      sessions,
      postIndex: new Map(),
      platforms: new Map([['test-platform', makePlatform()]]),
      sessionStore: {
        save: mock(() => {}),
        remove: mock(() => {}),
        getAll: mock(() => []),
        get: mock(() => null),
        cleanStale: mock(() => []),
        saveStickyPostId: mock(() => {}),
        getStickyPostId: mock(() => null),
        load: mock(() => new Map()),
        findByPostId: mock(() => undefined),
      } as unknown as SessionContext['state']['sessionStore'],
      githubEmailsStore: {
        get: mock(() => undefined),
        set: mock(() => {}),
        delete: mock(() => false),
      } as unknown as SessionContext['state']['githubEmailsStore'],
      memoryStore: {
        buildChannelMemoryBlock: mock(() => null),
        listChannelEntries: mock(() => []),
        addChannelEntries: mock(() => Promise.resolve({ added: [], duplicates: [], superseded: [] })),
        forgetChannelEntry: mock(() => Promise.resolve({ ok: false, reason: 'empty', matches: [] })),
        clearChannel: mock(() => Promise.resolve()),
        repoMemoryDir: mock(() => '/tmp/test-memory'),
      } as unknown as SessionContext['state']['memoryStore'],
      routinesStore: {
        list: mock(() => []),
        get: mock(() => undefined),
        add: mock(() => Promise.resolve({ ok: true, routine: {} })),
        update: mock(() => Promise.resolve(undefined)),
        remove: mock(() => Promise.resolve(undefined)),
      } as unknown as SessionContext['state']['routinesStore'],
      watchesStore: {
        list: mock(() => []),
        get: mock(() => undefined),
        add: mock(() => Promise.resolve({ ok: true, watch: {} })),
        update: mock(() => Promise.resolve(undefined)),
        remove: mock(() => Promise.resolve(undefined)),
      } as unknown as SessionContext['state']['watchesStore'],
      isShuttingDown: false,
    },
    ops: {
      getSessionId: mock((platformId, threadId) => `${platformId}:${threadId}`),
      findSessionByThreadId: mock((threadId) => sessions.get(`test-platform:${threadId}`)),
      registerPost: mock(() => {}),
      handleEvent: mock(() => {}),
      handleExit: mock(() => Promise.resolve()),
      startTyping: mock(() => {}),
      stopTyping: mock(() => {}),
      flush: mock(() => Promise.resolve()),
      updateStickyMessage: mock(() => Promise.resolve()),
      updateSessionHeader: mock(() => Promise.resolve()),
      persistSession: mock(() => {}),
      unpersistSession: mock(() => {}),
      recordSessionStarted: mock(() => {}),
      shouldPromptForWorktree: mock(() => Promise.resolve(null)),
      postWorktreePrompt: mock(() => Promise.resolve()),
      buildMessageContent: mock((prompt: string) => Promise.resolve({ content: prompt, skipped: [] })),
      offerContextPrompt: mock(() => Promise.resolve(false)),
      killSession: mock(() => Promise.resolve()),
      emitSessionAdd: mock(() => {}),
      emitSessionUpdate: mock(() => {}),
      emitSessionRemove: mock(() => {}),
      registerWorktreeUser: mock(() => {}),
      unregisterWorktreeUser: mock(() => {}),
      hasOtherSessionsUsingWorktree: mock(() => false),
      switchToWorktree: mock(async () => {}),
      forceUpdate: mock(async () => {}),
      deferUpdate: mock(() => {}),
      handleBugReportApproval: mock(async () => {}),
      acquireClaudeAccount: mock(() => null),
      getClaudeAccount: mock(() => undefined),
      releaseClaudeAccount: mock(() => {}),
      refreshClaudeAccountUsage: mock(async () => {}),
      markClaudeAccountCooling: mock(() => {}),
      getClaudeAccountPoolStatus: mock(() => []),
      getPlatformOverhead: mock(() => ({ sessionHeader: 'full' as const, stickyMessage: 'full' as const })),
      getPlatformMemoryConfig: mock(() => ({ enabled: false, repoLayer: false, channelLayer: false, distillation: false })),
      isRoutinesEnabled: mock(() => true),
      isWatchesEnabled: mock(() => true),
      fireRoutineNow: mock(() => Promise.resolve('ok' as const)),
    },
  };
}
