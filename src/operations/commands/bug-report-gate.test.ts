/**
 * `bugReports: false` has to remove the whole path, not just the command.
 *
 * `!bug` uploads attached screenshots to a public anonymous file host and
 * files session context plus recent daemon log lines as an issue on a public
 * repository. `claudeCanExecute: true` means the agent can trigger it with no
 * human typing anything, and a report card can already be pending from before
 * the switch was thrown. An operator who turns this off in a regulated
 * environment needs all of those closed.
 */
import { describe, it, expect, mock } from 'bun:test';
import * as commands from './handler.js';
import { createMockSessionContext } from '../../test-utils/mock-session-context.js';
import type { Session } from '../../session/types.js';
import type { PlatformClient } from '../../platform/index.js';
import { createMockFormatter } from '../../test-utils/mock-formatter.js';

function sessionWith() {
  const createPost = mock(async (content: string) => ({
    id: 'p1', platformId: 'test', channelId: 'c', message: content, createAt: 0, userId: 'bot',
  }));
  const setPendingBugReport = mock(() => {});
  const session = {
    sessionId: 'test-platform:thread-1',
    platformId: 'test-platform',
    threadId: 'thread-1',
    workingDir: process.cwd(),
    startedBy: 'alice',
    claudeSessionId: 'claude-session-1',
    startedAt: new Date(),
    platform: {
      createPost,
      createInteractivePost: mock(async (content: string) => ({
        id: 'preview-1', platformId: 'test', channelId: 'c', message: content, createAt: 0, userId: 'bot',
      })),
      getFormatter: () => createMockFormatter(),
    } as unknown as PlatformClient,
    messageManager: { setPendingBugReport, getPendingBugReport: () => null } as never,
  } as unknown as Session;
  return { session, createPost, setPendingBugReport };
}

function ctxWithBugReports(enabled: boolean) {
  const ctx = createMockSessionContext(() => ({ getFormatter: () => createMockFormatter() }) as unknown as PlatformClient);
  (ctx.config as { bugReportsEnabled: boolean }).bugReportsEnabled = enabled;
  return ctx;
}

describe('bugReports: false', () => {
  it('refuses !bug and never builds a report', async () => {
    const { session, createPost, setPendingBugReport } = sessionWith();

    await commands.reportBug(session, 'something broke', 'alice', ctxWithBugReports(false));

    // Nothing is uploaded and no approval card is left for someone to press.
    expect(setPendingBugReport).not.toHaveBeenCalled();
    const posted = createPost.mock.calls.map((c) => String(c[0])).join('\n');
    expect(posted.toLowerCase()).toContain('disabled');
  });

  it('refuses a report triggered by an error reaction, not just the typed command', async () => {
    // The 🐛 reaction path reaches the same function with an errorContext and
    // no description — it must not slip past a gate placed on the argument.
    const { session, setPendingBugReport } = sessionWith();

    await commands.reportBug(session, undefined, 'alice', ctxWithBugReports(false), {
      message: 'boom', stack: 'at x', timestamp: new Date().toISOString(),
    } as never);

    expect(setPendingBugReport).not.toHaveBeenCalled();
  });

  it('leaves the feature working when enabled, so the gate is what stops it', async () => {
    // The same call with the flag on reaches the end of the preview flow and
    // registers an approval card. Nothing is sent anywhere yet — the GitHub
    // issue is only created once a human approves that card.
    const { session, setPendingBugReport, createPost } = sessionWith();

    await commands.reportBug(session, 'something broke', 'alice', ctxWithBugReports(true));

    expect(setPendingBugReport).toHaveBeenCalled();
    const posted = createPost.mock.calls.map((c) => String(c[0])).join('\n');
    expect(posted.toLowerCase()).not.toContain('disabled');
  });
});
