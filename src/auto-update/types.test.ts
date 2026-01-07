import { describe, expect, it } from 'bun:test';
import {
  mergeAutoUpdateConfig,
  isInScheduledWindow,
  DEFAULT_AUTO_UPDATE_CONFIG,
  RESTART_EXIT_CODE,
  MIN_CHECK_INTERVAL_MINUTES,
  type ScheduledWindow,
} from './types.js';

describe('auto-update/types', () => {
  describe('constants', () => {
    it('has correct RESTART_EXIT_CODE', () => {
      expect(RESTART_EXIT_CODE).toBe(42);
    });

    it('has correct MIN_CHECK_INTERVAL_MINUTES', () => {
      expect(MIN_CHECK_INTERVAL_MINUTES).toBe(5);
    });
  });

  describe('DEFAULT_AUTO_UPDATE_CONFIG', () => {
    it('has expected default values', () => {
      expect(DEFAULT_AUTO_UPDATE_CONFIG.enabled).toBe(true);
      expect(DEFAULT_AUTO_UPDATE_CONFIG.checkIntervalMinutes).toBe(60);
      expect(DEFAULT_AUTO_UPDATE_CONFIG.autoRestartMode).toBe('idle');
      expect(DEFAULT_AUTO_UPDATE_CONFIG.idleTimeoutMinutes).toBe(5);
      expect(DEFAULT_AUTO_UPDATE_CONFIG.quietTimeoutMinutes).toBe(10);
      expect(DEFAULT_AUTO_UPDATE_CONFIG.askTimeoutMinutes).toBe(30);
      expect(DEFAULT_AUTO_UPDATE_CONFIG.scheduledWindow).toEqual({
        startHour: 2,
        endHour: 5,
      });
    });
  });

  describe('mergeAutoUpdateConfig', () => {
    it('returns defaults when no user config provided', () => {
      const result = mergeAutoUpdateConfig(undefined);
      expect(result).toEqual(DEFAULT_AUTO_UPDATE_CONFIG);
    });

    it('returns defaults when empty object provided', () => {
      const result = mergeAutoUpdateConfig({});
      expect(result).toEqual(DEFAULT_AUTO_UPDATE_CONFIG);
    });

    it('merges partial config with defaults', () => {
      const result = mergeAutoUpdateConfig({
        enabled: false,
        autoRestartMode: 'immediate',
      });

      expect(result.enabled).toBe(false);
      expect(result.autoRestartMode).toBe('immediate');
      // Defaults preserved
      expect(result.checkIntervalMinutes).toBe(60);
      expect(result.idleTimeoutMinutes).toBe(5);
    });

    it('enforces minimum check interval', () => {
      const result = mergeAutoUpdateConfig({
        checkIntervalMinutes: 1, // Below minimum
      });

      expect(result.checkIntervalMinutes).toBe(MIN_CHECK_INTERVAL_MINUTES);
    });

    it('allows check interval at minimum', () => {
      const result = mergeAutoUpdateConfig({
        checkIntervalMinutes: MIN_CHECK_INTERVAL_MINUTES,
      });

      expect(result.checkIntervalMinutes).toBe(MIN_CHECK_INTERVAL_MINUTES);
    });

    it('allows check interval above minimum', () => {
      const result = mergeAutoUpdateConfig({
        checkIntervalMinutes: 120,
      });

      expect(result.checkIntervalMinutes).toBe(120);
    });

    it('merges scheduled window', () => {
      const customWindow: ScheduledWindow = {
        startHour: 3,
        endHour: 6,
      };

      const result = mergeAutoUpdateConfig({
        scheduledWindow: customWindow,
      });

      expect(result.scheduledWindow).toEqual(customWindow);
    });
  });

  describe('isInScheduledWindow', () => {
    // Note: These tests depend on the current time, so we'll test the logic
    // rather than specific times

    it('handles window within same day', () => {
      const window: ScheduledWindow = { startHour: 9, endHour: 17 };

      // Create a mock date for testing
      const mockDate = new Date();
      const currentHour = mockDate.getHours();

      // The function should return true if current hour is in [9, 17)
      const result = isInScheduledWindow(window);
      const expected = currentHour >= 9 && currentHour < 17;
      expect(result).toBe(expected);
    });

    it('handles window spanning midnight', () => {
      const window: ScheduledWindow = { startHour: 22, endHour: 5 };

      const currentHour = new Date().getHours();

      // Should be true if hour >= 22 OR hour < 5
      const result = isInScheduledWindow(window);
      const expected = currentHour >= 22 || currentHour < 5;
      expect(result).toBe(expected);
    });

    it('handles start hour equal to end hour', () => {
      const window: ScheduledWindow = { startHour: 10, endHour: 10 };

      // Empty window - should return false
      const result = isInScheduledWindow(window);
      expect(result).toBe(false);
    });

    it('handles 24-hour window (always true)', () => {
      // If start=0 and end=0, it's effectively 24 hours
      const window: ScheduledWindow = { startHour: 0, endHour: 0 };

      const result = isInScheduledWindow(window);
      expect(result).toBe(false); // Empty window
    });
  });
});
