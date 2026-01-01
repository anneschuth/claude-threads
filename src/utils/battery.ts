/**
 * Battery Status Module
 *
 * Detects laptop battery status for display in the session status bar.
 * Uses platform-specific methods:
 * - macOS: pmset -g batt
 * - Linux: /sys/class/power_supply/
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';

const execAsync = promisify(exec);

export interface BatteryStatus {
  percentage: number;
  charging: boolean;
}

/**
 * Get current battery status.
 * Returns null if no battery is present or on unsupported platforms.
 */
export async function getBatteryStatus(): Promise<BatteryStatus | null> {
  switch (process.platform) {
    case 'darwin':
      return getMacOSBattery();
    case 'linux':
      return getLinuxBattery();
    default:
      return null;
  }
}

/**
 * macOS: Parse output from pmset -g batt
 * Example output:
 *   Now drawing from 'Battery Power'
 *   -InternalBattery-0 (id=...)	85%; discharging; 3:45 remaining
 * Or:
 *   Now drawing from 'AC Power'
 *   -InternalBattery-0 (id=...)	100%; charged; 0:00 remaining
 */
async function getMacOSBattery(): Promise<BatteryStatus | null> {
  try {
    const { stdout } = await execAsync('pmset -g batt');

    // Check if on AC power
    const charging = stdout.includes("'AC Power'") ||
                     stdout.includes('charging') ||
                     stdout.includes('charged');

    // Extract percentage (e.g., "85%")
    const percentMatch = stdout.match(/(\d+)%/);
    if (!percentMatch) {
      return null; // No battery or couldn't parse
    }

    return {
      percentage: parseInt(percentMatch[1], 10),
      charging,
    };
  } catch {
    return null;
  }
}

/**
 * Linux: Read from /sys/class/power_supply/
 * Common battery names: BAT0, BAT1, battery
 */
async function getLinuxBattery(): Promise<BatteryStatus | null> {
  const batteryNames = ['BAT0', 'BAT1', 'battery'];

  for (const name of batteryNames) {
    try {
      const basePath = `/sys/class/power_supply/${name}`;

      // Read capacity (percentage)
      const capacityStr = await readFile(`${basePath}/capacity`, 'utf-8');
      const percentage = parseInt(capacityStr.trim(), 10);

      // Read status (Charging, Discharging, Full, Not charging)
      const status = await readFile(`${basePath}/status`, 'utf-8');
      const charging = status.trim().toLowerCase() !== 'discharging';

      return { percentage, charging };
    } catch {
      // Try next battery name
      continue;
    }
  }

  return null; // No battery found
}

/**
 * Format battery status for display in status bar.
 * Returns: "🔋 85%" or "🔌 AC" or null if no battery
 */
export async function formatBatteryStatus(): Promise<string | null> {
  const status = await getBatteryStatus();
  if (!status) {
    return null;
  }

  if (status.charging && status.percentage === 100) {
    return '🔌 AC';
  }

  const icon = status.charging ? '🔌' : '🔋';
  return `${icon} ${status.percentage}%`;
}
