/**
 * Arbiter types — session completion watchdog.
 *
 * The arbiter watches each turn's completion and intervenes in two cases:
 *
 * 1. Forgotten deliveries: the user asked for an external deliverable
 *    ("when done, reply to ~channel / DM @person / send the file") but the
 *    agent finished the turn without ever calling the delivery tool.
 *    Detection is deterministic (was the tool called or not).
 *
 * 2. Stalls: the agent ended its turn asking permission to continue
 *    ("should I keep looking?", "want me to proceed?") instead of doing the
 *    work. With nobody watching the thread, the task silently stops.
 *    Detection is a cheap LLM verdict over the turn's final message.
 */

/** Delivery tools the arbiter can hold the agent accountable for */
export type DeliveryTool = 'send_dm' | 'send_file';

/** A single external-delivery obligation extracted from user messages */
export interface ArbiterObligation {
  /** Human-readable description, e.g. "reply to ~releases when the fix is ready" */
  description: string;
  /** Which delivery tool fulfills this obligation */
  tool: DeliveryTool;
  /** Lifecycle: open → fulfilled (tool was called) or failed (gave up after reminders) */
  status: 'open' | 'fulfilled' | 'failed';
  /** How many arbiter reminders have been sent for this obligation */
  remindCount: number;
}

/** Verdict for the stall check on a turn's final message */
export type StallVerdict = 'continue' | 'wait_for_human' | 'done';

/** Arbiter state carried on the session (subset is persisted) */
export interface ArbiterSessionState {
  /** Extracted delivery obligations */
  obligations: ArbiterObligation[];
  /** Short names of delivery tools called during this session (e.g. 'send_dm') */
  deliveryToolCalls: string[];
  /** Total continuation nudges sent this session (capped) */
  continuationNudges: number;
  /** Last assistant text block of the current turn (in-memory only, for the stall check) */
  lastAssistantText?: string;
  /** In-flight guard so overlapping turn-complete checks don't double-ping */
  checking?: boolean;
}

/** Persisted subset of ArbiterSessionState (survives bot restarts) */
export interface PersistedArbiterState {
  obligations: ArbiterObligation[];
  deliveryToolCalls: string[];
  continuationNudges: number;
}

export function createArbiterState(persisted?: PersistedArbiterState): ArbiterSessionState {
  return {
    obligations: persisted?.obligations ?? [],
    deliveryToolCalls: persisted?.deliveryToolCalls ?? [],
    continuationNudges: persisted?.continuationNudges ?? 0,
  };
}
