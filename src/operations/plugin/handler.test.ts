/**
 * Smoke tests for plugin command handlers.
 *
 * Mocks `crossSpawn` so the handler's exit-code branching and messaging are
 * exercised without spawning real subprocesses. We deliberately avoid mocking
 * `../commands/index.js` because that module transitively pulls in
 * `../../claude/cli.js`, whose module identity matters for
 * `commands/restart-rebind.test.ts` running in the same process.
 *
 * As a result:
 *   - handlePluginList is tested fully.
 *   - handlePluginInstall / handlePluginUninstall are tested only for their
 *     "subprocess failed, posts error, never reaches restart" branch. The
 *     successful restart path is covered by integration tests.
 */

import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';
import { EventEmitter } from 'events';

// -----------------------------------------------------------------------------
// Subprocess mock — shared by all plugin invocations.
// -----------------------------------------------------------------------------

interface FakeSubprocessOpts {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  emitError?: boolean;
}

const crossSpawnCfg: { current: FakeSubprocessOpts } = { current: { exitCode: 0 } };

function makeFakeProc(opts: FakeSubprocessOpts) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  setImmediate(() => {
    if (opts.stdout) proc.stdout.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) proc.stderr.emit('data', Buffer.from(opts.stderr));
    if (opts.emitError) {
      proc.emit('error', new Error('spawn boom'));
    }
    proc.emit('close', opts.exitCode ?? 0);
  });
  return proc;
}

const crossSpawnMock = mock(() => makeFakeProc(crossSpawnCfg.current));
const realSpawn = await import('../../utils/spawn.js');
mock.module('../../utils/spawn.js', () => ({
  ...realSpawn,
  crossSpawn: crossSpawnMock,
}));

// bun's `mock.module` is process-global and one-way — there is no native
// "unmock". The best we can do is overwrite it with a pass-through factory
// that returns the real module, so later test files loading this path behave
// as if it were never mocked. This is NOT a true restore; it works only
// because `realSpawn` is still the real live module object.
afterAll(() => {
  mock.module('../../utils/spawn.js', () => realSpawn);
});

// Import AFTER mock.module
const { handlePluginList, handlePluginInstall, handlePluginUninstall } = await import('./handler.js');
import type { Session } from '../../session/types.js';
import type { SessionContext } from '../session-context/index.js';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

interface SessionSpies {
  createdMessages: string[];
}

function makeSession(spies: SessionSpies): Session {
  return {
    sessionId: 'mm:thread-1',
    threadId: 'thread-1',
    claudeSessionId: 'uuid-1',
    workingDir: '/tmp/proj',
    platformId: 'mm',
    startedBy: 'alice',
    startedAt: new Date(),
    lastActivityAt: new Date(),
    sessionNumber: 1,
    planApproved: false,
    sessionAllowedUsers: new Set(['alice']),
    forceInteractivePermissions: false,
    sessionStartPostId: null,
    timers: { timeoutTimer: null, warningTimer: null, cleanupTimer: null } as unknown as Session['timers'],
    lifecycle: { state: 'active' } as unknown as Session['lifecycle'],
    timeoutWarningPosted: false,
    messageCount: 0,
    platform: {
      platformId: 'mm',
      createPost: mock(async (message: string) => {
        spies.createdMessages.push(message);
        return { id: `post-${spies.createdMessages.length}`, message, userId: 'bot' };
      }),
      addReaction: mock(async () => undefined),
      getFormatter: () => ({
        formatBold: (t: string) => `**${t}**`,
        formatCode: (t: string) => `\`${t}\``,
        formatCodeBlock: (t: string) => `\`\`\`\n${t}\n\`\`\``,
      }),
      getMcpConfig: () => ({ type: 'mattermost', url: 'x', token: 'y', channelId: 'c', allowedUsers: [] }),
    } as unknown as Session['platform'],
    claude: {} as unknown as Session['claude'],
    threadLogger: {
      logCommand: mock(() => undefined),
    } as unknown as Session['threadLogger'],
  } as unknown as Session;
}

