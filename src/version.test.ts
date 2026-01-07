import { describe, it, expect } from 'bun:test';
import { VERSION, PACKAGE_NAME, PKG } from './version.js';

describe('version', () => {
  describe('VERSION', () => {
    it('is a string', () => {
      expect(typeof VERSION).toBe('string');
    });

    it('is a valid semver format or "unknown"', () => {
      // Either matches semver pattern or is "unknown"
      const isSemver = /^\d+\.\d+\.\d+/.test(VERSION);
      const isUnknown = VERSION === 'unknown';
      expect(isSemver || isUnknown).toBe(true);
    });

    it('is not empty', () => {
      expect(VERSION.length).toBeGreaterThan(0);
    });
  });

  describe('PACKAGE_NAME', () => {
    it('is "claude-threads"', () => {
      expect(PACKAGE_NAME).toBe('claude-threads');
    });
  });

  describe('PKG', () => {
    it('has version and name properties', () => {
      expect(PKG).toHaveProperty('version');
      expect(PKG).toHaveProperty('name');
    });

    it('matches exported VERSION', () => {
      expect(PKG.version).toBe(VERSION);
    });

    it('matches exported PACKAGE_NAME', () => {
      expect(PKG.name).toBe(PACKAGE_NAME);
    });
  });
});
