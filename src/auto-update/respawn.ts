/**
 * Self-respawn for the interactive-TTY update path.
 *
 * Background: when the bot is started directly in a terminal (no daemon
 * wrapper, no supervisor), a `!update` exits the process and there is
 * nothing to bring it back. The bash daemon (bin/claude-threads-daemon)
 * solves this for unattended deployments by catching exit code 42 and
 * re-execing — but that daemon strips the TTY from the child, so it is
 * deliberately skipped for interactive users (src/index.ts:154).
 *
 * The fix: have the bot respawn itself. Spawning the new `claude-threads`
 * binary with `{ detached: true, stdio: 'inherit' }` and then `unref()`
 * + `process.exit(0)` hands the controlling terminal off to the new
 * process. The Node docs explicitly cover this combination: when stdio
 * is inherited, the detached child stays attached to the parent's TTY.
 *
 * We only do this when:
 *   - the process has a TTY (otherwise there is no UI to preserve), and
 *   - the process is NOT running under a known supervisor that already
 *     handles exit code 42 (bash daemon, systemd, pm2). Those keep the
 *     existing exit-42 path so service files don't need changes.
 */

import { spawn } from 'child_process';
import { createLogger } from '../utils/logger.js';

const log = createLogger('respawn');

/** A supervisor was detected; rely on its exit-code-42 handling. */
export type RespawnDecision =
  | { kind: 'self-respawn' }
  | { kind: 'exit-for-supervisor'; supervisor: string };

/**
 * Decide how to restart for an update.
 *
 * `env` is injectable so tests can drive the decision deterministically.
 * `isTTY` likewise — `process.stdout.isTTY` is `undefined` (not `false`)
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

  // systemd sets INVOCATION_ID for every unit invocation. The shipped
  // service file (docs/systemd/claude-threads.service) uses the bash
  // daemon, but if a user has wired claude-threads directly under
  // `Restart=on-failure` we still want systemd to do the restart so its
  // restart counters and rate-limiting work as configured.
  if (env.INVOCATION_ID) {
    return { kind: 'exit-for-supervisor', supervisor: 'systemd' };
  }

  // pm2 sets pm_id (numeric, 0+) when running under pm2. Same logic:
  // pm2's autorestart should own the restart so its limits apply.
  if (env.pm_id !== undefined) {
    return { kind: 'exit-for-supervisor', supervisor: 'pm2' };
  }

  // No supervisor — only self-respawn if we have a TTY worth preserving.
  // In a non-TTY headless context with no supervisor, exiting cleanly is
  // the right call: the user's invoker (script, nohup, etc.) gets to
  // decide what happens next.
  if (!isTTY) {
    return { kind: 'exit-for-supervisor', supervisor: 'none-headless' };
  }

  return { kind: 'self-respawn' };
}

/**
 * Spawn a fresh `claude-threads` process and detach so this process
 * can exit cleanly while the new one takes over the controlling
 * terminal. Re-passes the original argv (excluding node + script path).
 *
 * Returns true if the spawn succeeded; the caller is then expected to
 * exit 0. On failure, returns false and the caller should fall back to
 * exit code 42 so any outer wrapper can react.
 */
export function spawnReplacement(argv: string[] = process.argv.slice(2)): boolean {
  // Spawn by name so PATH lookup resolves to the freshly installed
  // global binary (`npm install -g` / `bun install -g` updates the
  // symlink in the user's PATH). Re-execing the running file would
  // run the old code from before the install in dev setups.
  const command = process.platform === 'win32' ? 'claude-threads.cmd' : 'claude-threads';

  try {
    const child = spawn(command, argv, {
      detached: true,
      stdio: 'inherit',
      // Don't forward auto-restart-related env vars: the new process
      // should make its own startup decisions cleanly.
      env: {
        ...process.env,
        CLAUDE_THREADS_BIN: undefined,
        CLAUDE_THREADS_INTERACTIVE: undefined,
      } as NodeJS.ProcessEnv,
    });

    // unref() so this process's event loop doesn't wait for the child.
    child.unref();

    log.info(`Spawned replacement process pid=${child.pid}`);
    return true;
  } catch (err) {
    log.error(`Failed to spawn replacement: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
