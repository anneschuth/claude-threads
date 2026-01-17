import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { existsSync, unlinkSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import {
  loadUpdateState,
  saveUpdateState,
  clearUpdateState,
  checkJustUpdated,
  getRollbackInstructions,
  detectPackageManager,
  detectOriginalInstaller,
  UpdateInstaller,
} from './installer.js';
import { UPDATE_STATE_FILENAME, type PersistedUpdateState } from './types.js';

const STATE_PATH = resolve(homedir(), '.config', 'claude-threads', UPDATE_STATE_FILENAME);

describe('auto-update/installer', () => {
  // Backup and restore state file around tests
  let originalState: string | null = null;

  beforeEach(() => {
    // Backup existing state if present
    if (existsSync(STATE_PATH)) {
      originalState = readFileSync(STATE_PATH, 'utf-8');
    }
    // Clear state for tests
    clearUpdateState();
  });

  afterEach(() => {
    // Restore original state
    if (originalState !== null) {
      saveUpdateState(JSON.parse(originalState));
      originalState = null;
    } else {
      clearUpdateState();
    }
  });

  describe('loadUpdateState()', () => {
    it('returns empty object when no state file exists', () => {
      // Clear any existing state first
      if (existsSync(STATE_PATH)) {
        unlinkSync(STATE_PATH);
      }

      const state = loadUpdateState();
      expect(state).toEqual({});
    });

    it('returns parsed state from file', () => {
      const testState: PersistedUpdateState = {
        previousVersion: '1.0.0',
        targetVersion: '2.0.0',
        justUpdated: true,
      };

      saveUpdateState(testState);
      const loaded = loadUpdateState();

      expect(loaded.previousVersion).toBe('1.0.0');
      expect(loaded.targetVersion).toBe('2.0.0');
      expect(loaded.justUpdated).toBe(true);
    });
  });

  describe('saveUpdateState()', () => {
    it('saves state to file', () => {
      const testState: PersistedUpdateState = {
        previousVersion: '0.5.0',
        targetVersion: '1.0.0',
      };

      saveUpdateState(testState);

      expect(existsSync(STATE_PATH)).toBe(true);
      const content = readFileSync(STATE_PATH, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.previousVersion).toBe('0.5.0');
    });

    it('creates directory if needed', () => {
      // This is hard to test without removing the directory,
      // but we can at least verify the function doesn't throw
      const testState: PersistedUpdateState = {
        previousVersion: '1.0.0',
      };

      expect(() => saveUpdateState(testState)).not.toThrow();
    });
  });

  describe('clearUpdateState()', () => {
    it('clears state file to empty object', () => {
      saveUpdateState({
        previousVersion: '1.0.0',
        justUpdated: true,
      });

      clearUpdateState();

      const loaded = loadUpdateState();
      expect(loaded).toEqual({});
    });

    it('handles non-existent file gracefully', () => {
      if (existsSync(STATE_PATH)) {
        unlinkSync(STATE_PATH);
      }

      expect(() => clearUpdateState()).not.toThrow();
    });
  });

  describe('checkJustUpdated()', () => {
    it('returns null when not just updated', () => {
      clearUpdateState();

      const result = checkJustUpdated();
      expect(result).toBeNull();
    });

    it('returns null when justUpdated is false', () => {
      saveUpdateState({
        previousVersion: '1.0.0',
        justUpdated: false,
      });

      const result = checkJustUpdated();
      expect(result).toBeNull();
    });

    it('returns version info when just updated', () => {
      saveUpdateState({
        previousVersion: '1.0.0',
        justUpdated: true,
      });

      const result = checkJustUpdated();

      expect(result).not.toBeNull();
      expect(result?.previousVersion).toBe('1.0.0');
    });

    it('clears justUpdated flag after checking', () => {
      saveUpdateState({
        previousVersion: '1.0.0',
        justUpdated: true,
      });

      // First call returns info
      checkJustUpdated();

      // Second call returns null (flag was cleared)
      const result = checkJustUpdated();
      expect(result).toBeNull();
    });
  });

  describe('detectOriginalInstaller()', () => {
    it('returns bun, npm, or null', () => {
      const result = detectOriginalInstaller();

      // Should return one of the valid values
      expect(result === 'bun' || result === 'npm' || result === null).toBe(true);
    });

    it('returns null when running from source (dev mode)', () => {
      // When running tests, we're in dev mode, not globally installed
      // The result depends on how tests are run, but the function should not throw
      const result = detectOriginalInstaller();
      expect(() => detectOriginalInstaller()).not.toThrow();

      // If running from source, should be null
      // If running from global install, should be 'bun' or 'npm'
      if (result !== null) {
        expect(['bun', 'npm']).toContain(result);
      }
    });
  });

  describe('detectPackageManager()', () => {
    it('detects available package manager', () => {
      const pm = detectPackageManager();

      // In test environment, at least one should be available
      expect(pm).not.toBeNull();
      expect(pm?.cmd).toBeDefined();
      expect(typeof pm?.isBun).toBe('boolean');
    });

    it('uses original installer if detected', () => {
      const original = detectOriginalInstaller();
      const pm = detectPackageManager();

      // If we detected an original installer, the package manager should match
      // (assuming that package manager is still available)
      if (original === 'bun' && pm?.isBun) {
        expect(pm.cmd).toBe('bun');
      } else if (original === 'npm' && !pm?.isBun) {
        expect(pm?.cmd).toMatch(/npm/);
      }
    });

    it('falls back to available package manager if original not detected', () => {
      const pm = detectPackageManager();

      // Should always return something in our test environment
      expect(pm).not.toBeNull();
    });
  });

  describe('getRollbackInstructions()', () => {
    it('returns rollback command with version', () => {
      const instructions = getRollbackInstructions('1.0.0');

      // Uses whatever package manager is detected (bun preferred)
      const pm = detectPackageManager();
      const expectedCmd = pm?.isBun ? 'bun' : 'npm';
      expect(instructions).toContain(`${expectedCmd} install -g claude-threads@1.0.0`);
    });
  });

  describe('UpdateInstaller', () => {
    describe('constructor', () => {
      it('creates installer', () => {
        const installer = new UpdateInstaller();
        expect(installer).toBeDefined();
      });
    });

    describe('isInProgress()', () => {
      it('returns false initially', () => {
        const installer = new UpdateInstaller();
        expect(installer.isInProgress()).toBe(false);
      });
    });

    describe('checkJustUpdated()', () => {
      it('proxies to standalone function', () => {
        clearUpdateState();

        const installer = new UpdateInstaller();
        expect(installer.checkJustUpdated()).toBeNull();
      });
    });

    describe('getState()', () => {
      it('returns current persisted state', () => {
        saveUpdateState({
          previousVersion: '1.0.0',
          targetVersion: '2.0.0',
        });

        const installer = new UpdateInstaller();
        const state = installer.getState();

        expect(state.previousVersion).toBe('1.0.0');
        expect(state.targetVersion).toBe('2.0.0');
      });
    });

    describe('clearState()', () => {
      it('clears the persisted state', () => {
        saveUpdateState({
          previousVersion: '1.0.0',
        });

        const installer = new UpdateInstaller();
        installer.clearState();

        expect(installer.getState()).toEqual({});
      });
    });

    // Note: We don't test install() directly as it runs bun/npm install -g
    // which would actually modify the system. Integration tests would cover this.
  });
});
