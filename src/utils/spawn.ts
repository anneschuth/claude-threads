/**
 * Cross-platform process spawning utilities.
 *
 * On Windows, Node.js `child_process.spawn()` cannot directly execute
 * shell scripts (bash, .sh) or extensionless scripts that rely on shebangs.
 * This module provides wrappers that add `shell: true` on Windows so
 * that cmd.exe handles script resolution (e.g., finding `.cmd` wrappers
 * created by npm/bun).
 *
 * For executables that are known to be real binaries (e.g., `git.exe`
 * on Windows), using `shell: true` is harmless but adds a small overhead.
 */

import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'child_process';
import type {
  SpawnOptions,
  SpawnOptionsWithoutStdio,
  SpawnOptionsWithStdioTuple,
  SpawnSyncOptions,
  ChildProcess,
  ChildProcessWithoutNullStreams,
  ChildProcessByStdio,
  SpawnSyncReturns,
  StdioPipe,
  StdioNull,
} from 'child_process';
import type { Writable, Readable } from 'stream';

const isWindows = process.platform === 'win32';

function addWindowsShell<T extends { shell?: boolean | string }>(options: T): T {
  if (isWindows && options.shell === undefined) {
    return { ...options, shell: true };
  }
  return options;
}

/**
 * Cross-platform spawn that works on Windows with shell scripts.
 *
 * On Windows, automatically adds `shell: true` so that cmd.exe can
 * resolve `.cmd` wrappers and handle extensionless scripts.
 *
 * Preserves Node.js type overloads so that callers get properly
 * typed stdout/stderr (e.g., non-null when stdio defaults to 'pipe').
 */
export function crossSpawn(
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe>,
): ChildProcessByStdio<Writable, Readable, Readable>;
export function crossSpawn(
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioNull>,
): ChildProcessByStdio<Writable, Readable, null>;
export function crossSpawn(
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptionsWithStdioTuple<StdioPipe, StdioNull, StdioPipe>,
): ChildProcessByStdio<Writable, null, Readable>;
export function crossSpawn(
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>,
): ChildProcessByStdio<null, Readable, Readable>;
export function crossSpawn(
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptionsWithStdioTuple<StdioPipe, StdioNull, StdioNull>,
): ChildProcessByStdio<Writable, null, null>;
export function crossSpawn(
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioNull>,
): ChildProcessByStdio<null, Readable, null>;
export function crossSpawn(
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptionsWithStdioTuple<StdioNull, StdioNull, StdioPipe>,
): ChildProcessByStdio<null, null, Readable>;
export function crossSpawn(
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptionsWithStdioTuple<StdioNull, StdioNull, StdioNull>,
): ChildProcessByStdio<null, null, null>;
export function crossSpawn(
  command: string,
  args: ReadonlyArray<string>,
  options?: SpawnOptionsWithoutStdio,
): ChildProcessWithoutNullStreams;
export function crossSpawn(
  command: string,
  args: ReadonlyArray<string>,
  options?: SpawnOptions,
): ChildProcess;
export function crossSpawn(
  command: string,
  args: ReadonlyArray<string>,
  options?: SpawnOptions,
): ChildProcess {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return nodeSpawn(command, args as string[], addWindowsShell(options ?? {}) as any);
}

/**
 * Cross-platform spawnSync that works on Windows with shell scripts.
 */
export function crossSpawnSync(
  command: string,
  args: ReadonlyArray<string>,
  options?: SpawnSyncOptions,
): SpawnSyncReturns<Buffer | string> {
  return nodeSpawnSync(command, args as string[], addWindowsShell(options ?? {}));
}
