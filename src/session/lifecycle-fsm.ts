/**
 * Session lifecycle finite-state machine.
 *
 * Defines the legal transitions between `SessionLifecycleState` values and
 * provides a `check()` helper that `transitionTo()` calls before mutating
 * state. By default, illegal transitions are logged at `warn` level with a
 * structured payload — the transition still happens, so this is purely
 * observability. Set `CLAUDE_THREADS_FSM_STRICT=1` to throw instead; useful
 * for catching bugs in tests, not recommended for production until we've
 * observed a few weeks of real traffic without warnings.
 *
 * ## Current states
 *
 * | State        | What it means                                                |
 * |--------------|--------------------------------------------------------------|
 * | `starting`   | Initial state. Session is being created.                     |
 * | `active`     | Normal operation. Claude is idle or streaming.               |
 * | `processing` | Reserved — never transitioned to in current code.            |
 * | `paused`     | Timed out. Waiting for resume reaction or user message.      |
 * | `interrupted`| User pressed escape / ⏸️. Claude stopped mid-turn.            |
 * | `restarting` | `!cd` / `!permissions` / worktree switch — Claude respawns.  |
 * | `cancelling` | `!stop` / ❌ — session is being torn down.                   |
 * | `ending`     | Reserved — never transitioned to in current code.            |
 *
 * `processing` and `ending` are declared in the type but no call site
 * currently transitions to them. They're permitted as targets from `active`
 * for forward compatibility, but the warn logs will reveal if something
 * actually hits those paths.
 *
 * ## Transitions (source-of-truth)
 *
 * Keep this table in sync with `ALLOWED_TRANSITIONS` below. When adding a
 * transition, update both the code and this comment.
 *
 * ```
 * starting   -> active                 (markClaudeResponded)
 * starting   -> paused                 (idle timeout before first response)
 * starting   -> interrupted            (escape before first response)
 * starting   -> cancelling             (cancel during startup)
 * starting   -> restarting             (!cd / !permissions before first response, e.g. on a just-resumed session)
 * active     -> active                 (idempotent no-op, e.g. post-reply)
 * active     -> processing             (reserved)
 * active     -> paused                 (idle timeout)
 * active     -> interrupted            (!escape)
 * active     -> restarting             (!cd, !permissions, worktree)
 * active     -> cancelling             (!stop)
 * active     -> ending                 (reserved)
 * processing -> active                 (request complete)
 * processing -> paused                 (idle timeout mid-processing)
 * processing -> interrupted            (!escape mid-processing)
 * processing -> restarting             (!cd mid-processing)
 * processing -> cancelling             (!stop mid-processing)
 * paused     -> active                 (resumed)
 * paused     -> cancelling             (cancel while paused)
 * paused     -> restarting             (!cd on a just-resumed session)
 * interrupted-> active                 (next message continues the session)
 * interrupted-> cancelling             (!stop while interrupted)
 * interrupted-> restarting             (!cd while interrupted)
 * interrupted-> paused                 (idle timeout after escape)
 * restarting -> active                 (respawn succeeded)
 * restarting -> paused                 (respawn failed, persisted)
 * restarting -> cancelling             (cancel during restart)
 * cancelling -> ending                 (terminal)
 * ```
 *
 * Everything not listed is illegal.
 */

import type { SessionLifecycleState } from './types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('fsm');

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

/**
 * Allowed `from -> to` transitions. `Set` membership is the check.
 *
 * Self-transitions (e.g. `active -> active`) are allowed for states where
 * idempotent re-entry is common — they're no-ops and should not log.
 * Other self-transitions are listed explicitly only when observed in the
 * real code.
 */
const ALLOWED_TRANSITIONS: Record<SessionLifecycleState, ReadonlySet<SessionLifecycleState>> = {
  // starting → paused: idle timeout fires before first Claude response
  // starting → interrupted: user presses escape during startup
  // starting → restarting: `!cd`/`!permissions` on a just-resumed session
  starting: new Set(['active', 'paused', 'interrupted', 'cancelling', 'restarting']),

  active: new Set([
    'active',      // idempotent; many post-helpers call transitionTo('active') defensively
    'processing',
    'paused',
    'interrupted',
    'restarting',
    'cancelling',
    'ending',
  ]),

  processing: new Set([
    'active',
    'paused',
    'interrupted',
    'restarting',
    'cancelling',
  ]),

  // paused → restarting: resumed session goes straight into a respawn path
  paused: new Set(['active', 'cancelling', 'restarting']),

  // interrupted → paused: idle timeout after escape
  interrupted: new Set(['active', 'cancelling', 'restarting', 'paused']),

  restarting: new Set(['active', 'paused', 'cancelling']),
  cancelling: new Set(['ending']),
  ending: new Set(), // terminal
};

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

/**
 * Validate a `from -> to` transition against the FSM.
 *
 * - Legal transition: no-op.
 * - Illegal transition + `CLAUDE_THREADS_FSM_STRICT=1`: throws `Error`.
 * - Illegal transition otherwise: logs `warn` with structured payload.
 *
 * The structured log fields are stable (matched by ops tooling): `event`,
 * `from`, `to`, `sessionId`.
 */
export function checkTransition(
  from: SessionLifecycleState,
  to: SessionLifecycleState,
  sessionId: string,
): void {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (allowed.has(to)) return;

  const msg = `illegal lifecycle transition ${from} -> ${to}`;
  const payload = {
    event: 'fsm.illegal_transition',
    from,
    to,
    sessionId,
  };

  if (process.env.CLAUDE_THREADS_FSM_STRICT === '1') {
    throw new Error(`${msg} (sessionId=${sessionId})`);
  }

  log.warn(msg, payload);
}

// ---------------------------------------------------------------------------
// Introspection (exposed for tests)
// ---------------------------------------------------------------------------

/** All states declared by the FSM. Useful for exhaustive tests. */
export const ALL_STATES: readonly SessionLifecycleState[] = [
  'starting',
  'active',
  'processing',
  'paused',
  'interrupted',
  'restarting',
  'cancelling',
  'ending',
];

/** Read-only view of the transition table (for tests and diagnostics). */
export function allowedTargetsFrom(
  from: SessionLifecycleState,
): ReadonlySet<SessionLifecycleState> {
  return ALLOWED_TRANSITIONS[from];
}
