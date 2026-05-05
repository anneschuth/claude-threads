/**
 * Self-respawn for the interactive-TTY update path.
 *
 * Background: when the bot is started directly in a terminal (no daemon
 * wrapper, no supervisor), a `!update` exits the process and there is
 * nothing to bring it back. The bash daemon (bin/claude-threads-daemon)
 * solves this for unattended deployments by catching exit code 42 and
 * re-execing, but that daemon strips the TTY from the child, so it is
 * deliberately skipped for interactive users (src/index.ts:154).
 *
 * The fix: have the bot respawn itself. Spawning the new `claude-threads`
 * binary with `{ detached: true, stdio: 'inherit' }`, then `unref()` and
 * `process.exit(0)`, hands the controlling terminal off to the new
 * process. The Node docs explicitly cover this combination: when stdio
 * is inherited, the detached child stays attached to the parent's TTY.
 *
 * `decideRespawn()` returns either:
 *   - `self-respawn`: the bot has a TTY and no detected supervisor.
 *     The caller resolves the binary on PATH (`resolveClaudeThreadsBin`)
 *     and runs `spawnReplacement`.
 *   - `exit-for-supervisor`: a known supervisor will handle the restart
 *     (bash daemon, pm2, systemd, or a wrapper signaled by
 *     `CLAUDE_THREADS_INTERACTIVE`). The caller exits with code 42 to
 *     trigger the supervisor's restart path.
 *   - `exit-for-supervisor` with `none-headless`: no supervisor and no
 *     TTY. The caller broadcasts a "please run claude-threads" message
 *     and exits 0; the user's invoker decides what to do next.
 *
 * If self-respawn is chosen but the binary cannot be resolved on PATH,
 * the caller falls through to the same "please run claude-threads"
 * broadcast as the headless case rather than disappearing silently.
 */

import { spawn } from 'child_process';
import { existsSync, statSync } from 'fs';
import { delimiter, join } from 'path';
import { createLogger } from '../utils/logger.js';

const log = createLogger('respawn');

/** Identifier for the supervisor that will handle the restart. */
export type SupervisorKind =
  | 'claude-threads-daemon'
  | 'systemd'
  | 'pm2'
  | 'wrapped-tty'
  | 'none-headless';

export type RespawnDecision =
  | { kind: 'self-respawn' }
  | { kind: 'exit-for-supervisor'; supervisor: SupervisorKind };

/**
 * Decide how to restart for an update.
 *
 * `env` is injectable so tests can drive the decision deterministically.
 * `isTTY` likewise: `process.stdout.isTTY` is `undefined` (not `false`)
 * in non-TTY contexts, so we coerce to boolean at the call site.
 */
export function decideRespawn(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = !!process.stdout.isTTY
): RespawnDecision {
  // Bash daemon (bin/claude-threads-daemon) sets this when it spawns us.
  // It already loops on exit code 42, so we should not double-restart.
  if (env.CLAUDE_THREADS_BIN) {
    return { kind: 'exit-for-supervisor', supervisor: 'claude-threads-daemon' };
  }

  // pm2 sets pm_id (numeric, 0+) when running under pm2. We also check
  // PM2_HOME as a corroborating signal, since pm_id is a common-ish var
  // name that another wrapper could conceivably set.
  if (env.pm_id !== undefined && env.PM2_HOME) {
    return { kind: 'exit-for-supervisor', supervisor: 'pm2' };
  }

  // systemd sets INVOCATION_ID for every unit invocation. Note: the
  // shipped service file (docs/systemd/claude-threads.service) goes
  // through the bash daemon, so most systemd users hit the daemon
  // branch above. This branch only fires when a user has wired
  // claude-threads directly under systemd's `Restart=on-failure`. We
  // still want systemd to do the restart in that case so its restart
  // counters and rate-limiting work as configured.
  if (env.INVOCATION_ID) {
    return { kind: 'exit-for-supervisor', supervisor: 'systemd' };
  }

  // CLAUDE_THREADS_INTERACTIVE was historically used by wrappers to
  // force TTY mode (PRs #299/#300/#312/#317). If a user is running
  // under such a wrapper, exit-42 lets the wrapper handle the restart
  // and we don't fight it for TTY ownership.
  if (env.CLAUDE_THREADS_INTERACTIVE) {
    return { kind: 'exit-for-supervisor', supervisor: 'wrapped-tty' };
  }

  // No supervisor: only self-respawn if we have a TTY worth preserving.
  // In a non-TTY headless context with no supervisor, exiting cleanly is
  // the right call: the user's invoker (script, nohup, etc.) gets to
  // decide what happens next.
  if (!isTTY) {
    return { kind: 'exit-for-supervisor', supervisor: 'none-headless' };
  }

  return { kind: 'self-respawn' };
}

