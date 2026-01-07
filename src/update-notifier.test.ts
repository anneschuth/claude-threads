import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import * as updateNotifierModule from 'update-notifier';

// We need to test the module functions in isolation

describe('update-notifier', () => {
  const originalEnv = process.env.NO_UPDATE_NOTIFIER;

  beforeEach(() => {
    // Reset environment
    delete process.env.NO_UPDATE_NOTIFIER;
  });

  afterEach(() => {
    // Restore environment
    if (originalEnv !== undefined) {
      process.env.NO_UPDATE_NOTIFIER = originalEnv;
    } else {
      delete process.env.NO_UPDATE_NOTIFIER;
    }
  });

  describe('checkForUpdates', () => {
    it('returns early when NO_UPDATE_NOTIFIER is set', async () => {
      process.env.NO_UPDATE_NOTIFIER = '1';

      // Re-import to get fresh module state
      const { checkForUpdates } = await import('./update-notifier.js');

      // Should not throw and should return quickly
      expect(() => checkForUpdates()).not.toThrow();
    });

    it('handles errors gracefully', async () => {
      // Mock updateNotifier to throw
      const updateNotifierSpy = spyOn(updateNotifierModule, 'default').mockImplementation(() => {
        throw new Error('Network error');
      });

      // Re-import to get fresh module state
      const { checkForUpdates } = await import('./update-notifier.js');

      // Should not throw - errors are silently caught
      expect(() => checkForUpdates()).not.toThrow();

      updateNotifierSpy.mockRestore();
    });
  });

  describe('getUpdateInfo', () => {
    it('returns undefined when no cached update info', async () => {
      // Fresh import should have no cached info
      const { getUpdateInfo } = await import('./update-notifier.js');

      // Without calling checkForUpdates, cache should be empty
      const result = getUpdateInfo();
      expect(result).toBeUndefined();
    });

    it('returns undefined when current version equals latest', async () => {
      // Mock updateNotifier to return update info where current = latest
      const mockNotifier = {
        update: {
          current: '1.0.0',
          latest: '1.0.0',
          type: 'latest' as const,
          name: 'test-package',
        },
        notify: mock(() => {}),
      };

      const updateNotifierSpy = spyOn(updateNotifierModule, 'default').mockReturnValue(mockNotifier as any);

      // Re-import and call checkForUpdates to populate cache
      delete require.cache[require.resolve('./update-notifier.js')];
      const { checkForUpdates, getUpdateInfo } = await import('./update-notifier.js');

      checkForUpdates();

      // When current >= latest, should return undefined
      const result = getUpdateInfo();
      expect(result).toBeUndefined();

      updateNotifierSpy.mockRestore();
    });

    it('returns update info when latest is newer', async () => {
      // Mock updateNotifier to return update info where latest > current
      const mockUpdateInfo = {
        current: '1.0.0',
        latest: '2.0.0',
        type: 'major' as const,
        name: 'test-package',
      };

      const mockNotifier = {
        update: mockUpdateInfo,
        notify: mock(() => {}),
      };

      const updateNotifierSpy = spyOn(updateNotifierModule, 'default').mockReturnValue(mockNotifier as any);

      // Re-import and call checkForUpdates to populate cache
      delete require.cache[require.resolve('./update-notifier.js')];
      const { checkForUpdates, getUpdateInfo } = await import('./update-notifier.js');

      checkForUpdates();

      const result = getUpdateInfo();
      expect(result).toEqual(mockUpdateInfo);

      updateNotifierSpy.mockRestore();
    });
  });
});
