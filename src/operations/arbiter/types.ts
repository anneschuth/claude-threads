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