/**
 * Resolve the absolute path to the `claude-threads` binary on PATH,
 * synchronously. Returns null if not found.
 *
 * Why synchronous and pre-spawn: `child_process.spawn` does NOT throw
 * on ENOENT. It returns a ChildProcess with `pid === undefined` and
 * fires the 'error' event asynchronously. By the time the error event
 * lands, the parent has already called `process.exit(0)` (verified on
 * Node 25 and Bun 1.3). So we must verify the binary exists before
 * the spawn call, not after.
 *
 * `which`/`where` would do this, but spawning a child to find a child
 * adds latency and one more failure mode. A direct PATH walk is fine.
 *
 * `_pathOverride` and `_existsSync` are injectable for tests.
 */
export function resolveClaudeThreadsBin(
  _env: NodeJS.ProcessEnv = process.env,
  _existsSync: (p: string) => boolean = existsSync,
  _isFileExecutable: (p: string) => boolean = isFileExecutable
): string | null {
  const isWin = process.platform === 'win32';
  const names = isWin
    ? ['claude-threads.cmd', 'claude-threads.exe', 'claude-threads.bat']
    : ['claude-threads'];

  const path = _env.PATH || _env.Path || '';
  const dirs = path.split(delimiter).filter(Boolean);

  // bun installs to ~/.bun/bin which is often missing from non-interactive
  // PATHs (cron, systemd without explicit PATH=, launchd). Add it as a
  // fallback so a bun-installed binary is still found there.
  // Honour `BUN_INSTALL` even without HOME, since some isolated services
  // set the former and not the latter.
  const home = _env.HOME || _env.USERPROFILE;
  const bunRoot = _env.BUN_INSTALL || (home ? join(home, '.bun') : null);
  if (bunRoot) {
    const bunBin = join(bunRoot, 'bin');
    if (!dirs.includes(bunBin)) {
      dirs.push(bunBin);
    }
  }

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (_existsSync(candidate) && _isFileExecutable(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function isFileExecutable(path: string): boolean {
  try {
    // statSync follows symlinks, so a symlinked binary (typical for
    // `bun install -g` and `npm install -g`) returns the target's mode.
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    // On Windows the executable bit is meaningless; rely on the .cmd/.exe
    // suffix matching done by the caller.
    if (process.platform === 'win32') return true;
    // Owner / group / other execute bit set.
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Spawn a fresh `claude-threads` process and detach so this process
 * can exit cleanly while the new one takes over the controlling
 * terminal. Re-passes the original argv (excluding node + script path).
 *
 * Returns true if the spawn was launched and the child got a pid.
 * The caller is then expected to call `process.exit(0)`.
 *
 * Returns false on any failure (binary not found, spawn rejected,
 * pid undefined). The caller should treat this as "auto-restart not
 * possible" and tell the user to restart manually.
 */
export function spawnReplacement(
  argv: string[] = process.argv.slice(2),
  binPath: string | null = resolveClaudeThreadsBin()
): boolean {
  if (!binPath) {
    log.error('Could not resolve claude-threads on PATH; self-respawn aborted');
    return false;
  }

  // Reset terminal state before handing off. Ink puts stdin in raw mode
  // and the parent's `prepareForRestart` does not always undo that;
  // leaving it in raw mode confuses the new process's stdin handling.
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    try { process.stdin.setRawMode(false); } catch { /* not fatal */ }
  }

  // Build a child env with the auto-restart hand-off vars stripped.
  // Note: setting a key to `undefined` in the spawn env is NOT reliably
  // omitted (Node omits, Bun passes the literal string "undefined" as
  // verified empirically). We delete instead.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.CLAUDE_THREADS_BIN;
  delete childEnv.CLAUDE_THREADS_INTERACTIVE;

  // On Windows, .cmd/.bat shims must be invoked via the shell since
  // Node 20.12.2 (CVE-2024-27980). On POSIX, shell:false is correct.
  const useShell = process.platform === 'win32';

  let child;
  try {
    child = spawn(binPath, argv, {
      detached: true,
      stdio: 'inherit',
      env: childEnv,
      shell: useShell,
    });
  } catch (err) {
    // spawn() rarely throws synchronously (only on argument validation
    // failures), but if it does we want to surface that.
    log.error(`spawn() threw: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  // Attach an error listener immediately so the async ENOENT (which fires
  // on the next tick when the binary doesn't exist) doesn't surface as an
  // uncaught exception. We've already exited by then in production, but
  // tests and short-lived processes still need this.
  child.once('error', (err: Error) => {
    log.error(`Replacement process error: ${err.message}`);
  });

  // pid === undefined means the spawn failed (typically ENOENT). The
  // 'error' event fires on the next tick, but we will have exited
  // before then, so check synchronously.
  if (child.pid === undefined) {
    log.error('Spawn returned no pid (binary likely not executable)');
    return false;
  }

  child.unref();
  log.info(`Spawned replacement pid=${child.pid} from ${binPath}`);
  return true;
}

