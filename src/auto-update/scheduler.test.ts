import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { UpdateScheduler, type SessionActivityInfo } from './scheduler.js';
import { DEFAULT_AUTO_UPDATE_CONFIG, type AutoUpdateConfig, type UpdateInfo } from './types.js';

describe('auto-update/scheduler', () => {
  let config: AutoUpdateConfig;
  let mockGetActivity: () => SessionActivityInfo;
  let mockGetThreadIds: () => string[];
  let mockPostAsk: (ids: string[], ver: string) => Promise<void>;

  beforeEach(() => {
    config = { ...DEFAULT_AUTO_UPDATE_CONFIG };
    mockGetActivity = () => ({
      activeSessionCount: 0,
      lastActivityAt: null,
      anySessionBusy: false,
    });
    mockGetThreadIds = () => [];
    mockPostAsk = mock(() => Promise.resolve());
  });

  const createScheduler = () => new UpdateScheduler(config, mockGetActivity, mockGetThreadIds, mockPostAsk);

  const createUpdateInfo = (version = '2.0.0'): UpdateInfo => ({
    available: true,
    currentVersion: '1.0.0',
    latestVersion: version,
    detectedAt: new Date(),
  });

  describe('UpdateScheduler', () => {
    it('creates scheduler with config and callbacks', () => {
      const scheduler = createScheduler();
      expect(scheduler).toBeDefined();
    });

    describe('immediate mode', () => {
      it('emits ready immediately in immediate mode', (done) => {
        config.autoRestartMode = 'immediate';
        const scheduler = createScheduler();
        const updateInfo = createUpdateInfo();

        scheduler.on('ready', (info) => {
          expect(info).toEqual(updateInfo);
          done();
        });

        scheduler.scheduleUpdate(updateInfo);
      });
    });

    describe('idle mode', () => {
      it('tracks pending update when scheduled', async () => {
        config.autoRestartMode = 'idle';
        config.idleTimeoutMinutes = 60; // Long timeout to avoid triggering during test

        // Sessions are active, so idle timer won't trigger
        mockGetActivity = () => ({
          activeSessionCount: 1,
          lastActivityAt: new Date(),
          anySessionBusy: true,
        });

        const scheduler = createScheduler();
        const updateInfo = createUpdateInfo();

        scheduler.scheduleUpdate(updateInfo);

        // Should track the pending update
        expect(scheduler.getPendingUpdate()).toEqual(updateInfo);

        scheduler.stop();
      });

      it('waits when sessions are active', async () => {
        config.autoRestartMode = 'idle';
        config.idleTimeoutMinutes = 1;

        mockGetActivity = () => ({
          activeSessionCount: 2,
          lastActivityAt: new Date(),
          anySessionBusy: true,
        });

        const scheduler = createScheduler();
        const updateInfo = createUpdateInfo();

        let readyEmitted = false;
        scheduler.on('ready', () => {
          readyEmitted = true;
        });

        scheduler.scheduleUpdate(updateInfo);

        // Wait a bit to ensure no ready event
        await new Promise((resolve) => setTimeout(resolve, 100));
        scheduler.stop();

        expect(readyEmitted).toBe(false);
      });
    });

    describe('cancelSchedule()', () => {
      it('cancels a scheduled update', async () => {
        config.autoRestartMode = 'idle';
        config.idleTimeoutMinutes = 10; // Long timeout

        const scheduler = createScheduler();
        const updateInfo = createUpdateInfo();

        let readyEmitted = false;
        scheduler.on('ready', () => {
          readyEmitted = true;
        });

        scheduler.scheduleUpdate(updateInfo);
        scheduler.cancelSchedule();

        // Wait to ensure no events
        await new Promise((resolve) => setTimeout(resolve, 50));
        scheduler.stop();

        expect(readyEmitted).toBe(false);
        expect(scheduler.getPendingUpdate()).toBeNull();
      });
    });

    describe('deferUpdate()', () => {
      it('defers update and emits deferred event', (done) => {
        config.autoRestartMode = 'idle';

        const scheduler = createScheduler();
        const updateInfo = createUpdateInfo();

        scheduler.on('deferred', (until) => {
          expect(until).toBeInstanceOf(Date);
          expect(until.getTime()).toBeGreaterThan(Date.now());
          scheduler.stop();
          done();
        });

        scheduler.scheduleUpdate(updateInfo);
        scheduler.deferUpdate(30); // 30 minutes
      });

      it('returns the defer-until date', () => {
        const scheduler = createScheduler();
        scheduler.scheduleUpdate(createUpdateInfo());

        const deferUntil = scheduler.deferUpdate(60);

        // Should be roughly 60 minutes from now
        const expectedTime = Date.now() + 60 * 60 * 1000;
        expect(deferUntil.getTime()).toBeGreaterThan(expectedTime - 5000);
        expect(deferUntil.getTime()).toBeLessThan(expectedTime + 5000);

        scheduler.stop();
      });
    });

    describe('recordAskResponse()', () => {
      it('records approval responses', () => {
        config.autoRestartMode = 'ask';
        const scheduler = createScheduler();

        // Should not throw
        scheduler.recordAskResponse('thread-1', true);
        scheduler.recordAskResponse('thread-2', false);

        scheduler.stop();
      });
    });

    describe('getScheduledRestartAt()', () => {
      it('returns null when no countdown active', () => {
        const scheduler = createScheduler();
        expect(scheduler.getScheduledRestartAt()).toBeNull();
      });
    });

    describe('getPendingUpdate()', () => {
      it('returns null when no update pending', () => {
        const scheduler = createScheduler();
        expect(scheduler.getPendingUpdate()).toBeNull();
      });

      it('returns update info after scheduling', () => {
        config.autoRestartMode = 'idle';
        config.idleTimeoutMinutes = 60; // Long timeout so it doesn't trigger

        mockGetActivity = () => ({
          activeSessionCount: 1, // Has sessions so won't trigger immediately
          lastActivityAt: new Date(),
          anySessionBusy: true,
        });

        const scheduler = createScheduler();
        const updateInfo = createUpdateInfo();

        scheduler.scheduleUpdate(updateInfo);

        expect(scheduler.getPendingUpdate()).toEqual(updateInfo);
        scheduler.stop();
      });
    });

    describe('updateConfig()', () => {
      it('updates the configuration', () => {
        const scheduler = createScheduler();
        const newConfig = { ...config, autoRestartMode: 'immediate' as const };

        // Should not throw
        scheduler.updateConfig(newConfig);
        scheduler.stop();
      });
    });

    describe('stop()', () => {
      it('stops all timers', () => {
        const scheduler = createScheduler();
        scheduler.scheduleUpdate(createUpdateInfo());

        // Should not throw
        scheduler.stop();
        scheduler.stop(); // Idempotent
      });
    });
  });
});