function makeCtx(): SessionContext {
  return {
    config: {
      skipPermissions: false,
      chromeEnabled: false,
      permissionTimeoutMs: 120_000,
    },
  } as unknown as SessionContext;
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('handlePluginList', () => {
  let spies: SessionSpies;
  beforeEach(() => {
    spies = { createdMessages: [] };
    crossSpawnCfg.current = { exitCode: 0, stdout: 'my-plugin 1.0.0\n' };
  });

  it('posts info and plugin list on success', async () => {
    await handlePluginList(makeSession(spies));
    const all = spies.createdMessages.join('\n');
    expect(all).toContain('Installed plugins');
    expect(all).toContain('my-plugin 1.0.0');
  });

  it('shows "No plugins installed" when stdout is empty', async () => {
    crossSpawnCfg.current = { exitCode: 0, stdout: '' };
    await handlePluginList(makeSession(spies));
    expect(spies.createdMessages.join('\n')).toContain('No plugins installed');
  });

  it('posts error when exit code is non-zero', async () => {
    crossSpawnCfg.current = { exitCode: 2, stderr: 'permission denied' };
    await handlePluginList(makeSession(spies));
    const all = spies.createdMessages.join('\n');
    expect(all).toContain('Failed to list plugins');
    expect(all).toContain('permission denied');
  });

  it('invokes claude plugin list via crossSpawn', async () => {
    crossSpawnMock.mockClear();
    await handlePluginList(makeSession(spies));
    expect(crossSpawnMock).toHaveBeenCalled();
    const call = crossSpawnMock.mock.calls[0] as unknown as [string, string[]];
    expect(call[1]).toEqual(['plugin', 'list']);
  });
});

describe('handlePluginInstall (failure branch only)', () => {
  // The success branch calls restartClaudeSession which pulls in the real
  // Claude CLI module — covered by integration tests, skipped here.
  let spies: SessionSpies;
  beforeEach(() => {
    spies = { createdMessages: [] };
  });

  it('posts error when subprocess fails', async () => {
    crossSpawnCfg.current = { exitCode: 1, stderr: 'no such plugin' };
    await handlePluginInstall(makeSession(spies), 'ghost-plugin', 'alice', makeCtx());
    const all = spies.createdMessages.join('\n');
    expect(all).toContain('Failed to install plugin');
    expect(all).toContain('no such plugin');
  });

  it('posts initial "Installing..." message before running subprocess', async () => {
    crossSpawnCfg.current = { exitCode: 1, stderr: 'fail' };
    await handlePluginInstall(makeSession(spies), 'x', 'alice', makeCtx());
    expect(spies.createdMessages[0]).toContain('Installing plugin');
  });

  it('passes plugin name as subprocess arg', async () => {
    crossSpawnCfg.current = { exitCode: 1, stderr: 'fail' };
    crossSpawnMock.mockClear();
    await handlePluginInstall(makeSession(spies), 'hello-plugin', 'alice', makeCtx());
    const call = crossSpawnMock.mock.calls[0] as unknown as [string, string[]];
    expect(call[1]).toEqual(['plugin', 'install', 'hello-plugin']);
  });
});

describe('handlePluginUninstall (failure branch only)', () => {
  let spies: SessionSpies;
  beforeEach(() => {
    spies = { createdMessages: [] };
  });

  it('posts error when subprocess fails', async () => {
    crossSpawnCfg.current = { exitCode: 1, stderr: 'not installed' };
    await handlePluginUninstall(makeSession(spies), 'ghost-plugin', 'alice', makeCtx());
    expect(spies.createdMessages.join('\n')).toContain('Failed to uninstall plugin');
  });

  it('handles subprocess error event gracefully', async () => {
    crossSpawnCfg.current = { emitError: true, exitCode: 1 };
    await handlePluginUninstall(makeSession(spies), 'my-plugin', 'alice', makeCtx());
    expect(spies.createdMessages.join('\n')).toContain('Failed to uninstall plugin');
  });

  it('passes plugin name as subprocess arg', async () => {
    crossSpawnCfg.current = { exitCode: 1, stderr: 'fail' };
    crossSpawnMock.mockClear();
    await handlePluginUninstall(makeSession(spies), 'bye-plugin', 'alice', makeCtx());
    const call = crossSpawnMock.mock.calls[0] as unknown as [string, string[]];
    expect(call[1]).toEqual(['plugin', 'uninstall', 'bye-plugin']);
  });
});
