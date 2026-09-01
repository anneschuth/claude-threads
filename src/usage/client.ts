/**
 * Reading Claude Code subscription quota for one or many local profiles.
 *
 * Claude Code isolates seats by `CLAUDE_CONFIG_DIR`, so a machine running work
 * and personal seats — or a bot seat beside a human one — has several. This
 * module finds them, reads each one's OAuth token from wherever that platform
 * keeps it, and asks the usage endpoint.
 */

import { createHash } from 'crypto';
import { readFile, readdir, stat, writeFile } from 'fs/promises';
import { execFile } from 'child_process';
import { homedir, platform } from 'os';
import path from 'path';
import { promisify } from 'util';
import { createLogger } from '../utils/logger.js';
import type { UsageLimit, UsageLimitKind } from './render.js';

const log = createLogger('usage');
const execFileAsync = promisify(execFile);

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/**
 * ⚠️ Both headers are required. Without them the endpoint answers 429 rather
 * than 401, which reads like a rate limit and sends you looking in the wrong
 * place entirely.
 */
const OAUTH_BETA = 'oauth-2025-04-20';

/**
 * Refresh endpoint, client id and default scopes, read out of the Claude Code
 * client itself (`TOKEN_URL` / `CLIENT_ID` in its bundled config) rather than
 * guessed — the bundle also carries a Claude Design client id and a staging
 * block, which are the wrong ones.
 */
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const DEFAULT_SCOPES = [
  'user:inference',
  'user:profile',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
];

const KNOWN_KINDS: UsageLimitKind[] = ['session', 'weekly_all', 'weekly_scoped'];

export interface Profile {
  name: string;
  configDir: string;
}

interface RawLimit {
  kind?: string;
  percent?: number;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string | null } | null } | null;
}

/** `~/.claude` → "default", `~/.claude-vvs` → "vvs". */
export function profileNameFor(configDir: string): string {
  const base = path.basename(configDir.replace(/\/+$/, ''));
  return base === '.claude' ? 'default' : base.replace(/^\.claude-/, '');
}

/**
 * macOS keeps each profile's credentials in its own generic-password item,
 * suffixed with the first 8 hex chars of sha256 over the config-dir path. The
 * default profile uses the unsuffixed name.
 */
export function keychainAccountFor(configDir: string): string {
  const dir = configDir.replace(/\/+$/, '');
  if (path.basename(dir) === '.claude') return 'Claude Code-credentials';
  const hash = createHash('sha256').update(dir).digest('hex').slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

/**
 * Normalize the `limits[]` array. Everything else in the payload — the
 * top-level `five_hour`/`seven_day` pair and a rotating cast of codename
 * buckets (`tangelo`, `iguana_necktie`, `nimbus_quill`, …) — is internal and
 * mostly null; depending on it would rot.
 */
export function parseLimits(payload: unknown): UsageLimit[] {
  const raw = (payload as { limits?: RawLimit[] } | null)?.limits;
  if (!Array.isArray(raw)) {
    throw new Error(
      'usage payload has no limits[] array — the endpoint contract changed, refusing to guess'
    );
  }

  const limits: UsageLimit[] = [];
  for (const entry of raw) {
    const kind = entry.kind as UsageLimitKind | undefined;
    if (!kind || !KNOWN_KINDS.includes(kind)) continue;

    if (!entry.resets_at) continue;
    const resetsAt = new Date(entry.resets_at);
    if (Number.isNaN(resetsAt.getTime())) continue;

    limits.push({
      kind,
      percent: typeof entry.percent === 'number' ? entry.percent : 0,
      resetsAt,
      model: entry.scope?.model?.display_name ?? undefined,
    });
  }
  return limits;
}

/** Files/dirs Claude Code writes into a profile but a bot config dir will not have. */
const PROFILE_MARKERS = ['history.jsonl', '.claude.json', '.credentials.json', 'projects'];

async function looksLikeProfile(configDir: string): Promise<boolean> {
  const found = await Promise.all(
    PROFILE_MARKERS.map((marker) =>
      stat(path.join(configDir, marker))
        .then(() => true)
        .catch(() => false)
    )
  );
  return found.some(Boolean);
}

/** Every `~/.claude*` directory that actually holds a Claude Code config. */
export async function discoverProfiles(home = homedir()): Promise<Profile[]> {
  const entries = await readdir(home, { withFileTypes: true });
  const profiles: Profile[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== '.claude' && !entry.name.startsWith('.claude-')) continue;

    const configDir = path.join(home, entry.name);
    // The `.claude-` prefix alone proves nothing: claude-threads keeps its own
    // bot config in `~/.claude-threads`, which is not a seat and produced a
    // spurious "could not read usage" row. Require a marker Claude Code
    // actually writes into a profile.
    //
    // Deliberately not "has credentials": a logged-out seat is still a seat,
    // and it should be reported as unreadable rather than vanish.
    if (!(await looksLikeProfile(configDir))) continue;

    profiles.push({ name: profileNameFor(configDir), configDir });
  }

  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

/** Raw credentials blob for one profile: Keychain on macOS, file on Linux. */
async function readCredentialsBlob(configDir: string): Promise<string> {
  if (platform() === 'darwin') {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      keychainAccountFor(configDir),
      '-w',
    ]);
    return stdout;
  }
  return readFile(path.join(configDir, '.credentials.json'), 'utf8');
}

async function writeCredentialsBlob(configDir: string, blob: string): Promise<void> {
  if (platform() === 'darwin') {
    // -U updates the existing item rather than adding a duplicate.
    await execFileAsync('security', [
      'add-generic-password',
      '-U',
      '-s',
      keychainAccountFor(configDir),
      '-a',
      keychainAccountFor(configDir),
      '-w',
      blob,
    ]);
    return;
  }
  await writeFile(path.join(configDir, '.credentials.json'), blob, { mode: 0o600 });
}

