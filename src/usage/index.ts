/**
 * `!usage` — subscription quota for the running profile, or for every Claude
 * profile on the machine with `!usage all`.
 */

import { homedir } from 'os';
import {
  accountEmail,
  claudeVersion,
  discoverProfiles,
  fetchUsage,
  profileNameFor,
  resolveToken,
  type Profile,
} from './client.js';
import type { ProfileUsage } from './render.js';
import { accountTargets } from './accounts.js';
import type { ClaudeAccount } from '../config/types.js';

export { renderProfiles } from './render.js';
export type { ProfileUsage } from './render.js';

/** The profile this process is running under. */
function currentProfile(): Profile {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? `${homedir()}/.claude`;
  return { name: profileNameFor(configDir), configDir };
}

async function readProfile(profile: Profile, version: string): Promise<ProfileUsage> {
  // The account is looked up even when the read fails: "log in again" is not
  // actionable unless it says which account.
  const email = await accountEmail(profile.configDir);
  try {
    const token = await resolveToken(profile.configDir, profile.name);
    return { profile: profile.name, email, limits: await fetchUsage(token, version) };
  } catch (err) {
    // One unreadable seat must not take the others down with it, and it is
    // reported rather than dropped — a missing row reads as "fine".
    return {
      profile: profile.name,
      email,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface CollectOptions {
  /** Every seat, rather than just the one this session uses. */
  all: boolean;
  /** The configured account pool, when the bot is running one. */
  accounts?: ClaudeAccount[];
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
 * - **Single account** — report `~/.claude*` profiles on the machine. Names are
 *   directory names and say nothing about which account they hold, which is why
 *   every row carries its email.
 */
export async function collectUsage(options: CollectOptions): Promise<ProfileUsage[]> {
  const version = await claudeVersion();
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
      results.push(await readProfile({ name: target.name, configDir: target.configDir }, version));
    }
    return results;
  }

  const profiles = options.all ? await discoverProfiles() : [currentProfile()];

  // Sequential, not Promise.all: several stale profiles would otherwise fire
  // concurrent `security` writes at the macOS Keychain, which is unhappy about
  // that. A handful of profiles is not worth the parallelism.
  for (const profile of profiles) {
    results.push(await readProfile(profile, version));
  }
  return results;
}
