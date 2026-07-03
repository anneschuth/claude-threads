/**
 * AccountPool — usage-balancing selector over a pool of Claude accounts.
 *
 * Responsibilities:
 * - Hand out an account for a new session, preferring whichever account has the
 *   most subscription headroom (lowest `/usage` load score), skipping accounts
 *   in rate-limit cooldown. Usage figures are probed on-demand at new-session
 *   start (see `usage-probe.ts` / `SessionManager.refreshAccountUsage`) and fed
 *   in via `setUsage()`.
 * - Track which accounts are currently in rate-limit cooldown so future sessions
 *   route around them. Resume of existing sessions bypasses cooldown because the
 *   conversation history lives under that account's HOME and can't be moved.
 * - Track usage counts / percentages for UI display (sticky message).
 *
 * Selection for a new session (`balanceByUsage: true`): among non-cooling
 * accounts, pick the lowest usage load score; ties break by fewest active
 * sessions, then round-robin rotation. An account whose usage hasn't been probed yet is
 * treated as maximally loaded so we never route a fresh session onto an account
 * that might already be at its cap — the poller fills real values in shortly
 * after startup, and the active-session tiebreak still spreads load until then.
 *
 * Single-account mode: pass an empty array (or `undefined`) to the constructor
 * and every method returns `null` — the bot then falls back to `process.env` as
 * it does today.
 */
import type { ClaudeAccount } from '../config/types.js';
import { createLogger } from '../utils/logger.js';
import { usageLoadScore, type AccountUsage } from './usage-probe.js';

const log = createLogger('account-pool');

/**
 * Provisional load (in `/usage` percentage points) attributed to each in-flight
 * session an account is already serving. Corrects for the probed usage snapshot
 * lagging behind sessions that just started, so concurrent acquisitions spread
 * across accounts instead of all landing on the one lowest-usage account.
 */
const ACTIVE_SESSION_LOAD_PENALTY = 5;

/**
 * FNV-1a 32-bit hash. Pure, deterministic, dependency-free — chosen so the
 * sticky-by-thread account binding picks the same account across bot restarts
 * without leaning on Node's `crypto`. Avalanche is good enough for routing
 * threads onto a handful of accounts.
 */
