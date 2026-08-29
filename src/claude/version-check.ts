import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { satisfies, coerce, lt } from 'semver';

/**
 * Common paths where Claude CLI might be installed.
 * These are checked if the binary isn't found in PATH.
 */
const COMMON_CLAUDE_PATHS: string[] = process.platform === 'win32'
  ? [
    // Windows: npm global installs create .cmd wrappers in the prefix directory
    ...(process.env.APPDATA ? [join(process.env.APPDATA, 'npm', 'claude.cmd')] : []),
    ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'npm', 'claude.cmd')] : []),
    // nvm-windows installs
    ...(process.env.NVM_SYMLINK ? [join(process.env.NVM_SYMLINK, 'claude.cmd')] : []),
    // bun global on Windows
    ...(process.env.USERPROFILE ? [join(process.env.USERPROFILE, '.bun', 'bin', 'claude.cmd')] : []),
  ]
  : [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    `${process.env.HOME}/.local/bin/claude`,
    `${process.env.HOME}/.npm-global/bin/claude`,
    `${process.env.HOME}/.bun/bin/claude`,
    // npm global on macOS
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
  ];

/**
 * Claude CLI version policy — three tiers, enforced by classifyClaudeVersion:
 *
 * - Below CLAUDE_CLI_MIN_VERSION → **incompatible, hard exit.** The bot
 *   genuinely can't work (no --permission-prompt-tool, wrong stream-json).
 * - Inside CLAUDE_CLI_VERIFIED_RANGE → **ok.** Tested against the real CLI.
 * - Same major, above the verified range → **untested, warn-and-run.** A new
 *   CLI minor must not take every bot down until a claude-threads release
 *   ships; the bot starts with a visible warning (startup, sticky message,
 *   session header) instead. When a new minor ships: run the e2e script +
 *   a live smoke, then bump the verified range's upper bound.
 * - A major above CLAUDE_CLI_SUPPORTED_MAJOR → **incompatible, hard exit.**
 *   A new major is a different contract; warn-and-run would be reckless.
 *
 * `--skip-version-check` bypasses the hard exits (not the warning).
 */
export const CLAUDE_CLI_MIN_VERSION = '2.0.74';
export const CLAUDE_CLI_VERIFIED_RANGE = '>=2.0.74 <2.2.0';
export const CLAUDE_CLI_SUPPORTED_MAJOR = 2;
/** Newest CLI version actually verified against; used in messages. */
export const CLAUDE_CLI_LATEST_VERIFIED = '2.1.251';

/**
 * Result of checking Claude CLI version.
 */
export interface ClaudeVersionResult {
  /** The parsed version string if found (e.g., "2.0.76") */
  version: string | null;
  /** Raw output from claude --version (for debugging) */
  rawOutput: string | null;
  /** Error message if command failed */
  error: string | null;
  /** The path that was used to find Claude */
  foundAt?: string;
}

/**
 * Try to run claude --version at a specific path.
 */
