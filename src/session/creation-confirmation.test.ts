/**
 * The agent-proposal approval gate in _handleCreationConfirmation: Claude's
 * propose_routine/propose_watch cards skip the owner gate `!routine`/`!watch`
 * apply at request time, so the SAVE must apply it at approval time — an
 * `!invite`d guest (session participant, not platform-allowlisted) passes
 * the reaction router but must not be able to stand up unattended work
 * running as the session owner.
 */

import { describe, test, expect, mock } from 'bun:test';
import { _handleCreationConfirmation, _resumedUnattended } from './lifecycle.js';
import type { PersistedSession } from '../persistence/session-store.js';
import type { Session } from './types.js';
import { createMockFormatter } from '../test-utils/mock-formatter.js';

function makeSession(opts: { allowed?: string[] } = {}): Session {
  const updates: string[] = [];
  const session = {
    platformId: 'mm',
    threadId: 'thread-1',
    sessionId: 'mm:thread-1',
    startedBy: 'anne',
    platform: {
      getFormatter: () => createMockFormatter(),
      isUserAllowed: (u: string) => (opts.allowed ?? ['anne']).includes(u),
      updatePost: mock(async (_id: string, content: string) => { updates.push(content); }),
    },
  } as unknown as Session;
  (session as unknown as { _updates: string[] })._updates = updates;
  return session;
}

function updatesOf(session: Session): string[] {
  return (session as unknown as { _updates: string[] })._updates;
}

function payload(overrides: Partial<{ approved: boolean; decidedBy: string; proposedByAgent: boolean }> = {}) {
  return {
    approved: true,
    parsed: { name: 'Daily standup' },
    requestedBy: 'anne',
    decidedBy: 'anne',
    postId: 'card-1',
    proposedByAgent: true,
    ...overrides,
  };
}

const flavor = (save: ReturnType<typeof mock>) => ({
  tool: 'routine',
  logPrefix: '🕘 Routine',
  fileNoun: 'routines',
  save: save as unknown as () => Promise<{ ok: true; name: string; position: number }>,
  savedText: () => 'saved',
});

describe('_handleCreationConfirmation — agent-proposal approval gate', () => {
  test("an !invite'd guest (not allowlisted) cannot approve an agent proposal", async () => {
    const session = makeSession({ allowed: ['anne'] });
    const save = mock(async () => ({ ok: true as const, name: 'Daily standup', position: 1 }));

    await _handleCreationConfirmation(session, payload({ decidedBy: 'guest' }), flavor(save));

    expect(save).not.toHaveBeenCalled();
    expect(updatesOf(session).join('\n')).toContain('nothing was saved');
  });

  test('the session owner and platform-allowlisted users can approve', async () => {
    for (const decidedBy of ['anne', 'bob']) {
      const session = makeSession({ allowed: ['anne', 'bob'] });
      const save = mock(async () => ({ ok: true as const, name: 'Daily standup', position: 1 }));
      await _handleCreationConfirmation(session, payload({ decidedBy }), flavor(save));
      expect(save).toHaveBeenCalledTimes(1);
    }
  });

  test('a guest 👎 (discard) needs no authorization — nothing is being saved', async () => {
    const session = makeSession({ allowed: ['anne'] });
    const save = mock(async () => ({ ok: true as const, name: 'Daily standup', position: 1 }));
    await _handleCreationConfirmation(session, payload({ decidedBy: 'guest', approved: false }), flavor(save));
    expect(save).not.toHaveBeenCalled();
    // No unauthorized-warning either: the discard stands.
    expect(updatesOf(session)).toHaveLength(0);
  });

  test('human-requested cards (!routine) keep their existing approval semantics', async () => {
    // The request was already owner-gated; any session-authorized reaction
    // decides, exactly as before this gate existed.
    const session = makeSession({ allowed: ['anne'] });
    const save = mock(async () => ({ ok: true as const, name: 'Daily standup', position: 1 }));
    await _handleCreationConfirmation(session, payload({ decidedBy: 'guest', proposedByAgent: false }), flavor(save));
    expect(save).toHaveBeenCalledTimes(1);
  });
});


describe('_resumedUnattended — upgrade fail-closed heuristic', () => {
  const base = { firstPrompt: undefined } as unknown as PersistedSession;

  test('an explicit persisted flag wins in both directions', () => {
    expect(_resumedUnattended({ ...base, unattended: true } as PersistedSession)).toBe(true);
    expect(_resumedUnattended({ ...base, unattended: false, firstPrompt: '[Watch "x" fired automatically: ...' } as PersistedSession)).toBe(false);
  });

  test('pre-upgrade routine/watch fires are recognized by their prompt prefix', () => {
    // Sessions persisted by a pre-agent-tools bot carry no flag; failing
    // open would hand the agent tools to exactly the sessions the gate
    // targets during the upgrade window.
    expect(_resumedUnattended({ ...base, firstPrompt: '[Scheduled routine "Daily standup" — started automatically on its schedule, not by a live user. ...]' } as PersistedSession)).toBe(true);
    expect(_resumedUnattended({ ...base, firstPrompt: '[Watch "Incident triage" fired automatically: a message ...' } as PersistedSession)).toBe(true);
    expect(_resumedUnattended({ ...base, firstPrompt: 'please fix the flaky test' } as PersistedSession)).toBe(false);
    expect(_resumedUnattended(base)).toBe(false);
  });
});
