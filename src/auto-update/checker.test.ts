import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { UpdateChecker, unmetEngine } from './checker.js';
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

      it('holds back a release this runtime cannot run', async () => {
        globalThis.fetch = mockFetch(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              version: '99.0.0',
              engines: { node: '>=999.0.0', bun: '>=999.0.0' },
            }),
          } as Response)
        );

        const checker = new UpdateChecker(config);
        const onUpdate = mock(() => {});
        checker.on('update', onUpdate);

        const result = await checker.check();

        expect(result).toBeNull();
        expect(onUpdate).not.toHaveBeenCalled();
        expect(checker.getBlockedUpdate()?.latestVersion).toBe('99.0.0');
      });

      it('clears the hold once the latest release runs here again', async () => {
        let engines: Record<string, string> = { node: '>=999.0.0', bun: '>=999.0.0' };
        globalThis.fetch = mockFetch(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ version: '99.0.0', engines }),
          } as Response)
        );

        const checker = new UpdateChecker(config);
        await checker.check();
        engines = {};
        const result = await checker.check();

        expect(result?.latestVersion).toBe('99.0.0');
        expect(checker.getBlockedUpdate()).toBeNull();
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

describe('unmetEngine', () => {
  const engines = { node: '>=22.0.0', bun: '>=1.2.21' };

  it('passes a Node host on the floor', () => {
    expect(unmetEngine(engines, { node: '22.0.0' })).toBeNull();
  });

  it('stops a Node host below the floor', () => {
    expect(unmetEngine(engines, { node: '20.20.2' })).toBe('requires node >=22.0.0, this host runs 20.20.2');
  });

  it('judges a Bun host by the bun entry, not the node version it reports', () => {
    expect(unmetEngine(engines, { node: '20.20.2', bun: '1.4.2' })).toBeNull();
    expect(unmetEngine(engines, { node: '24.0.0', bun: '1.1.0' })).toBe('requires bun >=1.2.21, this host runs 1.1.0');
  });

  it('accepts a prerelease of a new enough Node', () => {
    expect(unmetEngine(engines, { node: '23.0.0-nightly' })).toBeNull();
  });

  it('does not stop updates over missing or unreadable engines', () => {
    expect(unmetEngine(undefined, { node: '20.0.0' })).toBeNull();
    expect(unmetEngine({ bun: '>=1.0.0' }, { node: '20.0.0' })).toBeNull();
    expect(unmetEngine({ node: 'not a range' }, { node: '20.0.0' })).toBeNull();
  });
});
