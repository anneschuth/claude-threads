/**
 * Account usage probe — asks a Claude account how much of its subscription
 * limits it has burned by running `claude -p "/usage" --output-format json`
 * under that account's HOME (or ANTHROPIC_API_KEY).
 *
 * Why this exists: the AccountPool used to spread new sessions across accounts
 * with round-robin / sticky-by-thread, which ignores how loaded each account
 * actually is. `/usage` reports the *real* subscription limit state (session +
 * weekly rolling windows) straight from the server, so the pool can route new
 * sessions to whichever account has the most headroom.
 *
 * The probe is cheap: `/usage` runs zero turns, costs $0, and returns in well
 * under a second. It still spawns a process though, so callers should poll it
 * periodically in the background rather than on every `acquire()`.
 *
 * Subscription-only: the top-line percentages come from an OAuth (Pro/Max)
 * subscription. API-key accounts have no such limits — for those the parser
 * returns `null` and the pool falls back to load-by-active-session.
 */
import { crossSpawn } from '../utils/spawn.js';
import { getClaudePath } from './version-check.js';
import { buildClaudeChildEnv, type ClaudeCliAccount } from './cli.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('usage-probe');

/** Default cap on how long we wait for a `/usage` probe before giving up. */
export const DEFAULT_USAGE_PROBE_TIMEOUT_MS = 30_000;

/**
 * Parsed subscription usage. Percentages are 0–100 (integers as Claude prints
 * them). Reset timestamps are the raw human strings Claude emits — we keep them
 * for display only, not for arithmetic.
 */
export interface AccountUsage {
  /** Current 5-hour session window, percent used (0–100). */
  sessionPct: number;
  /** Current week across all models, percent used (0–100). */
  weekAllModelsPct: number;
  /**
   * Highest per-model weekly percentage seen (e.g. the "Current week (Fable)"
   * line), or null if no per-model line was present. Kept separate from
   * `weekAllModelsPct` because a single model can be throttled independently.
   */
  weekPerModelPct: number | null;
  /** Human-readable reset hint for the session window, if present. */
  sessionResetsAt: string | null;
  /** Human-readable reset hint for the weekly window, if present. */
  weekResetsAt: string | null;
}

/**
 * Parse the text body of a `/usage` response into structured percentages.
 *
 * Pure and dependency-free so it can be unit-tested against captured output.
 * Returns `null` when the text doesn't look like a subscription usage report
 * (e.g. an API-key account, an error, or a future output format we don't
 * recognize) — the caller treats that as "usage unknown".
 *
 * Expected lines (order-independent, extra lines ignored):
 *   Current session: 4% used · resets Jul 4 at 2:20am (Asia/Bangkok)
 *   Current week (all models): 6% used · resets Jul 5 at 4pm (Asia/Bangkok)
 *   Current week (Fable): 0% used
 */
export function parseUsageOutput(text: string): AccountUsage | null {
  if (!text) return null;

  const sessionMatch = text.match(
    /Current session:\s*(\d+)%\s*used(?:\s*·\s*resets\s*([^\n]+?))?\s*(?:\n|$)/i
  );
  // Accept both the "(all models)" phrasing and a bare "Current week:" in case
  // a CLI version drops the qualifier — otherwise a loaded account's weekly %
  // would silently read as 0 and look empty. The optional group requires the
  // ':' to follow immediately, so a per-model line ("Current week (Fable):")
  // can't match here.
  const weekAllMatch = text.match(
    /Current week(?: \(all models\))?:\s*(\d+)%\s*used(?:\s*·\s*resets\s*([^\n]+?))?\s*(?:\n|$)/i
  );

  // A subscription report always has at least these two lines. If neither is
  // present this isn't output we can act on.
  if (!sessionMatch && !weekAllMatch) return null;

  const sessionPct = sessionMatch ? clampPct(Number(sessionMatch[1])) : 0;
  const weekAllModelsPct = weekAllMatch ? clampPct(Number(weekAllMatch[1])) : 0;

  // Per-model weekly lines: "Current week (Fable): 0% used". Take the highest
  // so a single throttled model still counts against the account's headroom.
  // The "(all models)" line is excluded via the negative lookahead.
  let weekPerModelPct: number | null = null;
  const perModelRe = /Current week \((?!all models\))[^)]+\):\s*(\d+)%\s*used/gi;
  for (const m of text.matchAll(perModelRe)) {
    const pct = clampPct(Number(m[1]));
    weekPerModelPct = weekPerModelPct === null ? pct : Math.max(weekPerModelPct, pct);
  }

  return {
    sessionPct,
    weekAllModelsPct,
    weekPerModelPct,
    sessionResetsAt: sessionMatch?.[2]?.trim() || null,
    weekResetsAt: weekAllMatch?.[2]?.trim() || null,
  };
}

/**
 * Single load score in [0, 100] for routing: the most-constrained window wins,
 * since the account will be rate-limited the moment *any* window hits 100%.
 */
export function usageLoadScore(usage: AccountUsage): number {
  return Math.max(
    usage.sessionPct,
    usage.weekAllModelsPct,
    usage.weekPerModelPct ?? 0
  );
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Shape of a `claude --output-format json` result envelope (subset). */
interface UsageResultEnvelope {
  result?: unknown;
  is_error?: boolean;
}

/**
 * Probe one account's subscription usage. Spawns `claude -p "/usage"` under the
 * account's credentials and parses the result. Resolves to `null` on any
 * failure (spawn error, timeout, non-zero exit, unparseable output) — the pool
 * treats a null the same as "not yet known" and routes around it conservatively
 * rather than crashing.
 */
export async function probeAccountUsage(
  account: ClaudeCliAccount,
  opts: { timeoutMs?: number } = {}
): Promise<AccountUsage | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_USAGE_PROBE_TIMEOUT_MS;
  const claudePath = getClaudePath();
  const env = buildClaudeChildEnv(process.env, account);

  return new Promise<AccountUsage | null>((resolve) => {
    let settled = false;
    const finish = (value: AccountUsage | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    let child: ReturnType<typeof crossSpawn>;
    try {
      child = crossSpawn(claudePath, ['-p', '/usage', '--output-format', 'json'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      log.warn(`Failed to spawn /usage probe for "${account.id}": ${err}`);
      resolve(null);
      return;
    }

    const timer = setTimeout(() => {
      log.warn(`/usage probe for "${account.id}" timed out after ${timeoutMs}ms`);
      try {
        child.kill('SIGKILL');
      } catch {
        // best-effort
      }
      finish(null);
    }, timeoutMs);

    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    // Drain stderr so the pipe buffer can't fill and stall the child.
    child.stderr?.on('data', () => {});

    child.on('error', (err) => {
      log.warn(`/usage probe for "${account.id}" errored: ${err}`);
      finish(null);
    });

    child.on('close', () => {
      const usage = extractUsage(stdout);
      if (!usage) {
        log.debug(`/usage probe for "${account.id}" returned no parseable usage`);
      }
      finish(usage);
    });
  });
}

/** Pull the `.result` text out of the JSON envelope and parse it. */
function extractUsage(stdout: string): AccountUsage | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  let text = trimmed;
  try {
    const parsed = JSON.parse(trimmed) as UsageResultEnvelope;
    if (typeof parsed.result === 'string') {
      text = parsed.result;
    }
  } catch {
    // Not JSON — fall back to treating the raw stdout as the usage text. This
    // keeps the probe working if the CLI is ever run without json formatting.
  }
  return parseUsageOutput(text);
}
