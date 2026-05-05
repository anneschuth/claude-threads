import { describe, expect, it } from 'bun:test';
import { decideRespawn } from './respawn.js';

describe('auto-update/respawn', () => {
  describe('decideRespawn', () => {
    it('hands off to bash daemon when CLAUDE_THREADS_BIN is set', () => {
      const result = decideRespawn({ CLAUDE_THREADS_BIN: '/usr/bin/foo' }, true);
      expect(result).toEqual({ kind: 'exit-for-supervisor', supervisor: 'claude-threads-daemon' });
    });

    it('hands off to systemd when INVOCATION_ID is set', () => {
      const result = decideRespawn({ INVOCATION_ID: 'abc123' }, true);
      expect(result).toEqual({ kind: 'exit-for-supervisor', supervisor: 'systemd' });
    });

    it('hands off to pm2 when pm_id is set', () => {
      const result = decideRespawn({ pm_id: '0' }, true);
      expect(result).toEqual({ kind: 'exit-for-supervisor', supervisor: 'pm2' });
    });

    it('hands off to pm2 when pm_id is empty string (still defined)', () => {
      // pm2 always sets pm_id; even an empty string indicates pm2 context
      const result = decideRespawn({ pm_id: '' }, true);
      expect(result).toEqual({ kind: 'exit-for-supervisor', supervisor: 'pm2' });
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
      // CLAUDE_THREADS_BIN set + TTY → still hand off (daemon owns the loop)
      const result = decideRespawn({ CLAUDE_THREADS_BIN: '/x' }, true);
      expect(result.kind).toBe('exit-for-supervisor');
    });

    it('prefers systemd detection over TTY check', () => {
      const result = decideRespawn({ INVOCATION_ID: 'x' }, true);
      expect(result.kind).toBe('exit-for-supervisor');
    });

    it('checks supervisors in order: daemon > systemd > pm2', () => {
      // All three set: bash daemon wins, since it's the closest wrapper.
      const result = decideRespawn(
        { CLAUDE_THREADS_BIN: '/x', INVOCATION_ID: 'y', pm_id: '0' },
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
});
