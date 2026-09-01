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
    const token = await resolveToken(profile.configDir);
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

/**
 * Quota for one profile, or all of them. `all` is per-machine by definition:
 * profile names are directory names and say nothing about which account they
 * hold, which is why every row carries its email.
 */
export async function collectUsage(all: boolean): Promise<ProfileUsage[]> {
  const version = await claudeVersion();
  const profiles = all ? await discoverProfiles() : [currentProfile()];

  // Sequential, not Promise.all: several stale profiles would otherwise fire
  // concurrent `security` writes at the macOS Keychain, which is unhappy about
  // that. A handful of profiles is not worth the parallelism.
  const results: ProfileUsage[] = [];
  for (const profile of profiles) {
    results.push(await readProfile(profile, version));
  }
  return results;
}
