/**
 * Codex CLI discovery and version validation.
 *
 * Mirrors src/claude/version-check.ts for the OpenAI Codex CLI.
 * The codex app-server protocol evolves quickly across 0.14x releases,
 * so the compatible range is pinned tightly and should be bumped after
 * verifying the JSON-RPC method names against a new release.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { satisfies, coerce } from 'semver';

/**
 * Common paths where Codex CLI might be installed.
 * These are checked if the binary isn't found in PATH.
 */
const COMMON_CODEX_PATHS: string[] = process.platform === 'win32'
  ? [
    ...(process.env.APPDATA ? [join(process.env.APPDATA, 'npm', 'codex.cmd')] : []),
    ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'npm', 'codex.cmd')] : []),
    ...(process.env.USERPROFILE ? [join(process.env.USERPROFILE, '.bun', 'bin', 'codex.cmd')] : []),
  ]
  : [
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
    `${process.env.HOME}/.local/bin/codex`,
    `${process.env.HOME}/.npm-global/bin/codex`,
    `${process.env.HOME}/.bun/bin/codex`,
    `${process.env.HOME}/.cargo/bin/codex`,
  ];

/**
 * Known compatible Codex CLI version range.
 *
 * Verified against codex-cli 0.144.x (app-server thread/turn JSON-RPC surface).
 * Update after validating a new release: run `codex app-server` manually and
 * confirm the method names used in src/agents/codex/translator.ts still match.
 */
export const CODEX_CLI_VERSION_RANGE = '>=0.140.0 <0.150.0';

/**
 * Result of checking Codex CLI version.
 */
export interface CodexVersionResult {
  /** The parsed version string if found (e.g., "0.144.1") */
  version: string | null;
  /** Raw output from codex --version (for debugging) */
  rawOutput: string | null;
  /** Error message if command failed */
  error: string | null;
  /** The path that was used to find Codex */
  foundAt?: string;
}

/**
 * Try to run codex --version at a specific path.
 */
function tryCodexVersion(codexPath: string): CodexVersionResult {
  try {
    const output = execSync(`"${codexPath}" --version`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // Output looks like "codex-cli 0.144.1"
    const match = output.match(/v?([\d]+\.[\d]+\.[\d]+)/);
    if (match) {
      return { version: match[1], rawOutput: output, error: null, foundAt: codexPath };
    }

    // Codex found but couldn't parse version
    return { version: null, rawOutput: output, error: null, foundAt: codexPath };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    return { version: null, rawOutput: null, error: errorMessage };
  }
}

/**
 * Try to find where 'codex' is located using 'which' (Unix) or 'where' (Windows).
 */
function findCodexInPath(): string | null {
  try {
    const findCommand = process.platform === 'win32' ? 'where codex' : 'which codex';
    const result = execSync(findCommand, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const firstLine = result.split(/\r?\n/)[0];
    return firstLine || null;
  } catch {
    return null;
  }
}

/**
 * Get the installed Codex CLI version.
 *
 * Tries multiple strategies:
 * 1. CODEX_PATH environment variable (if set) — also how integration tests inject a mock
 * 2. Configured path (from config.yaml codex.path)
 * 3. 'codex' in PATH (via 'which codex')
 * 4. 'codex' directly
 * 5. Common installation locations
 */
export function getCodexCliVersion(configuredPath?: string): CodexVersionResult {
  if (process.env.CODEX_PATH) {
    const result = tryCodexVersion(process.env.CODEX_PATH);
    if (!result.error) {
      return result;
    }
  }

  if (configuredPath) {
    const result = tryCodexVersion(configuredPath);
    if (!result.error) {
      return result;
    }
  }

  const whichResult = findCodexInPath();
  if (whichResult) {
    const result = tryCodexVersion(whichResult);
    if (!result.error) {
      return result;
    }
  }

  const pathResult = tryCodexVersion('codex');
  if (!pathResult.error) {
    return pathResult;
  }

  for (const path of COMMON_CODEX_PATHS) {
    if (existsSync(path)) {
      const result = tryCodexVersion(path);
      if (!result.error) {
        return result;
      }
    }
  }

  const checkedPaths = process.env.CODEX_PATH
    ? [process.env.CODEX_PATH, 'codex (in PATH)', ...COMMON_CODEX_PATHS]
    : ['codex (in PATH)', ...COMMON_CODEX_PATHS];

  return {
    version: null,
    rawOutput: null,
    error: `Command 'codex' not found. Searched: ${checkedPaths.slice(0, 3).join(', ')}...`,
  };
}

/**
 * Check if a Codex version is compatible with claude-threads.
 */
export function isCodexVersionCompatible(version: string): boolean {
  const semverVersion = coerce(version);
  if (!semverVersion) return false;

  return satisfies(semverVersion, CODEX_CLI_VERSION_RANGE);
}

/**
 * Get the path to the Codex CLI executable.
 * Same search order as getCodexCliVersion; falls back to 'codex'
 * (which will fail at spawn time with a clearer error).
 */
export function getCodexPath(configuredPath?: string): string {
  if (process.env.CODEX_PATH) {
    return process.env.CODEX_PATH;
  }

  if (configuredPath) {
    return configuredPath;
  }

  const whichResult = findCodexInPath();
  if (whichResult) {
    return whichResult;
  }

  for (const path of COMMON_CODEX_PATHS) {
    if (existsSync(path)) {
      const result = tryCodexVersion(path);
      if (!result.error) {
        return path;
      }
    }
  }

  return 'codex';
}

/**
 * Validation result from validateCodexCli.
 */
export interface CodexValidationResult {
  installed: boolean;
  version: string | null;
  compatible: boolean;
  message: string;
  /** Raw output from codex --version (for debugging) */
  rawOutput?: string;
  /** Error message if command failed */
  error?: string;
}

/**
 * Validate Codex CLI installation and version.
 */
export function validateCodexCli(configuredPath?: string): CodexValidationResult {
  const result = getCodexCliVersion(configuredPath);

  if (result.error) {
    const codexPath = process.env.CODEX_PATH || configuredPath || 'codex';
    return {
      installed: false,
      version: null,
      compatible: false,
      message: `Codex CLI not found at '${codexPath}'. Install it with: npm install -g @openai/codex`,
      error: result.error,
    };
  }

  if (!result.version) {
    return {
      installed: true,
      version: null,
      compatible: true, // Assume compatible - user can skip check if needed
      message: `Codex CLI found (version unknown)`,
      rawOutput: result.rawOutput ?? undefined,
    };
  }

  const compatible = isCodexVersionCompatible(result.version);

  if (!compatible) {
    return {
      installed: true,
      version: result.version,
      compatible: false,
      message: `Codex CLI version ${result.version} is not compatible. Required: ${CODEX_CLI_VERSION_RANGE}\n` +
        `Install a compatible version: npm install -g @openai/codex`,
      rawOutput: result.rawOutput ?? undefined,
    };
  }

  return {
    installed: true,
    version: result.version,
    compatible: true,
    message: `Codex CLI ${result.version} ✓`,
    rawOutput: result.rawOutput ?? undefined,
  };
}
