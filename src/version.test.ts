import { describe, it, expect } from 'bun:test';
import { VERSION, PKG } from './version.js';

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

  describe('PKG', () => {
    it('has version and name properties', () => {
      expect(PKG).toHaveProperty('version');
      expect(PKG).toHaveProperty('name');
    });

    it('matches exported VERSION', () => {
      expect(PKG.version).toBe(VERSION);
    });

    it('name is claude-threads', () => {
      expect(PKG.name).toBe('claude-threads');
    });
  });
});
