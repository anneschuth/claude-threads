/**
 * `!usage` — subscription quota for the seat this thread runs on, or for every
 * seat the bot is configured with, via `!usage all`.
 *
 * ⚠️ The numbers come from `usage-probe.ts`, which runs
 * `claude -p "/usage" --output-format json` under an account's HOME. Nothing
 * here touches a credential: the CLI owns its own token refresh, rotation and
 * platform storage, so this command inherits all of it and owns none of it.
 * `/usage` runs zero turns and costs $0.
 *
 * What a seat *is* — its login address and plan — is read from `.claude.json`
 * beside its config; see `profiles.ts`.
 */

import { homedir } from 'os';
import path from 'path';
import { probeAccountUsage, type AccountUsage } from '../claude/usage-probe.js';
import { accountEmail, accountPlan, profileNameFor } from './profiles.js';
import type { ProfileUsage, UsageLimit } from './render.js';
import { accountTargets } from './accounts.js';
import type { ClaudeAccount } from '../config/types.js';

export { renderProfiles } from './render.js';
export type { ProfileUsage } from './render.js';

/**
 * The probe's percentages, as the three windows `!usage` shows.
 *
 * ⚠️ `weekly_scoped` is a SEPARATE bucket from `weekly_all`. A seat can read
 * 62% overall while sitting at 100% on its model-scoped week, so both rows are
 * shown whenever the probe saw a per-model line — reporting only the headline
 * tells you that you have headroom when you have none.
 */
export function toLimits(usage: AccountUsage): UsageLimit[] {
  const limits: UsageLimit[] = [
    {
      kind: 'session',
      percent: usage.sessionPct,
      resetsAt: usage.sessionResetsAt ?? undefined,
    },
    {
      kind: 'weekly_all',
      percent: usage.weekAllModelsPct,
      resetsAt: usage.weekResetsAt ?? undefined,
    },
  ];

  // Absent means the probe saw no per-model line at all, which is different
  // from "0% used" — inventing a zero row would read as measured headroom.
  if (usage.weekPerModelPct !== null) {
    limits.push({
      kind: 'weekly_scoped',
      percent: usage.weekPerModelPct,
      resetsAt: usage.weekResetsAt ?? undefined,
    });
  }

  return limits;
}

/**
 * One seat's row.
 *
 * `home` absent means "the account this process already runs as" — the probe
 * then inherits the bot's own environment, which is exactly single-account
 * mode.
 *
 * The account is looked up even when the probe fails: "log in again" is not
 * actionable unless it says which account, and an unreadable seat must be
 * reported rather than dropped — a missing row reads as "that one is fine".
 */
async function readSeat(name: string, configDir: string, home?: string): Promise<ProfileUsage> {
  const email = await accountEmail(configDir);
  const plan = await accountPlan(configDir);
  const usage = await probeAccountUsage({ id: name, home });

  if (!usage) {
    // The probe returns null for a logged-out seat, an API-key account, and an
    // output shape it does not recognise alike, so the message names the
    // likely cause without asserting it.
    return {
      profile: name,
      email,
      plan,
      error: `usage unknown — the seat may be logged out (try \`claude login\` for ${name})`,
    };
  }

  return { profile: name, email, plan, limits: toLimits(usage) };
}

export interface CollectOptions {
  /** Every seat, rather than just the one this session uses. */
  all: boolean;
  /** The configured account pool, when the bot is running one. */
  accounts?: readonly ClaudeAccount[];
  /** The pool account this thread is bound to, if it has one. */
  sessionAccountId?: string;
}

/**
 * Quota for one seat or all of them.
 *
 * Two modes, and which one is in force is decided by the bot's config, not by
 * this command:
 *
 * - **Pool configured** — report the pool's accounts, labelled with the pool's
 *   own ids. This is the mode that matters: the seats the router is deciding
 *   between are the seats you get told about, so what you read and what routes
 *   can never disagree.
 * - **No pool** — one row, for the account this process already runs as.
 *
 * ⚠️ Deliberately NOT a scan of `~/.claude*` directories. Other seats on the
 * same box belong to people, not to the bot, and a chat command several people
 * can run should not enumerate them. The pool is the set of accounts the bot
 * actually burns tokens on, which is the set the question is about.
 */
export async function collectUsage(options: CollectOptions): Promise<ProfileUsage[]> {
  const targets = accountTargets(options.accounts, options.all ? undefined : options.sessionAccountId);
  const results: ProfileUsage[] = [];

  if (targets.length > 0) {
    for (const target of targets) {
      // An API-key account has no subscription windows; it is still listed,
      // because an omitted row reads as "that one is fine".
      if (!target.configDir) {
        results.push({ profile: target.name, error: target.note });
        continue;
      }
      // The pool addresses an account by an alternate $HOME holding
      // `.claude/`, so the HOME the probe needs is the parent of the config
      // dir `accountTargets` resolved.
      results.push(
        await readSeat(target.name, target.configDir, path.dirname(target.configDir))
      );
    }
    return results;
  }

  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude');
  return [await readSeat(profileNameFor(configDir), configDir)];
}
