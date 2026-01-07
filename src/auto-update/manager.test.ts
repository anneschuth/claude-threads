import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { AutoUpdateManager, type AutoUpdateCallbacks } from './manager.js';
import { DEFAULT_AUTO_UPDATE_CONFIG, type AutoUpdateConfig } from './types.js';

// Mock fetch globally
const originalFetch = globalThis.fetch;

// Helper to create a mock fetch function
const mockFetch = (impl: () => Promise<unknown>): typeof fetch => {
  const fn = mock(impl) as unknown as typeof fetch;
  return fn;
};

describe('auto-update/manager', () => {
  let config: Partial<AutoUpdateConfig>;
  let callbacks: AutoUpdateCallbacks;

  beforeEach(() => {
    config = {};
    callbacks = {
      getSessionActivity: () => ({
        activeSessionCount: 0,
        lastActivityAt: null,
        anySessionBusy: false,
      }),
      getActiveThreadIds: () => [],
      broadcastUpdate: mock((_msgBuilder: unknown) => Promise.resolve()),
      postAskMessage: mock(() => Promise.resolve()),
      refreshUI: mock(() => Promise.resolve()),
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('AutoUpdateManager', () => {
    it('creates manager with config and callbacks', () => {
      const manager = new AutoUpdateManager(config, callbacks);
      expect(manager).toBeDefined();
      manager.stop();
    });

    it('creates manager with undefined config (uses defaults)', () => {
      const manager = new AutoUpdateManager(undefined, callbacks);
      expect(manager).toBeDefined();
      expect(manager.getConfig()).toEqual(DEFAULT_AUTO_UPDATE_CONFIG);
      manager.stop();
    });

    describe('getState()', () => {
      it('returns idle state initially', () => {
        const manager = new AutoUpdateManager(config, callbacks);
        const state = manager.getState();

        expect(state.status).toBe('idle');
        expect(state.updateInfo).toBeUndefined();
        manager.stop();
      });
    });

    describe('getConfig()', () => {
      it('returns merged config', () => {
        const customConfig: Partial<AutoUpdateConfig> = {
          enabled: false,
          checkIntervalMinutes: 120,
        };

        const manager = new AutoUpdateManager(customConfig, callbacks);
        const resultConfig = manager.getConfig();

        expect(resultConfig.enabled).toBe(false);
        expect(resultConfig.checkIntervalMinutes).toBe(120);
        // Defaults preserved
        expect(resultConfig.autoRestartMode).toBe('idle');
        manager.stop();
      });
    });

    describe('isEnabled()', () => {
      it('returns true when enabled (default)', () => {
        const manager = new AutoUpdateManager(config, callbacks);
        expect(manager.isEnabled()).toBe(true);
        manager.stop();
      });

      it('returns false when disabled', () => {
        const manager = new AutoUpdateManager({ enabled: false }, callbacks);
        expect(manager.isEnabled()).toBe(false);
        manager.stop();
      });
    });

    describe('hasUpdate()', () => {
      it('returns false initially', () => {
        const manager = new AutoUpdateManager(config, callbacks);
        expect(manager.hasUpdate()).toBe(false);
        manager.stop();
      });
    });

    describe('getUpdateInfo()', () => {
      it('returns undefined initially', () => {
        const manager = new AutoUpdateManager(config, callbacks);
        expect(manager.getUpdateInfo()).toBeUndefined();
        manager.stop();
      });
    });

    describe('getScheduledRestartAt()', () => {
      it('returns null initially', () => {
        const manager = new AutoUpdateManager(config, callbacks);
        expect(manager.getScheduledRestartAt()).toBeNull();
        manager.stop();
      });
    });

    describe('start()', () => {
      it('starts when enabled', () => {
        globalThis.fetch = mockFetch(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ version: '0.0.1' }),
          } as Response)
        );

        const manager = new AutoUpdateManager(config, callbacks);
        manager.start();

        // Should not throw
        manager.stop();
      });

      it('logs message when disabled', () => {
        const manager = new AutoUpdateManager({ enabled: false }, callbacks);
        manager.start();

        // Should not throw, should be a no-op
        manager.stop();
      });
    });

    describe('stop()', () => {
      it('stops the manager', () => {
        const manager = new AutoUpdateManager(config, callbacks);
        manager.start();
        manager.stop();

        // Should be stopped, idempotent
        manager.stop();
      });
    });

    describe('checkNow()', () => {
      it('returns null when no update available', async () => {
        globalThis.fetch = mockFetch(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ version: '0.0.1' }),
          } as Response)
        );

        const manager = new AutoUpdateManager(config, callbacks);
        const result = await manager.checkNow();

        expect(result).toBeNull();
        manager.stop();
      });

      it('returns update info when update available', async () => {
        globalThis.fetch = mockFetch(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ version: '999.0.0' }),
          } as Response)
        );

        const manager = new AutoUpdateManager(config, callbacks);
        const result = await manager.checkNow();

        expect(result).not.toBeNull();
        expect(result?.latestVersion).toBe('999.0.0');
        manager.stop();
      });

      it('emits update:available event when update found', async () => {
        globalThis.fetch = mockFetch(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ version: '999.0.0' }),
          } as Response)
        );

        const manager = new AutoUpdateManager(config, callbacks);
        let emitted = false;
        manager.on('update:available', () => {
          emitted = true;
        });

        await manager.checkNow();

        expect(emitted).toBe(true);
        manager.stop();
      });
    });

    describe('deferUpdate()', () => {
      it('defers the update', async () => {
        globalThis.fetch = mockFetch(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ version: '999.0.0' }),
          } as Response)
        );

        const manager = new AutoUpdateManager(config, callbacks);
        await manager.checkNow();

        // Should not throw
        manager.deferUpdate(60);

        expect(manager.getState().status).toBe('deferred');
        manager.stop();
      });
    });

    describe('recordAskResponse()', () => {
      it('records response for ask mode', () => {
        const manager = new AutoUpdateManager({ autoRestartMode: 'ask' }, callbacks);

        // Should not throw
        manager.recordAskResponse('thread-1', true);
        manager.recordAskResponse('thread-2', false);
        manager.stop();
      });
    });

    describe('event emissions', () => {
      it('emits update:status event', async () => {
        globalThis.fetch = mockFetch(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ version: '999.0.0' }),
          } as Response)
        );

        const manager = new AutoUpdateManager(config, callbacks);
        let emittedStatus = '';
        manager.on('update:status', (status) => {
          emittedStatus = status;
        });

        await manager.checkNow();

        expect(emittedStatus).toBe('available');
        manager.stop();
      });
    });
  });
});
