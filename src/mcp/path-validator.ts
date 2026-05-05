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