export async function readCredentials(configDir: string): Promise<OAuthCredentials> {
  const parsed = JSON.parse(await readCredentialsBlob(configDir)) as {
    claudeAiOauth?: OAuthCredentials;
  };
  if (!parsed?.claudeAiOauth) {
    throw new Error('credentials found but they carry no OAuth block');
  }
  return parsed.claudeAiOauth;
}

/** The account a profile is logged in as, for the "go log in" message. */
export async function accountEmail(configDir: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.join(configDir, '.claude.json'), 'utf8')) as {
      oauthAccount?: { emailAddress?: string };
    };
    return parsed.oauthAccount?.emailAddress;
  } catch {
    return undefined;
  }
}

/**
 * Exchange the refresh token for a new access token.
 *
 * ⚠️ Anthropic ROTATES the refresh token: the response carries a new one and
 * the old one dies. So the result must be persisted — dropping it would log
 * the profile out, which is worse than the stale reading we came to fix.
 *
 * Endpoint, client id and body shape are read from the Claude Code client
 * itself, not guessed.
 */
export async function refreshCredentials(creds: OAuthCredentials): Promise<OAuthCredentials> {
  if (!creds.refreshToken) throw new Error('no refresh token to refresh with');

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: CLIENT_ID,
      scope: (creds.scopes ?? DEFAULT_SCOPES).join(' '),
    }),
  });

  if (!response.ok) {
    throw new Error(
      `token refresh returned ${response.status} ${response.statusText} — the refresh token is likely dead, log in again`
    );
  }

  const body = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
  };
  if (!body.access_token) {
    throw new Error('token refresh succeeded but returned no access_token');
  }

  const now = Date.now();
  return {
    ...creds,
    accessToken: body.access_token,
    // Keep the old refresh token only if the response withheld a new one.
    refreshToken: body.refresh_token ?? creds.refreshToken,
    expiresAt: body.expires_in ? now + body.expires_in * 1000 : undefined,
    refreshTokenExpiresAt: body.refresh_token_expires_in
      ? now + body.refresh_token_expires_in * 1000
      : creds.refreshTokenExpiresAt,
  };
}

/**
 * A usable access token for one profile, refreshing when that is all it takes.
 *
 * Stale-but-refreshable is the normal state of every profile nobody ran today,
 * so it is handled silently. A human is only asked to do something when the
 * refresh token is gone too.
 */
export async function resolveToken(configDir: string): Promise<string> {
  const creds = await readCredentials(configDir);

  switch (credentialState(creds, new Date())) {
    case 'fresh':
      if (!creds.accessToken) throw new Error('credentials carry no OAuth access token');
      return creds.accessToken;

    case 'refreshable': {
      const refreshed = await refreshCredentials(creds);
      await writeCredentialsBlob(configDir, JSON.stringify({ claudeAiOauth: refreshed }));
      log.info(`refreshed access token for ${profileNameFor(configDir)}`);
      return refreshed.accessToken as string;
    }

    case 'logged_out': {
      const email = await accountEmail(configDir);
      const who = email ? ` as ${email}` : '';
      throw new Error(
        `logged out — run \`claude\` in ${profileNameFor(configDir)} and log in${who}`
      );
    }
  }
}

/**
 * Pull the access token out of a credentials blob, refusing a stale one.
 * Callers that can refresh should use `credentialState` first.
 */
export function parseCredentials(blob: string, now: Date): string {
  const oauth = (
    JSON.parse(blob) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } }
  )?.claudeAiOauth;

  if (!oauth?.accessToken) {
    throw new Error('credentials found but they carry no OAuth access token');
  }

  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt < now.getTime()) {
    const hours = Math.round((now.getTime() - oauth.expiresAt) / 3_600_000);
    throw new Error(
      `access token expired ${hours}h ago — run \`claude\` in that profile to refresh it`
    );
  }

  return oauth.accessToken;
}

export interface OAuthCredentials {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  scopes?: string[];
}

export type CredentialState = 'fresh' | 'refreshable' | 'logged_out';

/**
 * Access tokens live about eight hours, so every profile nobody ran today is
 * stale — that is the normal state for all but the seat in active use, not an
 * error. Refresh tokens last weeks, so stale almost always means refreshable
 * and no human is needed. Only when the refresh token is gone too does someone
 * actually have to log in.
 */
export function credentialState(creds: OAuthCredentials, now: Date): CredentialState {
  const accessValid =
    typeof creds.expiresAt !== 'number' || creds.expiresAt > now.getTime();
  if (accessValid) return 'fresh';

  if (!creds.refreshToken) return 'logged_out';

  // No refresh expiry recorded → assume it is good and let the endpoint say
  // otherwise; guessing "logged out" would send someone to a browser they did
  // not need.
  const refreshValid =
    typeof creds.refreshTokenExpiresAt !== 'number' ||
    creds.refreshTokenExpiresAt > now.getTime();

  return refreshValid ? 'refreshable' : 'logged_out';
}

/** Ask the usage endpoint for one token. */
export async function fetchUsage(token: string, claudeVersion: string): Promise<UsageLimit[]> {
  const response = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': `claude-code/${claudeVersion}`,
      'anthropic-beta': OAUTH_BETA,
    },
  });

  if (!response.ok) {
    throw new Error(`usage endpoint returned ${response.status} ${response.statusText}`);
  }

  return parseLimits(await response.json());
}

/** Best-effort local Claude Code version for the User-Agent. */
export async function claudeVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('claude', ['--version']);
    return stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? 'unknown';
  } catch (err) {
    log.debug(`could not read claude --version: ${err}`);
    return 'unknown';
  }
}
