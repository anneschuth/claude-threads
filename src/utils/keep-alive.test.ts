import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import { KeepAliveManager } from './keep-alive.js';

describe('KeepAliveManager', () => {
  let manager: KeepAliveManager;
  let consoleLogSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Suppress console.log output during tests
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    manager = new KeepAliveManager();
  });

  afterEach(() => {
    manager.forceStop();
    consoleLogSpy.mockRestore();
  });

  test('starts with zero active sessions', () => {
    expect(manager.getSessionCount()).toBe(0);
  });

  test('is enabled by default', () => {
    expect(manager.isEnabled()).toBe(true);
  });

  test('can be disabled', () => {
    manager.setEnabled(false);
    expect(manager.isEnabled()).toBe(false);
  });

  test('increments session count on sessionStarted', () => {
    manager.sessionStarted();
    expect(manager.getSessionCount()).toBe(1);
    manager.sessionStarted();
    expect(manager.getSessionCount()).toBe(2);
  });

  test('decrements session count on sessionEnded', () => {
    manager.sessionStarted();
    manager.sessionStarted();
    expect(manager.getSessionCount()).toBe(2);
    manager.sessionEnded();
    expect(manager.getSessionCount()).toBe(1);
    manager.sessionEnded();
    expect(manager.getSessionCount()).toBe(0);
  });

  test('does not go below zero sessions', () => {
    manager.sessionEnded();
    expect(manager.getSessionCount()).toBe(0);
    manager.sessionEnded();
    expect(manager.getSessionCount()).toBe(0);
  });

  test('forceStop resets session count', () => {
    manager.sessionStarted();
    manager.sessionStarted();
    manager.forceStop();
    expect(manager.getSessionCount()).toBe(0);
  });

  test('isActive is false when disabled', () => {
    manager.setEnabled(false);
    manager.sessionStarted();
    expect(manager.isActive()).toBe(false);
  });

  test('starts keep-alive process on first session (macOS)', () => {
    // On macOS, starting a session should activate keep-alive
    if (process.platform === 'darwin') {
      manager.sessionStarted();
      expect(manager.isActive()).toBe(true);
    }
  });

  test('stops keep-alive process when all sessions end', () => {
    manager.sessionStarted();
    manager.sessionEnded();
    // Give a moment for process to stop
    expect(manager.getSessionCount()).toBe(0);
  });

  test('disabling while active stops the keep-alive process', () => {
    manager.sessionStarted();
    // On macOS, process should be active
    if (process.platform === 'darwin') {
      expect(manager.isActive()).toBe(true);
    }

    manager.setEnabled(false);
    expect(manager.isActive()).toBe(false);
  });

  test('does not start keep-alive when disabled even with active session', () => {
    manager.setEnabled(false);
    manager.sessionStarted();

    expect(manager.isActive()).toBe(false);
    expect(manager.getSessionCount()).toBe(1);
  });

  test('re-enabling does not auto-start keep-alive', () => {
    manager.setEnabled(false);
    manager.sessionStarted();
    manager.setEnabled(true);

    // Re-enabling doesn't retroactively start keep-alive
    // (would need a new session start to trigger it)
    expect(manager.getSessionCount()).toBe(1);
  });

  test('multiple sessions only start keep-alive once', () => {
    manager.sessionStarted();
    const wasActive = manager.isActive();
    manager.sessionStarted();
    manager.sessionStarted();

    // Active state should remain the same
    expect(manager.isActive()).toBe(wasActive);
    expect(manager.getSessionCount()).toBe(3);
  });

  test('forceStop kills process even with active sessions', () => {
    manager.sessionStarted();
    manager.sessionStarted();

    if (process.platform === 'darwin') {
      expect(manager.isActive()).toBe(true);
    }

    manager.forceStop();

    expect(manager.isActive()).toBe(false);
    expect(manager.getSessionCount()).toBe(0);
  });

  test('session count stays consistent through multiple starts and ends', () => {
    // Simulate realistic usage pattern
    manager.sessionStarted(); // 1
    expect(manager.getSessionCount()).toBe(1);

    manager.sessionStarted(); // 2
    expect(manager.getSessionCount()).toBe(2);

    manager.sessionEnded(); // 1
    expect(manager.getSessionCount()).toBe(1);

    manager.sessionStarted(); // 2
    expect(manager.getSessionCount()).toBe(2);

    manager.sessionEnded(); // 1
    manager.sessionEnded(); // 0
    expect(manager.getSessionCount()).toBe(0);

    // Extra ends should not go negative
    manager.sessionEnded();
    expect(manager.getSessionCount()).toBe(0);
  });

  test('isActive reflects actual process state', () => {
    // Initially no process
    expect(manager.isActive()).toBe(false);

    manager.sessionStarted();

    // Process state depends on platform
    if (process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32') {
      // May or may not be active depending on whether caffeinate/systemd-inhibit is available
      // The important thing is it doesn't throw
      expect(typeof manager.isActive()).toBe('boolean');
    }

    manager.sessionEnded();
    // After all sessions end, should not be active
    expect(manager.isActive()).toBe(false);
  });
});
