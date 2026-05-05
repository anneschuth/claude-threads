import { lstat, realpath, stat } from 'fs/promises';
import { sep, isAbsolute } from 'path';
import { sanitizeFilename, formatBytes } from '../utils/safe-filename.js';

export interface ValidatedPath {
  ok: true;
  /** Path with all symlinks resolved. Use this for the actual read. */
  resolvedPath: string;
  size: number;
  /** Sanitized basename safe to send back to Claude or pass to upload APIs. */
  basename: string;
}

export interface RejectedPath {
  ok: false;
  reason: string;
}

export type PathValidationResult = ValidatedPath | RejectedPath;

export interface PathValidatorOptions {
  /**
   * Absolute paths the file must (after symlink resolution) sit inside.
   * The session working directory and the per-session upload directory.
   */
  allowedRoots: string[];
  /** Per-file byte cap. Must be a positive finite integer. */
  maxBytes: number;
}

/**
 * Ensure a needle path lives under one of the haystack roots. Both inputs
 * must be absolute. The check is path-prefix, not string-prefix, so
 * `/srv/sessions-evil` does not match `/srv/sessions`.
 */
function isUnderRoot(needle: string, root: string): boolean {
  if (needle === root) return true;
  const withSep = root.endsWith(sep) ? root : root + sep;
  return needle.startsWith(withSep);
}

/**
 * Roots so wide that allowing `send_file` against them would let Claude
 * read essentially anything the bot can read. We refuse the validator
 * outright if any allowed root matches one of these — better a hard error
 * than a silent over-share. Compared after `realpath()` resolution.
 *
 * Dangerously wide:
 *   - `/`               — entire filesystem
 *   - `/home`, `/Users` — every user's home
 *   - `/root`           — root's home
 *   - `/etc`            — system config and credentials
 *   - `/var`            — logs, mail, run state, /var/lib/*
 *   - `/tmp`            — every other process's scratch space
 *   - `/usr`            — system binaries and libraries
 *
 * Note: a session whose working dir is e.g. `/home/anne/proj` is fine —
 * only the root itself triggers. Per-session upload dirs sit under
 * `/tmp/claude-threads-uploads/<id>/...` which is several segments deeper
 * than `/tmp` and so passes.
 */
const DANGEROUSLY_WIDE_ROOTS = new Set([
  '/',
  '/home',
  '/Users',
  '/root',
  '/etc',
  '/var',
  '/tmp',
  '/usr',
  '/opt',
]);

function isDangerouslyWide(root: string): boolean {
  if (DANGEROUSLY_WIDE_ROOTS.has(root)) return true;
  // On macOS /tmp resolves to /private/tmp; cover the resolved form too.
  if (root === '/private/tmp' || root === '/private/var' || root === '/private/etc') return true;
  return false;
}

/**
 * Validate that a caller-supplied absolute path is safe to upload.
 *
 * Rejection branches:
 *   - not absolute
 *   - resolved path escapes the allowed roots (covers symlink traversal)
 *   - non-regular file (FIFO, socket, device, directory)
 *   - SUID/SGID bit set
 *   - size > maxBytes
 *   - size === 0 (Slack rejects zero-length uploads)
 *
 * Returns a tagged result; callers pass `reason` verbatim back to Claude.
 */
export async function validateOutboundPath(
  inputPath: string,
  opts: PathValidatorOptions,
): Promise<PathValidationResult> {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    return { ok: false, reason: 'path is required' };
  }
  if (!isAbsolute(inputPath)) {
    return { ok: false, reason: 'path must be absolute' };
  }

  // Validate maxBytes — a negative or zero value would make every file
  // "too large" with no clue why. Better to fail loud at the validator.
  if (!Number.isFinite(opts.maxBytes) || opts.maxBytes <= 0) {
    return {
      ok: false,
      reason: `invalid maxBytes ${opts.maxBytes} — check outboundFiles.maxBytes configuration`,
    };
  }

  // Refuse dangerously wide allowedRoots before doing any FS work. A
  // misconfigured SESSION_WORKING_DIR=/ or =/home would otherwise let
  // send_file leak any file the bot process can read. Hard-fail loudly
  // rather than silently widen the trust boundary.
  for (const root of opts.allowedRoots) {
    if (isDangerouslyWide(root)) {
      return {
        ok: false,
        reason: `refusing to validate against dangerously wide allowed root '${root}' — check SESSION_WORKING_DIR configuration`,
      };
    }
  }

  let resolvedPath: string;
  try {
    resolvedPath = await realpath(inputPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `cannot resolve path: ${msg}` };
  }

  const inAllowedRoot = opts.allowedRoots.some(root => isUnderRoot(resolvedPath, root));
  if (!inAllowedRoot) {
    return {
      ok: false,
      reason:
        'path is outside the session working directory. Move the file into the working directory and retry.',
    };
  }

  // lstat the original (pre-realpath) too — defense in depth against odd
  // intermediate components like FIFO mounts that realpath might happily
  // resolve through. fs.stat (follows links) for the regular-file + size
  // checks against the resolved target.
  let lstatPre, statResolved;
  try {
    lstatPre = await lstat(inputPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `cannot stat path: ${msg}` };
  }
  try {
    statResolved = await stat(resolvedPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `cannot stat resolved path: ${msg}` };
  }

  // Refuse anything that isn't a plain file. Sockets, FIFOs, block/char
  // devices and directories all fail this check.
  if (!statResolved.isFile()) {
    return { ok: false, reason: 'not a regular file' };
  }
  // Refuse pre-realpath links to non-files too (a link to a directory etc.).
  if (!lstatPre.isFile() && !lstatPre.isSymbolicLink()) {
    return { ok: false, reason: 'not a regular file' };
  }

  // Defense in depth: refuse SUID/SGID files. Nothing legitimate uploads
  // these and they're a smell on a path-traversal exploit.
  const SUID = 0o4000;
  const SGID = 0o2000;
  if ((statResolved.mode & SUID) || (statResolved.mode & SGID)) {
    return { ok: false, reason: 'refusing to upload SUID/SGID file' };
  }

  if (statResolved.size === 0) {
    return { ok: false, reason: 'file is empty' };
  }
  if (statResolved.size > opts.maxBytes) {
    return {
      ok: false,
      reason: `file too large (${formatBytes(statResolved.size)} > ${formatBytes(opts.maxBytes)} limit)`,
    };
  }

  return {
    ok: true,
    resolvedPath,
    size: statResolved.size,
    basename: sanitizeFilename(resolvedPath),
  };
}
