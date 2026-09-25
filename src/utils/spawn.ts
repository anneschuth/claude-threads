/**
 * Cross-platform process spawning utilities.
 *
 * On Windows, Node.js `child_process.spawn()` cannot run the `.cmd` shims
 * npm and bun install (`claude.cmd`, `npm.cmd`) without a shell. Passing
 * `shell: true` is not the answer: Node then concatenates the arguments into
 * one cmd.exe command line without escaping them, so a `|` or `&` in any
 * argument (a system prompt, a user's message, MCP config JSON) is run as
 * shell syntax (#600). The `cross-spawn` package resolves the command through
 * PATH/PATHEXT, spawns real executables directly, and escapes arguments for
 * cmd.exe only when the target is a shim. Elsewhere it is plain spawn().
 */

import crossSpawnImpl from 'cross-spawn';
import { win32 as win32Path } from 'path';
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

/**
 * Cross-platform spawn that works on Windows with `.cmd` shims.
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
  return crossSpawnImpl(command, args as string[], (options ?? {}) as any);
}

/**
 * Cross-platform spawnSync that works on Windows with `.cmd` shims.
 */
export function crossSpawnSync(
  command: string,
  args: ReadonlyArray<string>,
  options?: SpawnSyncOptions,
): SpawnSyncReturns<Buffer | string> {
  return crossSpawnImpl.sync(command, args as string[], options ?? {});
}

/**
 * Find a Git for Windows bash.exe to run the auto-restart daemon script.
 *
 * `bash` on PATH is often the WSL launcher in System32 (or its WindowsApps
 * alias). That runs the script inside Linux, where the Windows paths we hand
 * it do not exist, so it fails with "No such file or directory" (#600).
 * Those entries are skipped. Returns null when no usable bash is found.
 */
export function findWindowsGitBash(
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): string | null {
  const systemRoot = (env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows').toLowerCase();
  const isWslLauncher = (dir: string): boolean => {
    const lower = dir.toLowerCase().replace(/[\\/]+$/, '');
    return lower.startsWith(`${systemRoot}\\system32`)
      || lower.startsWith(`${systemRoot}\\sysnative`)
      || lower.endsWith('\\windowsapps');
  };

  const pathDirs = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  const candidates = [
    ...pathDirs.filter((dir) => !isWslLauncher(dir)).map((dir) => win32Path.join(dir, 'bash.exe')),
    ...[env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']]
      .filter((dir): dir is string => Boolean(dir))
      .map((dir) => win32Path.join(dir, 'Git', 'bin', 'bash.exe')),
    ...(env.LOCALAPPDATA ? [win32Path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')] : []),
  ];
  return candidates.find((candidate) => exists(candidate)) ?? null;
}
