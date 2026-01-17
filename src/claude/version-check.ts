import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { satisfies, coerce } from 'semver';

/**
 * Common paths where Claude CLI might be installed.
 * These are checked if the binary isn't found in PATH.
 */
const COMMON_CLAUDE_PATHS = [
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
  `${process.env.HOME}/.local/bin/claude`,
  `${process.env.HOME}/.npm-global/bin/claude`,
  `${process.env.HOME}/.bun/bin/claude`,
  // npm global on macOS
  '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
];

/**
 * Known compatible Claude CLI version range.
 *
 * Update this when testing with new Claude CLI versions.
 * - MIN: Oldest version known to work
 * - MAX: Newest version known to work
 */
export const CLAUDE_CLI_VERSION_RANGE = '>=2.0.74 <2.2.0';

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
 * Try to find where 'claude' is located using 'which'.
 * Returns the path or null if not found.
 */
function findClaudeInPath(): string | null {
  try {
    const result = execSync('which claude', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return result || null;
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
 * Version info is displayed in the UI's ConfigSummary component.
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
 * Check if a version is compatible with claude-threads.
 */
export function isVersionCompatible(version: string): boolean {
  const semverVersion = coerce(version);
  if (!semverVersion) return false;

  return satisfies(semverVersion, CLAUDE_CLI_VERSION_RANGE);
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
export function getClaudePath(): string {
  // First, check CLAUDE_PATH
  if (process.env.CLAUDE_PATH) {
    return process.env.CLAUDE_PATH;
  }

  // Try to find claude using 'which'
  const whichResult = findClaudeInPath();
  if (whichResult) {
    return whichResult;
  }

  // Try common installation locations
  for (const path of COMMON_CLAUDE_PATHS) {
    if (existsSync(path)) {
      // Verify it's actually executable by trying to get version
      const result = tryClaudeVersion(path);
      if (!result.error) {
        return path;
      }
    }
  }

  // Fallback to 'claude' - will use PATH at spawn time
  return 'claude';
}

/**
 * Validation result from validateClaudeCli.
 */
export interface ClaudeValidationResult {
  installed: boolean;
  version: string | null;
  compatible: boolean;
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
      message: `Claude CLI not found at '${claudePath}'. Install it with: npm install -g @anthropic-ai/claude-code`,
      error: result.error,
    };
  }

  // Case 2: Command succeeded but couldn't parse version
  if (!result.version && result.rawOutput) {
    return {
      installed: true,
      version: null,
      compatible: true, // Assume compatible - user can skip check if needed
      message: `Claude CLI found (version unknown)`,
      rawOutput: result.rawOutput,
    };
  }

  // Case 3: Got a version, check compatibility
  // At this point, result.version must be defined:
  // - Case 1 returned if result.error was truthy
  // - Case 2 returned if result.version was falsy (with rawOutput)
  // So if we reach here, result.version is defined
  if (!result.version) {
    // This should never happen, but satisfies TypeScript
    return {
      installed: true,
      version: null,
      compatible: true,
      message: 'Claude CLI found (version unknown)',
      rawOutput: result.rawOutput ?? undefined,
    };
  }
  const compatible = isVersionCompatible(result.version);

  if (!compatible) {
    return {
      installed: true,
      version: result.version,
      compatible: false,
      message: `Claude CLI version ${result.version} is not compatible. Required: ${CLAUDE_CLI_VERSION_RANGE}\n` +
        `Install a compatible version: npm install -g @anthropic-ai/claude-code@2.1.1`,
      rawOutput: result.rawOutput ?? undefined,
    };
  }

  return {
    installed: true,
    version: result.version,
    compatible: true,
    message: `Claude CLI ${result.version} ✓`,
    rawOutput: result.rawOutput ?? undefined,
  };
}
