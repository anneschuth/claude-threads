import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as childProcess from 'child_process';
import {
  isVersionCompatible,
  classifyClaudeVersion,
  CLAUDE_CLI_MIN_VERSION,
  CLAUDE_CLI_VERIFIED_RANGE,
  CLAUDE_CLI_SUPPORTED_MAJOR,
  validateClaudeCli,
  getClaudeCliVersion,
  getClaudePath, _resetClaudePathCache } from './version-check.js';

describe('version-check', () => {
  describe('version policy constants', () => {
    it('are defined and consistent', () => {
      expect(typeof CLAUDE_CLI_MIN_VERSION).toBe('string');
      expect(typeof CLAUDE_CLI_VERIFIED_RANGE).toBe('string');
      expect(typeof CLAUDE_CLI_SUPPORTED_MAJOR).toBe('number');
      // The verified range must start at the hard floor and stay within the
      // supported major — the policy is floor ≤ verified ⊂ major.
      expect(CLAUDE_CLI_VERIFIED_RANGE).toContain(CLAUDE_CLI_MIN_VERSION);
      expect(CLAUDE_CLI_MIN_VERSION.startsWith(`${CLAUDE_CLI_SUPPORTED_MAJOR}.`)).toBe(true);
    });
  });

  describe('classifyClaudeVersion', () => {
    it('classifies verified versions as ok', () => {
      expect(classifyClaudeVersion('2.0.74')).toBe('ok');
      expect(classifyClaudeVersion('2.1.0')).toBe('ok');
      expect(classifyClaudeVersion('2.1.99')).toBe('ok');
      expect(classifyClaudeVersion('2.1.223')).toBe('ok');
    });

    it('classifies newer same-major versions as untested (warn-and-run)', () => {
      expect(classifyClaudeVersion('2.2.0')).toBe('untested');
      expect(classifyClaudeVersion('2.3.1')).toBe('untested');
      expect(classifyClaudeVersion('2.99.99')).toBe('untested');
    });

    it('classifies versions below the hard floor as incompatible', () => {
      expect(classifyClaudeVersion('2.0.73')).toBe('incompatible');
      expect(classifyClaudeVersion('1.0.17')).toBe('incompatible');
    });

    it('classifies new majors as incompatible (hard exit)', () => {
      expect(classifyClaudeVersion('3.0.0')).toBe('incompatible');
      expect(classifyClaudeVersion('4.1.2')).toBe('incompatible');
    });

    it('classifies unparseable versions as incompatible', () => {
      expect(classifyClaudeVersion('')).toBe('incompatible');
      expect(classifyClaudeVersion('invalid')).toBe('incompatible');
    });
  });

  describe('isVersionCompatible', () => {
    it('returns true for verified versions', () => {
      expect(isVersionCompatible('2.0.74')).toBe(true);
      expect(isVersionCompatible('2.0.75')).toBe(true);
      expect(isVersionCompatible('2.0.76')).toBe(true);
      expect(isVersionCompatible('2.1.0')).toBe(true);
      expect(isVersionCompatible('2.1.1')).toBe(true);
      expect(isVersionCompatible('2.1.2')).toBe(true);
      expect(isVersionCompatible('2.1.99')).toBe(true);
    });

    it('returns true for untested same-major versions (they run with a warning)', () => {
      expect(isVersionCompatible('2.2.0')).toBe(true);
      expect(isVersionCompatible('2.5.0')).toBe(true);
    });

    it('returns false below the floor and on new majors', () => {
      expect(isVersionCompatible('2.0.73')).toBe(false);
      expect(isVersionCompatible('3.0.0')).toBe(false);
      expect(isVersionCompatible('1.0.17')).toBe(false);
    });

    it('handles invalid version strings', () => {
      expect(isVersionCompatible('')).toBe(false);
      expect(isVersionCompatible('invalid')).toBe(false);
    });
  });

  describe('getClaudeCliVersion', () => {
    let execSyncSpy: ReturnType<typeof spyOn>;
    const originalClaudePath = process.env.CLAUDE_PATH;

    beforeEach(() => {
      delete process.env.CLAUDE_PATH;
    });

    afterEach(() => {
      if (originalClaudePath !== undefined) {
        process.env.CLAUDE_PATH = originalClaudePath;
      } else {
        delete process.env.CLAUDE_PATH;
      }
      execSyncSpy?.mockRestore();
    });

    it('returns version from claude --version output', () => {
      execSyncSpy = spyOn(childProcess, 'execSync').mockReturnValue('2.0.76 (Claude Code)\n');

      const result = getClaudeCliVersion();
      expect(result.version).toBe('2.0.76');
      expect(result.rawOutput).toBe('2.0.76 (Claude Code)');
      expect(result.error).toBeNull();
    });

    it('handles version-only output format', () => {
      execSyncSpy = spyOn(childProcess, 'execSync').mockReturnValue('2.0.75\n');

      const result = getClaudeCliVersion();
      expect(result.version).toBe('2.0.75');
      expect(result.error).toBeNull();
    });

    it('returns error info when execSync throws for all paths', () => {
      execSyncSpy = spyOn(childProcess, 'execSync').mockImplementation(() => {
        throw new Error('Command not found');
      });

      const result = getClaudeCliVersion();
      expect(result.version).toBeNull();
      expect(result.error).toBeTruthy();
      expect(result.error).toContain('not found');
    });

    it('returns version null with rawOutput when output does not match version pattern', () => {
      execSyncSpy = spyOn(childProcess, 'execSync').mockReturnValue('not a version\n');

      const result = getClaudeCliVersion();
      expect(result.version).toBeNull();
      expect(result.rawOutput).toBe('not a version');
      expect(result.error).toBeNull();
    });

    it('uses CLAUDE_PATH environment variable when set', () => {
      process.env.CLAUDE_PATH = '/custom/path/claude';
      execSyncSpy = spyOn(childProcess, 'execSync').mockReturnValue('2.0.76\n');

      getClaudeCliVersion();

      // First call should be with CLAUDE_PATH (quoted for paths with spaces)
      expect(execSyncSpy).toHaveBeenCalledWith(
        '"/custom/path/claude" --version',
        expect.any(Object)
      );
    });
  });

  describe('getClaudePath', () => {
    let execSyncSpy: ReturnType<typeof spyOn>;
    const originalClaudePath = process.env.CLAUDE_PATH;

    beforeEach(() => {
      _resetClaudePathCache();
      delete process.env.CLAUDE_PATH;
    });

    afterEach(() => {
      if (originalClaudePath !== undefined) {
        process.env.CLAUDE_PATH = originalClaudePath;
      } else {
        delete process.env.CLAUDE_PATH;
      }
      execSyncSpy?.mockRestore();
    });

    it('returns CLAUDE_PATH when set', () => {
      process.env.CLAUDE_PATH = '/custom/path/to/claude';
      const path = getClaudePath();
      expect(path).toBe('/custom/path/to/claude');
    });

    it('returns "claude" as fallback when not found', () => {
      execSyncSpy = spyOn(childProcess, 'execSync').mockImplementation(() => {
        throw new Error('Command not found');
      });

      const path = getClaudePath();
      expect(path).toBe('claude');
    });

    it('returns path from "which claude" when available', () => {
      execSyncSpy = spyOn(childProcess, 'execSync').mockImplementation(((cmd: string) => {
        if (cmd === 'which claude') {
          return '/usr/local/bin/claude\n';
        }
        // For the version check that follows
        return '2.0.76\n';
      }) as typeof childProcess.execSync);

      const path = getClaudePath();
      expect(path).toBe('/usr/local/bin/claude');
    });

    it('memoizes a successful discovery, but never the fallback', () => {
      // A failed probe can be transient (EAGAIN under load). Caching the
      // bare 'claude' fallback would pin that failure for the process
      // lifetime — the next call must re-probe and pick up the recovery.
      let discoveryWorks = false;
      execSyncSpy = spyOn(childProcess, 'execSync').mockImplementation(((cmd: string) => {
        if (!discoveryWorks) throw new Error('EAGAIN');
        if (cmd === 'which claude') return '/usr/local/bin/claude\n';
        return '2.0.76\n';
      }) as typeof childProcess.execSync);

      expect(getClaudePath()).toBe('claude');
      discoveryWorks = true;
      expect(getClaudePath()).toBe('/usr/local/bin/claude');

      // Successful discovery IS memoized: breaking `which` again must not
      // affect subsequent calls.
      discoveryWorks = false;
      expect(getClaudePath()).toBe('/usr/local/bin/claude');
    });
  });

  describe('validateClaudeCli', () => {
    let execSyncSpy: ReturnType<typeof spyOn>;

    afterEach(() => {
      execSyncSpy?.mockRestore();
    });

    it('returns validation result with expected structure', () => {
      const result = validateClaudeCli();

      expect(result).toHaveProperty('installed');
      expect(result).toHaveProperty('version');
      expect(result).toHaveProperty('compatible');
      expect(result).toHaveProperty('message');
      expect(typeof result.installed).toBe('boolean');
      expect(typeof result.compatible).toBe('boolean');
      expect(typeof result.message).toBe('string');
    });

    it('returns not installed when version is null', () => {
      execSyncSpy = spyOn(childProcess, 'execSync').mockImplementation(() => {
        throw new Error('Command not found');
      });

      const result = validateClaudeCli();

      expect(result.installed).toBe(false);
      expect(result.version).toBeNull();
      expect(result.compatible).toBe(false);
      expect(result.status).toBe('incompatible');
      expect(result.message).toContain('Claude CLI not found');
    });

    it('returns incompatible for old version', () => {
      execSyncSpy = spyOn(childProcess, 'execSync').mockReturnValue('2.0.73\n');

      const result = validateClaudeCli();

      expect(result.installed).toBe(true);
      expect(result.version).toBe('2.0.73');
      expect(result.compatible).toBe(false);
      expect(result.status).toBe('incompatible');
      expect(result.message).toContain('too old');
    });

    it('returns incompatible for a new major version', () => {
      execSyncSpy = spyOn(childProcess, 'execSync').mockReturnValue('3.0.0\n');

      const result = validateClaudeCli();

      expect(result.installed).toBe(true);
      expect(result.version).toBe('3.0.0');
      expect(result.compatible).toBe(false);
      expect(result.status).toBe('incompatible');
      expect(result.message).toContain('major');
    });

    it('returns compatible-with-warning for an untested same-major version', () => {
      execSyncSpy = spyOn(childProcess, 'execSync').mockReturnValue('2.2.0\n');

      const result = validateClaudeCli();

      expect(result.installed).toBe(true);
      expect(result.version).toBe('2.2.0');
      expect(result.compatible).toBe(true);
      expect(result.status).toBe('untested');
      expect(result.message).toContain('untested');
    });

    it('returns compatible for valid version', () => {
      execSyncSpy = spyOn(childProcess, 'execSync').mockReturnValue('2.0.76\n');

      const result = validateClaudeCli();

      expect(result.installed).toBe(true);
      expect(result.version).toBe('2.0.76');
      expect(result.compatible).toBe(true);
      expect(result.status).toBe('ok');
      expect(result.message).toContain('2.0.76 ✓');
    });
  });
});
