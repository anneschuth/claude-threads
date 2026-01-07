import { describe, expect, it, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { getBatteryStatus, formatBatteryStatus, type BatteryStatus } from './battery.js';

describe('getBatteryStatus', () => {
  it('should return battery status or null', async () => {
    const status = await getBatteryStatus();
    // On systems with battery, we get an object; on desktops, we get null
    if (status !== null) {
      expect(status).toHaveProperty('percentage');
      expect(status).toHaveProperty('charging');
      expect(typeof status.percentage).toBe('number');
      expect(typeof status.charging).toBe('boolean');
      expect(status.percentage).toBeGreaterThanOrEqual(0);
      expect(status.percentage).toBeLessThanOrEqual(100);
    }
  });

  it('returns null on unsupported platforms', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const status = await getBatteryStatus();
    expect(status).toBeNull();

    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });
});

describe('formatBatteryStatus', () => {
  it('should return formatted string or null', async () => {
    const formatted = await formatBatteryStatus();
    // On systems with battery, we get a string; on desktops, we get null
    if (formatted !== null) {
      expect(typeof formatted).toBe('string');
      // Should contain either battery or AC icon
      expect(formatted).toMatch(/^[🔋🔌]/u);
    }
  });

  it('returns null when no battery', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const formatted = await formatBatteryStatus();
    expect(formatted).toBeNull();

    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });
});

describe('BatteryStatus interface', () => {
  it('has correct shape', () => {
    const status: BatteryStatus = {
      percentage: 50,
      charging: true,
    };

    expect(status.percentage).toBe(50);
    expect(status.charging).toBe(true);
  });

  it('allows 0-100 range', () => {
    const low: BatteryStatus = { percentage: 0, charging: false };
    const high: BatteryStatus = { percentage: 100, charging: true };

    expect(low.percentage).toBe(0);
    expect(high.percentage).toBe(100);
  });
});
