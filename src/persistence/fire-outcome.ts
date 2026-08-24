/**
 * Shared outcome bookkeeping for unattended fires — routine runs and watch
 * fires. One policy for the state machine both features share:
 *
 *   unauthorized → disable + channel notice (creator lost platform access)
 *   skipped      → record status only (no stamps, no failure streak)
 *   uncounted    → record status only (routines' manual `!routines run`)
 *   otherwise    → stamp the fire, advance/reset the failure streak, and
 *                  auto-disable + notice when the streak hits the max
 *
 * The flavors inject their store writes (field names differ: lastRunAt vs
 * lastFiredAt + firesToday) and wording; the branch ordering, streak math,
 * disable threshold, and notice copy live here once.
 *
 * Never throws: bookkeeping runs inside fire paths that must not reject
 * (scheduler ticks, fire-and-forget evaluation) — the run itself already
 * happened, so losing one bookkeeping write is the acceptable outcome.
 */

export type FireStatus = 'ok' | 'failed' | 'skipped';

export async function recordFireOutcome(opts: {
  status: FireStatus | 'unauthorized';
  /** False → record status only, never touching stamps or the streak (manual routine runs). */
  counted: boolean;
  consecutiveFailures: number;
  maxConsecutiveFailures: number;
  createdBy: string;
  /** Auto-disable notice noun: 'runs' for routines, 'fires' for watches. */
  runNoun: string;
  /** One store write: `{ enabled: false, lastStatus: 'failed' }` (creator deauthorized). */
  disableUnauthorized(): Promise<unknown>;
  /** One store write: `{ lastStatus }` — outcome recorded without stamps or streak. */
  recordStatusOnly(status: FireStatus): Promise<unknown>;
  /** One store write: stamp fields + `lastStatus` + the new failure streak. */
  recordCounted(status: FireStatus, failures: number): Promise<unknown>;
  /** One store write: `{ enabled: false }` — the streak hit the max. */
  disable(): Promise<unknown>;
  /** Best-effort channel notice for an auto-disable. */
  notifyDisabled(reason: string): Promise<unknown>;
  /** Failure sink — bookkeeping must never reject into the caller. */
  logError(message: string): void;
}): Promise<void> {
  try {
    if (opts.status === 'unauthorized') {
      await opts.disableUnauthorized();
      await opts.notifyDisabled(`its creator @${opts.createdBy} is no longer authorized on this platform`);
    } else if (opts.status === 'skipped') {
      await opts.recordStatusOnly('skipped');
    } else if (!opts.counted) {
      await opts.recordStatusOnly(opts.status);
    } else {
      const failures = opts.status === 'failed' ? opts.consecutiveFailures + 1 : 0;
      await opts.recordCounted(opts.status, failures);
      if (failures >= opts.maxConsecutiveFailures) {
        await opts.disable();
        await opts.notifyDisabled(`${failures} consecutive ${opts.runNoun} failed`);
      }
    }
  } catch (err) {
    opts.logError((err as Error).message);
  }
}
