/**
 * Return-address types — guaranteed delivery back to the requester's thread.
 *
 * Cross-agent handoffs carry a permalink ("отвечай мне в тред: <url>" /
 * "reply to me in the thread: <url>"). Delivering there is a tool call, but
 * an agent that spends 40 minutes reviewing code reliably forgets to make it —
 * and a reply written as ordinary text lands only in the agent's OWN thread,
 * where the requester never sees it. The collaboration loop silently breaks.
 *
 * So the bot stops asking the agent and does it itself: the address is parsed
 * off the incoming message, stored on the session, and once the session goes
 * quiet the bot posts the turn's final text there. The agent's own delivery
 * still counts — if it remembered, the bot stays out of the way.
 */

import type { DeliveryTarget } from '../../platform/types.js';

export type { DeliveryTarget };

/** A resolved reply-to address extracted from an incoming message. */
export interface ReturnAddress {
  target: DeliveryTarget;
  /** Username that asked to be replied to (the post's author). */
  requester: string;
  /** The original permalink, kept for logs and the delivered message. */
  permalink: string;
}

/**
 * Return-delivery state carried on the session (a subset is persisted).
 */
export interface ReturnDeliveryState {
  /** Current address, if the session was handed a reply-to permalink. */
  address?: ReturnAddress;
  /**
   * Full final assistant text of the most recently completed turn. This is
   * what gets delivered — the requester asked for the answer, not a digest.
   * In-memory only: a pending delivery can't outlive the process anyway.
   */
  lastFinalText?: string;
  /**
   * A teammate bot asked us something in this thread and has not been told the
   * answer is ready. Their bot only wakes on a mention, so an answer streamed
   * as plain thread content is invisible to them — the collaboration stalls
   * with the answer sitting right there (observed repeatedly between bebop and
   * rocksteady). Cleared once the hand-back is posted.
   */
  pendingHandback?: string;
  /**
   * Mention waiting for the turn to earn it — armed into the answer stream only
   * once this turn actually calls a tool.
   *
   * Why the gate: every mention wakes the teammate's session, and their answer
   * mentions us back, so two idle bots keep each other awake forever. Observed
   * twice on 2026-07-28 in #ai-work — "@Bebop Жду." / "@April Ждём." for a dozen
   * rounds, and a rate-limited session whose only output was "You've hit your
   * session limit", delivered with a mention, which woke the other side to say
   * "нового нет", which woke it again. Both loops are turns and tokens spent to
   * say nothing.
   *
   * A turn with no tool call produced nothing for the teammate to act on, so it
   * has no business waking them. A turn that did work announces itself.
   */
  pendingMention?: string;

  /**
   * Assistant messages since the last tool call, in order. A long answer (a
   * code review, a verdict plus its rationale) arrives as several messages,
   * and delivering only the last one hands the requester a fragment.
   */
  finalTextParts?: string[];
  /**
   * Thread roots that already received this session's answer — whether the
   * agent delivered it or we did. Prevents a duplicate post.
   */
  deliveredRootIds: string[];
  /** Delivery attempts made for the current address (capped). */
  attempts: number;
  /**
   * Delivery tool calls awaiting their tool_result (tool_use_id → rootId).
   * A delivery only counts once the result comes back without is_error;
   * a rejected post must not suppress ours. In-memory only.
   */
  pendingAgentDeliveries: Map<string, string>;
  /** Quiescence debounce timer (in-memory only). */
  timer?: ReturnType<typeof setTimeout>;
}

/** Persisted subset — survives bot restarts and session resume. */
export interface PersistedReturnDeliveryState {
  address?: ReturnAddress;
  deliveredRootIds: string[];
  attempts: number;
}

export function createReturnDeliveryState(
  persisted?: PersistedReturnDeliveryState
): ReturnDeliveryState {
  return {
    address: persisted?.address,
    deliveredRootIds: persisted?.deliveredRootIds ?? [],
    attempts: persisted?.attempts ?? 0,
    pendingAgentDeliveries: new Map(),
  };
}
