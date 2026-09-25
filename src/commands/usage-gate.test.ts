/**
 * `!usage` spawns a `claude` subprocess per pooled seat and reports the pool's
 * account ids, plan badges and (optionally) emails. The first-message and
 * paused paths gate on the platform allowlist before dispatch, but the
 * in-session path does not — so the handler has to gate itself.
 * Maintainer review on #544.
 */
import { describe, it, expect, mock } from 'bun:test';
import { executeCommand } from './executor.js';
import type { CommandExecutorContext } from './types.js';

function ctxWith(isAllowed: boolean | undefined) {
  const createPost = mock(async () => ({ id: 'p1' }));
  const getClaudeAccounts = mock(() => [{ id: 'seat-a', home: '/nonexistent/a' }]);
  return {
    ctx: {
      commandContext: 'in-session',
      threadId: 'thread-1',
      username: 'stranger',
      isAllowed,
      client: { platformId: 'test', createPost } as never,
      sessionManager: {
        getClaudeAccounts,
        getUsageShowEmails: () => false,
        getPersistedSession: () => undefined,
      } as never,
      formatter: {} as never,
    } as CommandExecutorContext,
    createPost,
    getClaudeAccounts,
  };
}

describe('!usage authorization', () => {
  it('does not probe or report for a user outside the allowlist', async () => {
    const { ctx, createPost, getClaudeAccounts } = ctxWith(false);

    const result = await executeCommand('usage', undefined, ctx);

    // Handled — the command is consumed, not passed to Claude as a prompt —
    // but nothing is spawned and no pool internals reach the channel.
    expect(result.handled).toBe(true);
    expect(getClaudeAccounts).not.toHaveBeenCalled();
    expect(createPost).not.toHaveBeenCalled();
  });

  it('does not probe for `!usage all` either, which is the expensive form', async () => {
    const { ctx, getClaudeAccounts, createPost } = ctxWith(false);

    await executeCommand('usage', 'all', ctx);

    expect(getClaudeAccounts).not.toHaveBeenCalled();
    expect(createPost).not.toHaveBeenCalled();
  });

  it('answers a session invitee, who is authorized in this thread', async () => {
    // `ctx.isAllowed` on the in-session path is isUserAllowedInSession(): the
    // platform allowlist OR someone the owner invited. Pinned because the two
    // readings differ and the docs have to say which one this is (Codex).
    const { ctx, getClaudeAccounts } = ctxWith(true);

    await executeCommand('usage', undefined, ctx);

    expect(getClaudeAccounts).toHaveBeenCalled();
  });

  it('still answers an allowed user', async () => {
    const { ctx, getClaudeAccounts } = ctxWith(true);

    await executeCommand('usage', undefined, ctx);

    expect(getClaudeAccounts).toHaveBeenCalled();
  });
});