function tryClaudeVersion(claudePath: string): ClaudeVersionResult {
  try {
    const output = execSync(`"${claudePath}" --version`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // Try multiple patterns to extract version:
    // 1. "2.0.76 (Claude Code)" - standard npm install
    // 2. "Claude Code version 2.0.76"
    // 3. "v2.0.76" or just "2.0.76" anywhere in output
    // 4. Any semver-like version (X.Y.Z)
    const patterns = [
      /^([\d]+\.[\d]+\.[\d]+)/,           // Version at start
      /version\s+([\d]+\.[\d]+\.[\d]+)/i, // "version X.Y.Z"
      /v?([\d]+\.[\d]+\.[\d]+)/,          // Any X.Y.Z pattern
    ];

    for (const pattern of patterns) {
      const match = output.match(pattern);
      if (match) {
        return { version: match[1], rawOutput: output, error: null, foundAt: claudePath };
      }
    }

    // Claude found but couldn't parse version
    return { version: null, rawOutput: output, error: null, foundAt: claudePath };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    return { version: null, rawOutput: null, error: errorMessage };
  }
}

/**
 * Try to find where 'claude' is located using 'which' (Unix) or 'where' (Windows).
 * Returns the path or null if not found.
 */
function findClaudeInPath(): string | null {
  try {
    const findCommand = process.platform === 'win32' ? 'where claude' : 'which claude';
    const result = execSync(findCommand, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // 'where' on Windows may return multiple lines; use the first result
    const firstLine = result.split(/\r?\n/)[0];
    return firstLine || null;
  } catch {
    return null;
  }
}

/**
 * Get the installed Claude CLI version.
 * Returns version info including raw output for debugging.
 *
 * Tries multiple strategies:
 * 1. CLAUDE_PATH environment variable (if set)
 * 2. 'claude' in PATH (via 'which claude')
 * 3. 'claude' directly (in case which isn't available)
 * 4. Common installation locations
 *
 * Note: No logging here - this runs before UI starts.
 * Version info is displayed in the terminal Header component.
 */
export function getClaudeCliVersion(): ClaudeVersionResult {
  // First, try explicit CLAUDE_PATH if set
  if (process.env.CLAUDE_PATH) {
    const result = tryClaudeVersion(process.env.CLAUDE_PATH);
    if (!result.error) {
      return result;
    }
  }

  // Try to find claude using 'which' first (resolves symlinks)
  const whichResult = findClaudeInPath();
  if (whichResult) {
    const result = tryClaudeVersion(whichResult);
    if (!result.error) {
      return result;
    }
  }

  // Try 'claude' directly in PATH
  const pathResult = tryClaudeVersion('claude');
  if (!pathResult.error) {
    return pathResult;
  }

  // Try common installation locations
  for (const path of COMMON_CLAUDE_PATHS) {
    if (existsSync(path)) {
      const result = tryClaudeVersion(path);
      if (!result.error) {
        return result;
      }
    }
  }

  // None found - return the original error with helpful context
  const checkedPaths = process.env.CLAUDE_PATH
    ? [process.env.CLAUDE_PATH, 'claude (in PATH)', ...COMMON_CLAUDE_PATHS]
    : ['claude (in PATH)', ...COMMON_CLAUDE_PATHS];

  return {
    version: null,
    rawOutput: null,
    error: `Command 'claude' not found. Searched: ${checkedPaths.slice(0, 3).join(', ')}...`,
  };
}

/**
 * Where a CLI version falls in the policy (see the constants above).
 */
export type ClaudeVersionStatus = 'ok' | 'untested' | 'incompatible';

/**
 * Classify a CLI version against the version policy.
 * Pure function — the single source of truth for the three tiers.
 */
export function classifyClaudeVersion(version: string): ClaudeVersionStatus {
  const semverVersion = coerce(version);
  if (!semverVersion) return 'incompatible';
  if (lt(semverVersion, CLAUDE_CLI_MIN_VERSION)) return 'incompatible';
  if (semverVersion.major > CLAUDE_CLI_SUPPORTED_MAJOR) return 'incompatible';
  if (satisfies(semverVersion, CLAUDE_CLI_VERIFIED_RANGE)) return 'ok';
  // Same major, newer than anything verified: runs with a warning.
  return 'untested';
}

/**
 * Check if a version can run at all (verified or untested-but-same-major).
 * Untested versions are compatible in this sense — they start with a warning
 * rather than refusing to run; see the version policy above.
 */
export function isVersionCompatible(version: string): boolean {
  return classifyClaudeVersion(version) !== 'incompatible';
}

/**
 * Get the path to the Claude CLI executable.
 * Uses the same search logic as getClaudeCliVersion:
 * 1. CLAUDE_PATH environment variable
 * 2. 'which claude' result
 * 3. 'claude' directly in PATH
 * 4. Common installation locations
 *
 * Returns 'claude' as fallback if not found (will fail at spawn time with clearer error).
 */
/**
 * Memo for the DISCOVERED binary path. Discovery shells out synchronously
 * ('which claude', then --version probes of common install locations) —
 * acceptable once at startup, but getClaudePath() is now on hot paths
 * (every quickQuery: watch confirms, metadata suggestions, distillation),
 * so the discovery result is resolved once per process. The CLAUDE_PATH
 * env override is a plain read and intentionally NOT cached, so tests and
 * runtime overrides keep working.
 */
let discoveredClaudePath: string | null = null;

/** Test-only: clear the discovery memo (underscore convention, cf. _inFlightSessionStarts). */
export function _resetClaudePathCache(): void {
  discoveredClaudePath = null;
}

export function getClaudePath(): string {
  // First, check CLAUDE_PATH
  if (process.env.CLAUDE_PATH) {
    return process.env.CLAUDE_PATH;
  }

  if (discoveredClaudePath !== null) {
    return discoveredClaudePath;
  }

  // Try to find claude using 'which'
  const whichResult = findClaudeInPath();
  if (whichResult) {
    discoveredClaudePath = whichResult;
    return whichResult;
  }

  // Try common installation locations
  for (const path of COMMON_CLAUDE_PATHS) {
    if (existsSync(path)) {
      // Verify it's actually executable by trying to get version
      const result = tryClaudeVersion(path);
      if (!result.error) {
        discoveredClaudePath = path;
        return path;
      }
    }
  }

  // Fallback to 'claude' - will use PATH at spawn time. Deliberately NOT
  // cached: only a successful discovery is stable enough to memoize. A
  // failed probe can be transient (EAGAIN/EMFILE under load — exactly the
  // quickQuery-heavy moment this cache exists for), and caching the bare
  // fallback would pin a recoverable failure for the process lifetime on
  // hosts where the binary lives off PATH.
  return 'claude';
}

/**
 * Validation result from validateClaudeCli.
 */
export interface ClaudeValidationResult {
  installed: boolean;
  version: string | null;
  /** False only for the hard-exit tiers (below floor, new major, not found). */
  compatible: boolean;
  /** Policy tier; 'untested' means compatible-but-warn (see version policy). */
  status: ClaudeVersionStatus;
  message: string;
  /** Raw output from claude --version (for debugging) */
  rawOutput?: string;
  /** Error message if command failed */
  error?: string;
}

/**
 * Validate Claude CLI installation and version.
 * Returns an object with status and details.
 *
 * Note: No logging here - this runs before UI starts.
 * Errors are shown via console.error in main() if incompatible.
 */
export function validateClaudeCli(): ClaudeValidationResult {
  const result = getClaudeCliVersion();

  // Case 1: Command failed entirely (not found)
  if (result.error) {
    const claudePath = process.env.CLAUDE_PATH || 'claude';
    return {
      installed: false,
      version: null,
      compatible: false,
      status: 'incompatible',
      message: `Claude CLI not found at '${claudePath}'. Install it with: npm install -g @anthropic-ai/claude-code`,
      error: result.error,
    };
  }

  // Case 2: Command succeeded but couldn't parse version.
  // (Also the TypeScript-required fallback below case 3's guard.)
  if (!result.version) {
    return {
      installed: true,
      version: null,
      compatible: true, // Assume compatible - user can skip check if needed
      status: 'ok',
      message: `Claude CLI found (version unknown)`,
      rawOutput: result.rawOutput ?? undefined,
    };
  }

  // Case 3: Got a version — classify it against the policy.
  const status = classifyClaudeVersion(result.version);

  if (status === 'incompatible') {
    const semverVersion = coerce(result.version);
    const reason = semverVersion && semverVersion.major > CLAUDE_CLI_SUPPORTED_MAJOR
      ? `is a new major version (only ${CLAUDE_CLI_SUPPORTED_MAJOR}.x is supported)`
      : `is too old (minimum: ${CLAUDE_CLI_MIN_VERSION})`;
    return {
      installed: true,
      version: result.version,
      compatible: false,
      status,
      // Single line: callers wrap the whole message in one color/indent, so
      // an embedded newline would print its second line unindented.
      message: `Claude CLI version ${result.version} ${reason}. ` +
        `Install a verified version: npm install -g @anthropic-ai/claude-code@${CLAUDE_CLI_LATEST_VERIFIED}`,
      rawOutput: result.rawOutput ?? undefined,
    };
  }

  if (status === 'untested') {
    return {
      installed: true,
      version: result.version,
      compatible: true,
      status,
      message: `Claude CLI ${result.version} is newer than the latest verified version (${CLAUDE_CLI_LATEST_VERIFIED}) — untested, continuing anyway. ` +
        `Features may misbehave; pin a verified version with: npm install -g @anthropic-ai/claude-code@${CLAUDE_CLI_LATEST_VERIFIED}`,
      rawOutput: result.rawOutput ?? undefined,
    };
  }

  return {
    installed: true,
    version: result.version,
    compatible: true,
    status,
    message: `Claude CLI ${result.version} ✓`,
    rawOutput: result.rawOutput ?? undefined,
  };
}
