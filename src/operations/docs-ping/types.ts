/**
 * Docs-ping types — telling the docs bot about a change, from code.
 *
 * The prompt-based version of this rule had the same flaw as the cross-bot
 * thread protocol: an agent forty minutes deep in a task forgets the last
 * step. So the bot owns it instead.
 *
 * Unlike the return address, though, the payload is not a fact sitting in the
 * incoming message — "does this change need docs?" is a judgement. So the
 * split is: code owns the trigger and the delivery, an out-of-band judge owns
 * the yes/no. Nothing here depends on the agent remembering anything.
 */

/** Docs-ping state carried on the session (a subset is persisted). */
export interface DocsPingState {
  /** True once a ping was sent (or deliberately skipped) — one per session. */
  settled: boolean;
  /**
   * True when the agent posted to the docs channel itself. Then we stay out
   * of the way rather than sending a near-duplicate.
   */
  agentPinged: boolean;
  /**
   * Docs-channel posts awaiting their tool_result (tool_use_id → true).
   * A rejected post must not count as the agent having handled it.
   * In-memory only.
   */
  pendingAgentPings: Map<string, true>;
  /** Quiescence debounce timer (in-memory only). */
  timer?: ReturnType<typeof setTimeout>;
}

/** Persisted subset — survives restarts so a resumed session doesn't re-ping. */
export interface PersistedDocsPingState {
  settled: boolean;
}

export function createDocsPingState(persisted?: PersistedDocsPingState): DocsPingState {
  return {
    settled: persisted?.settled ?? false,
    agentPinged: false,
    pendingAgentPings: new Map(),
  };
}

/** What the judge decided about a finished change. */
export interface DocsVerdict {
  needsDocs: boolean;
  /** One or two sentences: what changed, in the requester's language. */
  summary: string;
  /** What specifically to look at in the docs. Empty when needsDocs is false. */
  whatToCheck: string;
}
