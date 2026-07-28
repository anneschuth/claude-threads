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

/**
 * Kind of external delivery the arbiter can hold the agent accountable for.
 * 'message' — post to another channel/person (send_dm, post_message, ...);
 * 'file' — send/upload a file (send_file, upload_file, ...).
 * Kinds, not concrete tool names: deployments carry different MCP servers
 * and any of their delivery tools must count as fulfillment.
 */
export type DeliveryKind = 'message' | 'file';

/** A single external-delivery obligation extracted from user messages */
export interface ArbiterObligation {
  /** Human-readable description, e.g. "reply to ~releases when the fix is ready" */
  description: string;
  /** Which kind of delivery fulfills this obligation */
  tool: DeliveryKind;
  /**
   * Lifecycle: open → fulfilled (a delivery tool completed successfully),
   * waived (after a reminder the agent credibly reported it delivered another
   * way or that delivery is impossible), or failed (gave up after reminders).
   */
  status: 'open' | 'fulfilled' | 'waived' | 'failed';
  /** How many arbiter reminders have been sent for this obligation */
  remindCount: number;
}

/** Verdict for the stall check on a turn's final message */
export type StallVerdict = 'continue' | 'wait_for_human' | 'done';

/**
 * What the session is blocked on while waiting for a human.
 * 'question' — an AskUserQuestion set with options to pick from;
 * 'approval' — a plan/action approval prompt (👍/👎);
 * 'text'     — the agent just ended its turn asking something in prose, with
 *              no interactive prompt to answer (only the agent can be nudged).
 */
export type WaitingKind = 'question' | 'approval' | 'text';

/**
 * A session parked waiting for a human.
 *
 * The arbiter used to stand down completely here — a genuine interactive
 * prompt "means a human should answer". In a channel nobody watches that is
 * the same as the task dying silently. So instead we time the wait: after
 * `waitTimeoutMs` either the arbiter answers on the human's behalf (when the
 * decision plainly doesn't need one) or it pings the humans so they know.
 */
export interface ArbiterWaitingState {
  kind: WaitingKind;
  /**
   * Identifies the specific prompt being waited on. A new prompt gets a new
   * signature and restarts the clock; a human answering makes the signature
   * disappear, which is how we notice we're no longer waiting.
   */
  signature: string;
  /**
   * The prompt text as it read when we started waiting. Kept here because a
   * 'text' wait has no live prompt to re-read later, and the arbiter's
   * `lastAssistantText` is consumed by the stall check on the same turn.
   */
  text: string;
  /**
   * session.messageCount when the wait was armed. Any change means a human
   * (or another agent) spoke, so the wait is over regardless of what the
   * pending-prompt state looks like.
   */
  messageCountAtArm: number;
  /** When the wait started (epoch ms). */
  since: number;
  /** Escalation pings already sent for this prompt. */
  escalations: number;
  /** True once the arbiter answered this prompt itself (don't do it twice). */
  autoAnswered: boolean;
  /**
   * True once the judge has ruled that this prompt genuinely needs a person.
   * The prompt and the task don't change between escalation pings, so
   * re-judging would just spend another Sonnet call on the same answer.
   */
  judgedNeedsHuman?: boolean;
  /** Pending timer (in-memory only). */
  timer?: ReturnType<typeof setTimeout>;
}

/** Arbiter state carried on the session (subset is persisted) */
export interface ArbiterSessionState {
  /** Extracted delivery obligations */
  obligations: ArbiterObligation[];
  /** Short names of delivery tools that COMPLETED successfully this session (e.g. 'send_dm') */
  deliveryToolCalls: string[];
  /** Total continuation nudges sent this session (capped) */
  continuationNudges: number;
  /** Last assistant text block of the current turn (in-memory only, for the stall check) */
  lastAssistantText?: string;
  /** In-flight guard so overlapping turn-complete checks don't double-ping */
  checking?: boolean;
  /**
   * Delivery tool calls awaiting their tool_result (tool_use_id → tool).
   * An obligation is only fulfilled when the result comes back without
   * is_error — a rejected/failed send_dm must NOT count as delivered.
   * In-memory only: a pending call can't survive a process restart anyway.
   */
  pendingDeliveryCalls: Map<string, DeliveryKind>;
  /**
   * Serialization chain for obligation extractions (in-memory only).
   * Extractions snapshot the ledger and write it back after an LLM round
   * trip; running them concurrently would let the last writer silently drop
   * obligations added by the other.
   */
  extractionChain?: Promise<void>;
  /**
   * Current human-wait, if the session is parked on a prompt.
   * In-memory only: the timer can't survive a restart, and after a restart
   * the next turn re-arms it from the (persisted) pending prompt anyway.
   */
  waiting?: ArbiterWaitingState;
}

/** Persisted subset of ArbiterSessionState (survives bot restarts) */
export interface PersistedArbiterState {
  obligations: ArbiterObligation[];
  deliveryToolCalls: string[];
  continuationNudges: number;
}

/** Normalize legacy persisted tool names ('send_dm'/'send_file') to kinds */
function normalizeKind(tool: string): DeliveryKind {
  if (tool === 'file' || tool === 'send_file') return 'file';
  return 'message';
}

export function createArbiterState(persisted?: PersistedArbiterState): ArbiterSessionState {
  return {
    obligations: (persisted?.obligations ?? []).map((o) => ({
      ...o,
      tool: normalizeKind(o.tool as string),
    })),
    deliveryToolCalls: (persisted?.deliveryToolCalls ?? []).map(normalizeKind),
    continuationNudges: persisted?.continuationNudges ?? 0,
    pendingDeliveryCalls: new Map(),
  };
}
