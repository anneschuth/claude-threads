import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { UpdateChecker } from './checker.js';
import { DEFAULT_AUTO_UPDATE_CONFIG, type AutoUpdateConfig } from './types.js';

// Mock fetch globally
const originalFetch = globalThis.fetch;

// Helper to create a mock fetch function
const mockFetch = (impl: () => Promise<unknown>): typeof fetch => {
  const fn = mock(impl) as unknown as typeof fetch;
  return fn;
};

describe('auto-update/checker', () => {
  let config: AutoUpdateConfig;

  beforeEach(() => {
    config = { ...DEFAULT_AUTO_UPDATE_CONFIG };
  });

  afterEach(() => {
    // Restore original fetch
    globalThis.fetch = originalFetch;
  });

  describe('UpdateChecker', () => {
    it('creates checker with config', () => {
      const checker = new UpdateChecker(config);
      expect(checker).toBeDefined();
    });

    describe('check()', () => {
      it('returns null when fetch fails', async () => {
        globalThis.fetch = mockFetch(() => Promise.reject(new Error('Network error')));

        const checker = new UpdateChecker(config);
        const result = await checker.check();

        expect(result).toBeNull();
      });

      it('returns null when response is not ok', async () => {
        globalThis.fetch = mockFetch(() =>
          Promise.resolve({
            ok: false,
            status: 500,
          } as Response)
        );

        const checker = new UpdateChecker(config);
        const result = await checker.check();

        expect(result).toBeNull();
      });

      it('returns null when no version in response', async () => {
        globalThis.fetch = mockFetch(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response)
        );

        const checker = new UpdateChecker(config);
        const result = await checker.check();

        expect(result).toBeNull();
      });

      it('returns update info when newer version available', async () => {
        globalThis.fetch = mockFetch(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ version: '999.0.0' }),
          } as Response)
        );

        const checker = new UpdateChecker(config);
        const result = await checker.check();

        expect(result).not.toBeNull();
        expect(result?.available).toBe(true);
        expect(result?.latestVersion).toBe('999.0.0');
      });

      it('returns null when current version is latest', async () => {
        globalThis.fetch = mockFetch(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ version: '0.0.1' }), // Older than any real version
          } as Response)
        );

        const checker = new UpdateChecker(config);
        const result = await checker.check();

        expect(result).toBeNull();
      });

      it('emits check:start event', async () => {
        globalThis.fetch = mockFetch(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ version: '0.0.1' }),
          } as Response)
        );

        const checker = new UpdateChecker(config);
        let emitted = false;
        checker.on('check:start', () => {
          emitted = true;
        });

        await checker.check();

        expect(emitted).toBe(true);
      });

      it('emits check:complete event with false when no update', async () => {
        globalThis.fetch = mockFetch(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ version: '0.0.1' }),
          } as Response)
        );

        const checker = new UpdateChecker(config);
        const results: boolean[] = [];
        checker.on('check:complete', (hasUpdate: boolean) => {
          results.push(hasUpdate);
        });

        await checker.check();

        expect(results.length).toBe(1);
        expect(results[0]).toBe(false);
      });

      it('emits update event when new version found', async () => {
        globalThis.fetch = mockFetch(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ version: '999.0.0' }),
          } as Response)
        );

        const checker = new UpdateChecker(config);
        let updateInfo = null;
        checker.on('update', (info) => {
          updateInfo = info;
        });

        await checker.check();

        expect(updateInfo).not.toBeNull();
      });

      it('prevents concurrent checks', async () => {
        let fetchCount = 0;
        globalThis.fetch = mockFetch(() => {
          fetchCount++;
          return new Promise((resolve) =>
            setTimeout(() =>
              resolve({
                ok: true,
                json: () => Promise.resolve({ version: '0.0.1' }),
              } as Response),
              50
            )
          );
        });

        const checker = new UpdateChecker(config);

        // Start two checks simultaneously
        const check1 = checker.check();
        const check2 = checker.check();

        await Promise.all([check1, check2]);

        // Should only have called fetch once
        expect(fetchCount).toBe(1);
      });
    });

    describe('getLastUpdateInfo()', () => {
      it('returns null initially', () => {
        const checker = new UpdateChecker(config);
        expect(checker.getLastUpdateInfo()).toBeNull();
      });

      it('returns last update after check finds update', async () => {
        globalThis.fetch = mockFetch(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ version: '999.0.0' }),
          } as Response)
        );

        const checker = new UpdateChecker(config);
        await checker.check();

        const info = checker.getLastUpdateInfo();
        expect(info).not.toBeNull();
        expect(info?.latestVersion).toBe('999.0.0');
      });
    });

    describe('getLastCheckTime()', () => {
      it('returns null initially', () => {
        const checker = new UpdateChecker(config);
        expect(checker.getLastCheckTime()).toBeNull();
      });

      it('returns time after check', async () => {
        globalThis.fetch = mockFetch(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ version: '0.0.1' }),
          } as Response)
        );

        const checker = new UpdateChecker(config);
        const before = new Date();
        await checker.check();
        const after = new Date();

        const checkTime = checker.getLastCheckTime();
        expect(checkTime).not.toBeNull();
        expect(checkTime!.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(checkTime!.getTime()).toBeLessThanOrEqual(after.getTime());
      });
    });

    describe('start() and stop()', () => {
      it('starts periodic checking when enabled', () => {
        const checker = new UpdateChecker(config);
        checker.start();

        // Should not throw
        checker.stop();
      });

      it('does not start when disabled', () => {
        const disabledConfig = { ...config, enabled: false };
        const checker = new UpdateChecker(disabledConfig);
        checker.start();

        // Should be a no-op
        checker.stop();
      });

      it('stop() is idempotent', () => {
        const checker = new UpdateChecker(config);
        checker.start();
        checker.stop();
        checker.stop(); // Should not throw
      });
    });

    describe('updateConfig()', () => {
      it('updates the configuration', () => {
        const checker = new UpdateChecker(config);
        const newConfig = { ...config, checkIntervalMinutes: 120 };

        // Should not throw
        checker.updateConfig(newConfig);
      });

      it('restarts interval if checker is running and interval changed', () => {
        const checker = new UpdateChecker(config);
        checker.start();

        const newConfig = { ...config, checkIntervalMinutes: 120 };
        checker.updateConfig(newConfig);

        checker.stop();
      });
    });
  });
});
