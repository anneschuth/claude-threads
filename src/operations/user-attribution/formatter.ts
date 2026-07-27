/**
 * User attribution formatter
 *
 * Wraps a single user-turn message with an inline `[@username]:` prefix so
 * Claude can tell who is speaking when several people share one thread.
 *
 * Applied at the send boundary ONLY — the sender identity is carried
 * separately so stored prompts (firstPrompt/queuedPrompt) stay raw and never
 * leak the prefix into thread titles or branch names. This is the same idiom
 * as formatApprovedMessage / formatSideConversationsForClaude: compose the
 * attribution right before handing the message to Claude.
 */

/** Usernames we treat as "no usable sender" — attribution is skipped. */
const UNKNOWN_USERNAME = 'unknown';

/**
 * Reduce a raw platform login to a safe, login-shaped token for the prefix.
 * Platform logins are already constrained; this is defensive so a stray value
 * can never break the `[@...]:` shape. Keeps letters, digits, and the small
 * set of punctuation logins use (`. _ -`), drops everything else.
 */
export function sanitizeUsername(username: string): string {
  return username.replace(/[^A-Za-z0-9._-]/g, '');
}

/**
 * Wrap a user message with sender attribution.
 *
 * `enabled` is the session's `userAttribution` flag. It is a REQUIRED
 * parameter so the compiler forces every send site to decide; the "disabled"
 * semantics live here, in one tested place. When `false` the message always
 * passes through unchanged (the feature is opt-in, default off).
 *
 * - Usable username → `[@<sanitized>]: <message>`.
 * - Empty / falsy / "unknown" / sanitizes-to-empty → `message` unchanged
 *   (never break or half-tag a message; system/control sends pass no username
 *   and so flow through untouched).
 *
 * The message body is NOT sanitized — it is the user's own content and
 * downstream (buildMessageContent, the platform) already handles it.
 */
/**
 * Whether a session should actually attribute its turns right now.
 *
 * The config flag says the feature is *available*; this says it is *useful*.
 * A prefix on a solo thread is pure noise — there is only one person it could
 * be — so attribution stays silent until a session genuinely has more than one
 * participant. `participantCount` is the size of the session allowlist, which
 * starts at 1 (the owner) and grows only on real collaboration events:
 * `!invite`, or another user reviving a paused session.
 *
 * Evaluated per send rather than once at session start, so a thread that
 * becomes shared mid-session starts attributing from that point on. The
 * system-prompt note is emitted whenever the flag is on, precisely so Claude
 * is already primed for a prefix that may only start arriving later.
 *
 * Kept as a pure predicate over primitives (not a `Session`) so it stays
 * trivially testable and introduces no import cycle into the session module.
 */
export function shouldAttribute(enabled: boolean, participantCount: number): boolean {
  return enabled && participantCount > 1;
}

export function formatUserTurn(
  message: string,
  username: string | undefined,
  enabled: boolean,
): string {
  if (!enabled) return message;
  if (!username) return message;
  if (username.toLowerCase() === UNKNOWN_USERNAME) return message;
  const safe = sanitizeUsername(username);
  if (!safe) return message;
  return `[@${safe}]: ${message}`;
}
