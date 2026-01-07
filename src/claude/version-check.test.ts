import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as childProcess from 'child_process';
import {
  isVersionCompatible,
  CLAUDE_CLI_VERSION_RANGE,
  validateClaudeCli,
  getClaudeCliVersion,
} from './version-check.js';

describe('version-check', () => {
  describe('CLAUDE_CLI_VERSION_RANGE', () => {
    it('is defined', () => {
      expect(CLAUDE_CLI_VERSION_RANGE).toBeDefined();
      expect(typeof CLAUDE_CLI_VERSION_RANGE).toBe('string');
    });
  });

  describe('isVersionCompatible', () => {
    it('returns true for versions in the valid range', () => {
      expect(isVersionCompatible('2.0.74')).toBe(true);
      expect(isVersionCompatible('2.0.75')).toBe(true);
      expect(isVersionCompatible('2.0.76')).toBe(true);
    });

    it('returns false for versions outside the range', () => {
      expect(isVersionCompatible('2.0.73')).toBe(false);
      expect(isVersionCompatible('2.0.77')).toBe(false);
      expect(isVersionCompatible('2.1.0')).toBe(false);
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

      const version = getClaudeCliVersion();
      expect(version).toBe('2.0.76');
    });

    it('handles version-only output format', () => {
      execSyncSpy = spyOn(childProcess, 'execSync').mockReturnValue('2.0.75\n');

      const version = getClaudeCliVersion();
      expect(version).toBe('2.0.75');
    });

    it('returns null when execSync throws', () => {
      execSyncSpy = spyOn(childProcess, 'execSync').mockImplementation(() => {
        throw new Error('Command not found');
      });

      const version = getClaudeCliVersion();
      expect(version).toBeNull();
    });

    it('returns null when output does not match version pattern', () => {
      execSyncSpy = spyOn(childProcess, 'execSync').mockReturnValue('not a version\n');

      const version = getClaudeCliVersion();
      expect(version).toBeNull();
    });

    it('uses CLAUDE_PATH environment variable when set', () => {
      process.env.CLAUDE_PATH = '/custom/path/claude';
      execSyncSpy = spyOn(childProcess, 'execSync').mockReturnValue('2.0.76\n');

      getClaudeCliVersion();

      expect(execSyncSpy).toHaveBeenCalledWith(
        '/custom/path/claude --version',
        expect.any(Object)
      );
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
      expect(result.message).toContain('Claude CLI not found');
    });

    it('returns incompatible for old version', () => {
      execSyncSpy = spyOn(childProcess, 'execSync').mockReturnValue('2.0.73\n');

      const result = validateClaudeCli();

      expect(result.installed).toBe(true);
      expect(result.version).toBe('2.0.73');
      expect(result.compatible).toBe(false);
      expect(result.message).toContain('not compatible');
    });

    it('returns compatible for valid version', () => {
      execSyncSpy = spyOn(childProcess, 'execSync').mockReturnValue('2.0.76\n');

      const result = validateClaudeCli();

      expect(result.installed).toBe(true);
      expect(result.version).toBe('2.0.76');
      expect(result.compatible).toBe(true);
      expect(result.message).toContain('2.0.76 ✓');
    });
  });
});
