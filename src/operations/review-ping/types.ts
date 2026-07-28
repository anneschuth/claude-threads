/**
 * Review-ping types — asking the reviewer, from code.
 *
 * The guard lives on the session and IS persisted, unlike the in-memory
 * WeakMap it replaces. The comment that WeakMap carried said one duplicate
 * review request after a restart was cheaper than another persisted field, and
 * that was wrong twice over: the duplicate opens a SECOND thread in the
 * reviewer's world (the channel route posts at channel level), so the reviewer
 * gets a cold session that knows nothing about the review it already did — and
 * `pullRequestUrl` plus docs-ping's own `settled` flag were persisted all along,
 * so the field costs nothing new to keep compatible.
 */

/** Review-ping state carried on the session (a subset is persisted). */
export interface ReviewPingState {
  /** MR URLs already asked about — one ask per MR, across restarts. */
  pinged: Set<string>;
  /** Quiescence debounce timer (in-memory only). */
  timer?: ReturnType<typeof setTimeout>;
}

/** Persisted subset — survives restarts so a resumed session doesn't re-ask. */
export interface PersistedReviewPingState {
  pinged: string[];
}

export function createReviewPingState(persisted?: PersistedReviewPingState): ReviewPingState {
  return {
    // Defensive: older persisted sessions have no reviewPing at all, and a
    // hand-edited sessions.json could carry a non-array.
    pinged: new Set(Array.isArray(persisted?.pinged) ? persisted.pinged : []),
  };
}
