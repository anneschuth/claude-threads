/**
 * Finding Claude Code seats on this machine and reading what a seat *is* —
 * which account it is logged in as, and what plan that account is on.
 *
 * ⚠️ Everything here reads `.claude.json`, the profile metadata Claude Code
 * writes beside its config. It deliberately does NOT touch `.credentials.json`
 * or the macOS Keychain: the quota numbers come from `usage-probe.ts`, which
 * spawns `claude -p "/usage"` and lets the CLI own its own tokens — refresh,
 * rotation and platform storage included. Nothing in `!usage` handles a
 * credential, which is the whole point of that arrangement.
 */

import { readFile } from 'fs/promises';
import path from 'path';
import { planLabel } from './plan.js';

/** `~/.claude` → "default", `~/.claude-vvs` → "vvs". */
export function profileNameFor(configDir: string): string {
  const base = path.basename(configDir.replace(/\/+$/, ''));
  return base === '.claude' ? 'default' : base.replace(/^\.claude-/, '');
}

/**
 * Where a seat's `.claude.json` may live, most likely first.
 *
 * ⚠️ Two layouts. With `CLAUDE_CONFIG_DIR` it sits INSIDE the config dir
 * (`~/.claude-vvs/.claude.json`). With a plain `$HOME` — which is how pooled
 * accounts are addressed — it is a SIBLING of `.claude`
 * (`<home>/.claude.json`). Checking only the first leaves every pooled account
 * with no email and no plan badge, silently, because both readers swallow a
 * miss.
 */
export function metadataCandidates(configDir: string): string[] {
  const inside = path.join(configDir, '.claude.json');
  const sibling = path.join(path.dirname(configDir), '.claude.json');
  return inside === sibling ? [inside] : [inside, sibling];
}

/** The `oauthAccount` block, as much of it as we rely on. */
interface OAuthAccountMetadata {
  emailAddress?: string;
  /** Coarse plan, e.g. `claude_max`. */
  organizationType?: string;
  /** Multiplier tier, e.g. `default_claude_max_20x`. */
  organizationRateLimitTier?: string;
  /** Set instead of the organization tier on seats billed per user. */
  userRateLimitTier?: string;
}

async function readMetadata(configDir: string): Promise<OAuthAccountMetadata | undefined> {
  for (const candidate of metadataCandidates(configDir)) {
    try {
      const parsed = JSON.parse(await readFile(candidate, 'utf8')) as {
        oauthAccount?: OAuthAccountMetadata;
      };
      if (parsed.oauthAccount) return parsed.oauthAccount;
    } catch {
      // Missing or unreadable here just means "try the other layout".
    }
  }
  return undefined;
}

/** The account a profile is logged in as. */
export async function accountEmail(configDir: string): Promise<string | undefined> {
  return (await readMetadata(configDir))?.emailAddress;
}

/**
 * The plan a seat is on, e.g. "Max 20×".
 *
 * ⚠️ `userRateLimitTier` wins where it is set: a seat inside an organization
 * can be on a different tier from the organization itself, and the seat's own
 * tier is the one its windows are sized by.
 *
 * `organizationType` arrives as `claude_max`; `planLabel` expects the bare
 * plan, so the vendor prefix comes off here.
 */
export async function accountPlan(configDir: string): Promise<string | undefined> {
  const meta = await readMetadata(configDir);
  if (!meta) return undefined;
  return planLabel({
    rateLimitTier: meta.userRateLimitTier ?? meta.organizationRateLimitTier,
    subscriptionType: meta.organizationType?.replace(/^claude_/, ''),
  });
}
