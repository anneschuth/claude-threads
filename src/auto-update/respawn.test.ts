import { describe, expect, it } from 'bun:test';
import {
  decideRespawn,
  resolveClaudeThreadsBin,
  spawnReplacement,
} from './respawn.js';

describe('auto-update/respawn', () => {
  describe('decideRespawn', () => {
    it('hands off to bash daemon when CLAUDE_THREADS_BIN is set', () => {
      const result = decideRespawn({ CLAUDE_THREADS_BIN: '/usr/bin/foo' }, true);
      expect(result).toEqual({ kind: 'exit-for-supervisor', supervisor: 'claude-threads-daemon' });
    });

    it('hands off to pm2 when both pm_id and PM2_HOME are set', () => {
      const result = decideRespawn({ pm_id: '0', PM2_HOME: '/home/x/.pm2' }, true);
      expect(result).toEqual({ kind: 'exit-for-supervisor', supervisor: 'pm2' });
    });

    it('does NOT detect pm2 if pm_id is set but PM2_HOME is missing', () => {
      // pm_id is a generic-enough name that another wrapper could set it;
      // require corroboration before assuming pm2 context.
      const result = decideRespawn({ pm_id: '0' }, true);
      expect(result).toEqual({ kind: 'self-respawn' });
    });

    it('hands off to systemd when INVOCATION_ID is set (no daemon)', () => {
      const result = decideRespawn({ INVOCATION_ID: 'abc123' }, true);
      expect(result).toEqual({ kind: 'exit-for-supervisor', supervisor: 'systemd' });
    });

    it('hands off to wrapped-tty when CLAUDE_THREADS_INTERACTIVE is set', () => {
      // Some external wrapper is managing the TTY for us; let it own the
      // restart so we do not fight it for terminal ownership.
      const result = decideRespawn({ CLAUDE_THREADS_INTERACTIVE: '1' }, true);
      expect(result).toEqual({ kind: 'exit-for-supervisor', supervisor: 'wrapped-tty' });
    });

    it('exits without respawning when there is no TTY and no supervisor', () => {
      const result = decideRespawn({}, false);
      expect(result).toEqual({ kind: 'exit-for-supervisor', supervisor: 'none-headless' });
    });

    it('self-respawns when there is a TTY and no supervisor', () => {
      const result = decideRespawn({}, true);
      expect(result).toEqual({ kind: 'self-respawn' });
    });

    it('prefers bash daemon detection over TTY check', () => {
      const result = decideRespawn({ CLAUDE_THREADS_BIN: '/x' }, true);
      expect(result.kind).toBe('exit-for-supervisor');
    });

    it('prefers systemd detection over TTY check', () => {
      const result = decideRespawn({ INVOCATION_ID: 'x' }, true);
      expect(result.kind).toBe('exit-for-supervisor');
    });

    it('checks supervisors in order: daemon > pm2 > systemd > wrapped-tty', () => {
      // All four set: bash daemon wins (closest wrapper).
      const result = decideRespawn(
        {
          CLAUDE_THREADS_BIN: '/x',
          pm_id: '0',
          PM2_HOME: '/p',
          INVOCATION_ID: 'y',
          CLAUDE_THREADS_INTERACTIVE: '1',
        },
        true
      );
      expect(result).toEqual({ kind: 'exit-for-supervisor', supervisor: 'claude-threads-daemon' });
    });

    it('treats unrelated env vars as no supervisor', () => {
      const result = decideRespawn(
        { PATH: '/usr/bin', HOME: '/home/x', LANG: 'en_US.UTF-8' },
        true
      );
      expect(result).toEqual({ kind: 'self-respawn' });
    });
  });

  describe('resolveClaudeThreadsBin', () => {
    it('returns null when binary is not on PATH', () => {
      const result = resolveClaudeThreadsBin(
        { PATH: '/nonexistent-dir' },
        () => false,
        () => false
      );
      expect(result).toBeNull();
    });

    it('returns the resolved path when found in PATH', () => {
      const fakeBin = '/usr/local/bin/claude-threads';
      const result = resolveClaudeThreadsBin(
        { PATH: '/usr/local/bin:/usr/bin' },
        (p) => p === fakeBin,
        (p) => p === fakeBin
      );
      expect(result).toBe(fakeBin);
    });

    it('skips PATH entries where the file is not executable', () => {
      // Even if the file exists, it must be marked executable.
      const result = resolveClaudeThreadsBin(
        { PATH: '/usr/local/bin' },
        () => true,
        () => false
      );
      expect(result).toBeNull();
    });

    it('falls back to ~/.bun/bin when PATH does not include it', () => {
      // bun installs to ~/.bun/bin which is often missing from cron /
      // systemd PATHs. The resolver should still find it.
      const home = '/home/anne';
      const bunBin = `${home}/.bun/bin/claude-threads`;
      const result = resolveClaudeThreadsBin(
        { PATH: '/usr/bin', HOME: home },
        (p) => p === bunBin,
        (p) => p === bunBin
      );
      expect(result).toBe(bunBin);
    });

    it('respects BUN_INSTALL override for bun bin location', () => {
      const customBunBin = '/opt/bun/bin/claude-threads';
      const result = resolveClaudeThreadsBin(
        { PATH: '/usr/bin', HOME: '/home/x', BUN_INSTALL: '/opt/bun' },
        (p) => p === customBunBin,
        (p) => p === customBunBin
      );
      expect(result).toBe(customBunBin);
    });

    it('honors BUN_INSTALL even without HOME (isolated services)', () => {
      // Some systemd / launchd setups clear HOME but set BUN_INSTALL
      // explicitly. The resolver should still find the bun-installed
      // binary in that case.
      const customBunBin = '/opt/bun/bin/claude-threads';
      const result = resolveClaudeThreadsBin(
        { PATH: '/usr/bin', BUN_INSTALL: '/opt/bun' },
        (p) => p === customBunBin,
        (p) => p === customBunBin
      );
      expect(result).toBe(customBunBin);
    });

    it('returns the first match when multiple PATH entries have the binary', () => {
      const first = '/usr/local/bin/claude-threads';
      const second = '/usr/bin/claude-threads';
      const result = resolveClaudeThreadsBin(
        { PATH: '/usr/local/bin:/usr/bin' },
        () => true,
        (p) => p === first || p === second
      );
      expect(result).toBe(first);
    });

    it('handles missing PATH gracefully', () => {
      const result = resolveClaudeThreadsBin(
        { HOME: '/home/x' },
        () => false,
        () => false
      );
      expect(result).toBeNull();
    });
  });

  describe('spawnReplacement', () => {
    it('returns false when binPath is null', () => {
      const result = spawnReplacement([], null);
      expect(result).toBe(false);
    });

    it('returns false when binary cannot be executed (ENOENT)', () => {
      // spawn() does NOT throw on ENOENT; it returns a child with
      // pid === undefined and fires 'error' on the next tick. The
      // synchronous pid check is what catches this.
      const result = spawnReplacement([], '/this/path/does/not/exist');
      expect(result).toBe(false);
    });

    it('returns true when spawning a real, executable binary', async () => {
      // Use the actual node/bun binary as a stand-in: it exists, is
      // executable, and `--version` exits cleanly.
      const result = spawnReplacement(['--version'], process.execPath);
      expect(result).toBe(true);
      // Give the child a moment so it doesn't show up as a zombie if
      // we're running the test under strict mode.
      await new Promise((r) => setTimeout(r, 50));
    });
  });
});
