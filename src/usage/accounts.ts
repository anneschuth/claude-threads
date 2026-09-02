/**
 * Mapping the `claudeAccounts` pool onto things `!usage` can read.
 *
 * The pool and this command must enumerate the same seats or the command
 * becomes actively misleading: it identifies accounts by an alternate `$HOME`
 * containing `.claude/.credentials.json`, while our own discovery scans for
 * `~/.claude-*` directories. Those sets are disjoint, so a configured pool
 * would leave `!usage all` reporting seats the bot no longer uses and none of
 * the ones actually burning tokens — a plausible answer to a different
 * question, which is worse than an error.
 */

import path from 'path';
import type { ClaudeAccount } from '../config/types.js';

export interface AccountTarget {
  /** The pool's own label, so a row here matches a routing decision there. */
  name: string;
  /** Where this account's credentials live; absent when there is nothing to read. */
  configDir?: string;
  /** Why there are no quota windows for this row. */
  note?: string;
}

/**
 * The accounts `!usage` should report.
 *
 * `onlyId` narrows to the account a session is bound to. An id that is not in
 * the pool falls back to the whole pool rather than an empty answer — a config
 * that changed under a persisted session should not silently report nothing.
 */
export function accountTargets(
  accounts: ClaudeAccount[] | undefined,
  onlyId?: string
): AccountTarget[] {
  if (!accounts?.length) return [];

  const selected =
    onlyId && accounts.some((a) => a.id === onlyId)
      ? accounts.filter((a) => a.id === onlyId)
      : accounts;

  return selected.map((account) => {
    const name = account.displayName ?? account.id;

    if (!account.home) {
      // API-key accounts are billed per token and have no subscription
      // windows. The row stays — omitting it would read as "this one is fine".
      return { name, note: 'billed by API key — no subscription limits to report' };
    }

    return { name, configDir: path.join(account.home, '.claude') };
  });
}