function hashThreadId(threadId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < threadId.length; i++) {
    h ^= threadId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Snapshot of pool state for UI/debug. */
export interface AccountPoolStatus {
  id: string;
  displayName: string;
  activeSessions: number;
  coolingUntil: number | null; // epoch ms, null = available
  /** Usage load score 0–100 from the latest `/usage` probe, or null if unknown. */
  usagePercent: number | null;
}

/** Options that steer account selection. */
export interface AcquireOptions {
  /**
   * When true (new sessions), pick by lowest `/usage` load score instead of the
   * deterministic sticky-by-thread binding. Resume leaves this false so it keeps
   * landing on the account that owns the conversation history.
   */
  balanceByUsage?: boolean;
}

export class AccountPool {
  private readonly accounts: ClaudeAccount[];
  private readonly byId: Map<string, ClaudeAccount>;
  /** Config order, for a stable final tiebreak in selection. */
  private readonly orderIndex: Map<string, number>;
  private readonly activeCounts: Map<string, number> = new Map();
  private readonly coolingUntil: Map<string, number> = new Map();
  /** Latest usage per account from the most recent probe. null = not yet known. */
  private readonly usage: Map<string, AccountUsage | null> = new Map();
  /** Rotating scan start, so accounts tied on score+active are cycled fairly. */
  private rrCursor = 0;

  constructor(accounts?: ClaudeAccount[]) {
    this.accounts = (accounts ?? []).filter((acc) => {
      const hasAuth = !!acc.home || !!acc.apiKey;
      if (!hasAuth) {
        log.warn(`Claude account ${acc.id} has neither home nor apiKey — ignoring`);
        return false;
      }
      // home and apiKey are documented as mutually exclusive. Dropping here
      // is the natural chokepoint so the later spawn path in cli.ts doesn't
      // silently pick one over the other.
      if (acc.home && acc.apiKey) {
        log.warn(
          `Claude account ${acc.id} has both home and apiKey set — must choose one; ignoring`
        );
        return false;
      }
      return true;
    });
    this.byId = new Map(this.accounts.map((acc) => [acc.id, acc]));
    this.orderIndex = new Map(this.accounts.map((acc, i) => [acc.id, i]));
    for (const acc of this.accounts) {
      this.activeCounts.set(acc.id, 0);
      this.usage.set(acc.id, null);
    }
  }

  /** True when no accounts are configured — caller should use default env. */
  get isEmpty(): boolean {
    return this.accounts.length === 0;
  }

  /** Number of configured accounts. */
  get size(): number {
    return this.accounts.length;
  }

  /** Account metadata in config order — for the on-demand usage probe. */
  get all(): readonly ClaudeAccount[] {
    return this.accounts;
  }

  /**
   * Acquire an account for a session.
   *
   * Selection priority:
   * 1. `preferredId` (if known) — returned as-is, even if cooling. Resume path:
   *    OAuth history lives under that account's HOME and can't move.
   * 2. Sticky-by-thread — ONLY when `opts.balanceByUsage` is false (resume of a
   *    pre-account-pool session that has no recorded `claudeAccountId`). The
   *    pool deterministically picks `accounts[hash(threadId) % n]` so such a
   *    thread re-derives the same account it would have started on. Skipped when
   *    the sticky account is cooling.
   * 3. Least-loaded — lowest `/usage` score among non-cooling accounts, ties
   *    broken by fewest active sessions then round-robin rotation. This is the
   *    path new sessions take (`balanceByUsage: true`).
   *
   * Returns `null` when the pool is empty, or when every account is cooling
   * and no `preferredId` was supplied.
   */
  acquire(preferredId?: string, threadId?: string, opts?: AcquireOptions): ClaudeAccount | null {
    if (this.isEmpty) return null;

    if (preferredId) {
      const preferred = this.byId.get(preferredId);
      if (preferred) {
        this.incrementActive(preferred.id);
        return preferred;
      }
      log.warn(`Preferred account "${preferredId}" not in pool — falling back to usage balancing`);
    }

    const now = Date.now();
    const n = this.accounts.length;

    // Sticky-by-thread is a resume-compat shim only: new sessions balance by
    // usage and pass balanceByUsage, so they never take this branch.
    if (threadId && !opts?.balanceByUsage) {
      const sticky = this.accounts[hashThreadId(threadId) % n];
      const cooling = this.coolingUntil.get(sticky.id) ?? 0;
      if (cooling <= now) {
        this.incrementActive(sticky.id);
        return sticky;
      }
      // Sticky account is cooling — drop to least-loaded so the session can
      // still start.
    }

    const chosen = this.selectLeastLoaded(now);
    if (!chosen) {
      log.warn(`All ${n} accounts are in rate-limit cooldown`);
      return null;
    }
    this.incrementActive(chosen.id);
    return chosen;
  }

  /**
   * Pick the least-loaded non-cooling account. Ordering:
   *   1. effective load = usage score + a penalty per in-flight session
   *      (unknown usage → +Infinity, i.e. last resort)
   *   2. round-robin among equals (rotating cursor)
   * Returns null when every account is cooling.
   *
   * Folding active sessions into the score spreads a burst of near-simultaneous
   * starts: they all read the same cached `/usage` snapshot (which can't reflect
   * a session that started microseconds ago), so without the penalty every one
   * of them would pick the single lowest-usage account. Each `acquire` bumps the
   * chosen account's active count, so the next pick in the burst sees it as
   * `ACTIVE_SESSION_LOAD_PENALTY` more loaded and moves on. The rotating cursor
   * then breaks any remaining exact ties (all-unknown at startup, all at 0%
   * early in the week, integer-% collisions) so they don't collapse onto the
   * config-first account. Distinct effective loads still win outright.
   */
  private selectLeastLoaded(now: number): ClaudeAccount | null {
    const n = this.accounts.length;
    let best: ClaudeAccount | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    let bestIdx = -1;
    for (let k = 0; k < n; k++) {
      const idx = (this.rrCursor + k) % n;
      const acc = this.accounts[idx];
      if ((this.coolingUntil.get(acc.id) ?? 0) > now) continue;
      const score = this.effectiveLoad(acc.id);
      if (best === null || score < bestScore) {
        best = acc;
        bestScore = score;
        bestIdx = idx;
      }
    }
    // Advance the cursor past the chosen account so the next tie rotates on.
    if (bestIdx >= 0) this.rrCursor = (bestIdx + 1) % n;
    return best;
  }

  /** Usage load score for routing; unknown usage sorts last (+Infinity). */
  private loadScore(accountId: string): number {
    const u = this.usage.get(accountId);
    return u ? usageLoadScore(u) : Number.POSITIVE_INFINITY;
  }

  /**
   * Usage score plus a provisional penalty for each in-flight session, so
   * just-started sessions the `/usage` snapshot hasn't caught up to still count
   * against an account's headroom. `+Infinity` (unknown usage) stays +Infinity.
   */
  private effectiveLoad(accountId: string): number {
    const base = this.loadScore(accountId);
    const active = this.activeCounts.get(accountId) ?? 0;
    return base + ACTIVE_SESSION_LOAD_PENALTY * active;
  }

  /**
   * Release an account — caller invokes this when a session ends so usage
   * accounting stays accurate. No-op if the id isn't in the pool.
   */
  release(accountId: string): void {
    const current = this.activeCounts.get(accountId);
    if (current === undefined) return;
    this.activeCounts.set(accountId, Math.max(0, current - 1));
  }

  /**
   * Record the latest `/usage` probe result for an account. `null` marks the
   * usage as unknown again (e.g. a probe failed). No-op for unknown ids.
   */
  setUsage(accountId: string, usage: AccountUsage | null): void {
    if (!this.byId.has(accountId)) return;
    this.usage.set(accountId, usage);
    if (usage) {
      log.debug(`Account "${accountId}" usage: ${usageLoadScore(usage)}% (load score)`);
    }
  }

  /**
   * Mark an account as rate-limited until `untilEpochMs`. Subsequent `acquire()`
   * calls without `preferredId` will skip this account until the timestamp passes.
   */
  markCooling(accountId: string, untilEpochMs: number): void {
    if (!this.byId.has(accountId)) {
      log.warn(`markCooling called for unknown account "${accountId}"`);
      return;
    }
    const existing = this.coolingUntil.get(accountId) ?? 0;
    // Only extend cooldown, never shorten it.
    if (untilEpochMs > existing) {
      this.coolingUntil.set(accountId, untilEpochMs);
      const minutes = Math.ceil((untilEpochMs - Date.now()) / 60000);
      log.info(`Account "${accountId}" cooling for ~${minutes}min`);
    }
  }

  /** Look up an account by id. Returns undefined for unknown ids. */
  get(accountId: string): ClaudeAccount | undefined {
    return this.byId.get(accountId);
  }

  /** Snapshot of pool state — for UI / sticky message / debug logs. */
  status(): AccountPoolStatus[] {
    const now = Date.now();
    return this.accounts.map((acc) => {
      const cooling = this.coolingUntil.get(acc.id) ?? 0;
      const usage = this.usage.get(acc.id) ?? null;
      return {
        id: acc.id,
        displayName: acc.displayName ?? acc.id,
        activeSessions: this.activeCounts.get(acc.id) ?? 0,
        coolingUntil: cooling > now ? cooling : null,
        usagePercent: usage ? usageLoadScore(usage) : null,
      };
    });
  }

  private incrementActive(accountId: string): void {
    this.activeCounts.set(accountId, (this.activeCounts.get(accountId) ?? 0) + 1);
  }
}
