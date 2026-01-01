import { describe, expect, it } from 'bun:test';
import { formatUptime } from './uptime.js';

describe('formatUptime', () => {
  it('should format less than a minute', () => {
    const now = new Date();
    const startedAt = new Date(now.getTime() - 30 * 1000); // 30 seconds ago
    expect(formatUptime(startedAt)).toBe('<1m');
  });

  it('should format minutes only', () => {
    const now = new Date();
    const startedAt = new Date(now.getTime() - 5 * 60 * 1000); // 5 minutes ago
    expect(formatUptime(startedAt)).toBe('5m');
  });

  it('should format hours and minutes', () => {
    const now = new Date();
    const startedAt = new Date(now.getTime() - (1 * 60 + 23) * 60 * 1000); // 1h23m ago
    expect(formatUptime(startedAt)).toBe('1h23m');
  });

  it('should format hours only when no minutes', () => {
    const now = new Date();
    const startedAt = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 hours ago
    expect(formatUptime(startedAt)).toBe('2h');
  });

  it('should format days and hours', () => {
    const now = new Date();
    const startedAt = new Date(now.getTime() - (1 * 24 + 5) * 60 * 60 * 1000); // 1d5h ago
    expect(formatUptime(startedAt)).toBe('1d5h');
  });

  it('should format days only when no hours', () => {
    const now = new Date();
    const startedAt = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
    expect(formatUptime(startedAt)).toBe('2d');
  });
});
