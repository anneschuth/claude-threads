import { describe, expect, it } from 'bun:test';
import { getBatteryStatus, formatBatteryStatus } from './battery.js';

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
});
