/**
 * Portable chmod for tests that need the SUID/SGID/sticky bits to actually land.
 *
 * Background: Bun 1.3.x masks the high mode bits at the syscall layer in
 * `fs.promises.chmod` / `fs.chmodSync` / `FileHandle.chmod`. After calling
 * `chmod(file, 0o4755)` the result is `0o755` — the SUID bit is silently
 * dropped. Verified 2026-05-05 against Bun 1.3.3.
 *
 * Tests that need to *exercise* SUID/SGID detection therefore can't use
 * `fs.chmod` and trust it under Bun. Node's `fs.chmod` works correctly.
 *
 * This helper:
 *   1. Tries `fs.chmod` (works on Node, may silently strip on Bun).
 *   2. Verifies the result via `fs.stat`.
 *   3. If the requested mode bits didn't land, shells out to `/bin/chmod`
 *      (which goes through the kernel directly, bypassing the runtime).
 *   4. If THAT also fails, throws so the test fails noisily — better a red
 *      test than a silent green that's testing nothing.
 *
 * Tests-only. Shelling out is not safe to do at runtime with caller-supplied
 * paths, but inside our own tests with our own `mkdtemp`'d paths it's fine.
 */

import { chmod, stat } from 'fs/promises';
import { execFileSync } from 'child_process';

/** Octal mode value (e.g. 0o4755). */
export type FileMode = number;

/**
 * Set `path` to `mode`, working around Bun's high-bit stripping.
 * Throws if neither the runtime chmod nor the shell fallback can land the
 * requested bits.
 */
export async function setMode(path: string, mode: FileMode): Promise<void> {
  // Step 1: try the runtime's chmod.
  await chmod(path, mode);
  let s = await stat(path);
  if ((s.mode & 0o7777) === (mode & 0o7777)) {
    return; // landed cleanly (Node, or Bun without high bits)
  }

  // Step 2: shell out as a last resort. Use the absolute octal form so we
  // don't depend on the symbolic parser of /bin/chmod.
  const octal = (mode & 0o7777).toString(8).padStart(4, '0');
  execFileSync('/bin/chmod', [octal, path]);
  s = await stat(path);
  if ((s.mode & 0o7777) !== (mode & 0o7777)) {
    throw new Error(
      `setMode(${path}, ${octal}) failed: stat shows ${(s.mode & 0o7777).toString(8)}. ` +
        `Runtime chmod is broken AND /bin/chmod did not stick — bailing rather than running a useless test.`,
    );
  }
}
