import { describe, test, expect, beforeEach, afterEach, it } from 'bun:test';
import {
  resolveLimits,
  LIMITS_DEFAULTS,
  resolvePermissionMode,
  permissionModeDisplay,
  permissionModeDescription,
  effectivePermissionMode,
  resolveOverheadVisibility,
  isOverheadVisibility,
  DEFAULT_OVERHEAD_VISIBILITY,
  OVERHEAD_VISIBILITY_VALUES,
} from './index.js';
import { rmSync, existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';
import { join } from 'path';
import { tmpdir } from 'os';
import { saveConfig, loadConfigWithMigration, configExists, CONFIG_PATH, type Config } from './index.js';

describe('saveConfig', () => {
  let testDir: string;
  let testConfigPath: string;

  beforeEach(() => {
    // Create a unique test directory path (don't create it yet - saveConfig should do that)
    testDir = join(tmpdir(), `claude-threads-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    testConfigPath = join(testDir, 'config.yaml');
  });

  afterEach(() => {
    // Clean up test directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  const createTestConfig = (): Config => ({
    version: 2,
    workingDir: '/test/path',
    chrome: false,
    worktreeMode: 'prompt',
    platforms: [],
  });

  test('creates directory if it does not exist', () => {
    const config = createTestConfig();

    expect(existsSync(testDir)).toBe(false);

    saveConfig(config, testConfigPath);

    expect(existsSync(testDir)).toBe(true);
  });

  test('creates directory with 0o700 permissions (owner-only access)', () => {
    const config = createTestConfig();

    saveConfig(config, testConfigPath);

    const stats = statSync(testDir);
    const permissions = stats.mode & 0o777;
    expect(permissions).toBe(0o700);
  });

  test('creates config file with 0o600 permissions (owner read/write only)', () => {
    const config = createTestConfig();

    saveConfig(config, testConfigPath);

    expect(existsSync(testConfigPath)).toBe(true);

    const stats = statSync(testConfigPath);
    const permissions = stats.mode & 0o777;
    expect(permissions).toBe(0o600);
  });

  test('writes valid YAML content', () => {
    const config: Config = {
      version: 2,
      workingDir: '/home/user/project',
      chrome: true,
      worktreeMode: 'require',
      platforms: [
        {
          id: 'slack',
          type: 'slack',
          displayName: 'Test Slack',
        },
      ],
    };

    saveConfig(config, testConfigPath);

    const content = readFileSync(testConfigPath, 'utf-8');
    const parsed = yaml.load(content) as Config;

    expect(parsed.version).toBe(2);
    expect(parsed.workingDir).toBe('/home/user/project');
    expect(parsed.chrome).toBe(true);
    expect(parsed.worktreeMode).toBe('require');
    expect(parsed.platforms).toHaveLength(1);
    expect(parsed.platforms[0].id).toBe('slack');
  });

  test('round-trips respondOnlyWhenMentioned through YAML (#402)', () => {
    const config: Config = {
      version: 2,
      workingDir: '/home/user/project',
      chrome: false,
      worktreeMode: 'prompt',
      respondOnlyWhenMentioned: true,
      platforms: [{ id: 'slack', type: 'slack', displayName: 'Test Slack' }],
    };

    saveConfig(config, testConfigPath);
    const parsed = yaml.load(readFileSync(testConfigPath, 'utf-8')) as Config;

    expect(parsed.respondOnlyWhenMentioned).toBe(true);
  });

  test('fixes permissions on existing directory with wrong permissions', () => {
    // Pre-create directory with wrong permissions
    mkdirSync(testDir, { recursive: true, mode: 0o755 });

    let stats = statSync(testDir);
    expect(stats.mode & 0o777).toBe(0o755); // Verify wrong permissions

    const config = createTestConfig();
    saveConfig(config, testConfigPath);

    // Permissions should now be fixed
    stats = statSync(testDir);
    expect(stats.mode & 0o777).toBe(0o700);
  });

  test('fixes permissions on existing file with wrong permissions', () => {
    // Pre-create directory and file with wrong permissions
    mkdirSync(testDir, { recursive: true, mode: 0o755 });
    writeFileSync(testConfigPath, 'old content', { mode: 0o644 });

    let stats = statSync(testConfigPath);
    expect(stats.mode & 0o777).toBe(0o644); // Verify wrong permissions

    const config = createTestConfig();
    saveConfig(config, testConfigPath);

    // Permissions should now be fixed
    stats = statSync(testConfigPath);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  test('overwrites existing config file', () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(testConfigPath, 'old: content\n');

    const config: Config = {
      version: 2,
      workingDir: '/new/path',
      chrome: false,
      worktreeMode: 'off',
      platforms: [],
    };

    saveConfig(config, testConfigPath);

    const content = readFileSync(testConfigPath, 'utf-8');
    expect(content).not.toContain('old: content');
    expect(content).toContain('workingDir: /new/path');
  });

  test('handles platforms with sensitive tokens', () => {
    const config: Config = {
      version: 2,
      workingDir: '/test',
      chrome: false,
      worktreeMode: 'prompt',
      platforms: [
        {
          id: 'mattermost',
          type: 'mattermost',
          displayName: 'Test',
          url: 'https://chat.example.com',
          token: 'super-secret-token-12345',
          channelId: 'abc',
          botName: 'bot',
          allowedUsers: [],
          skipPermissions: false,
        },
      ],
    };

    saveConfig(config, testConfigPath);

    // Token is saved (which is why we need secure permissions!)
    const content = readFileSync(testConfigPath, 'utf-8');
    expect(content).toContain('super-secret-token-12345');

    // But file has secure permissions
    const stats = statSync(testConfigPath);
    expect(stats.mode & 0o777).toBe(0o600);
  });
});

describe('CONFIG_PATH', () => {
  test('is defined and points to config.yaml', () => {
    expect(CONFIG_PATH).toBeDefined();
    expect(CONFIG_PATH).toContain('config.yaml');
    expect(CONFIG_PATH).toContain('.config');
    expect(CONFIG_PATH).toContain('claude-threads');
  });
});

describe('configExists', () => {
  test('returns boolean', () => {
    // Just verify it returns a boolean (actual result depends on user's system)
    const result = configExists();
    expect(typeof result).toBe('boolean');
  });
});

describe('loadConfigWithMigration', () => {
  test('returns null or valid config', () => {
    // This tests the actual config file on the system
    // It should either return null (no config) or a valid config object
    const result = loadConfigWithMigration();

    if (result !== null) {
      expect(result).toHaveProperty('version');
      expect(result).toHaveProperty('workingDir');
      expect(result).toHaveProperty('platforms');
      expect(Array.isArray(result.platforms)).toBe(true);
    }
  });
});

describe('resolveLimits — flushDelayMs tunable', () => {
  it('defaults to 500ms when unset', () => {
    expect(resolveLimits().flushDelayMs).toBe(LIMITS_DEFAULTS.flushDelayMs);
    expect(resolveLimits({}).flushDelayMs).toBe(500);
  });

  it('honors explicit flushDelayMs from config', () => {
    expect(resolveLimits({ flushDelayMs: 100 }).flushDelayMs).toBe(100);
    expect(resolveLimits({ flushDelayMs: 2000 }).flushDelayMs).toBe(2000);
  });

  it('preserves defaults for unset siblings when flushDelayMs is set', () => {
    const r = resolveLimits({ flushDelayMs: 123 });
    expect(r.maxSessions).toBe(LIMITS_DEFAULTS.maxSessions);
    expect(r.sessionTimeoutMinutes).toBe(LIMITS_DEFAULTS.sessionTimeoutMinutes);
  });
});

describe('resolvePermissionMode', () => {
  it('returns permissionMode verbatim when set', () => {
    expect(resolvePermissionMode({ permissionMode: 'auto' })).toBe('auto');
    expect(resolvePermissionMode({ permissionMode: 'bypass' })).toBe('bypass');
    expect(resolvePermissionMode({ permissionMode: 'default' })).toBe('default');
  });

  it('prefers permissionMode over legacy skipPermissions when both set', () => {
    expect(resolvePermissionMode({ permissionMode: 'auto', skipPermissions: true })).toBe('auto');
    expect(resolvePermissionMode({ permissionMode: 'default', skipPermissions: true })).toBe('default');
  });

  it('falls back to skipPermissions when permissionMode is unset', () => {
    expect(resolvePermissionMode({ skipPermissions: true })).toBe('bypass');
    expect(resolvePermissionMode({ skipPermissions: false })).toBe('default');
  });

  it("defaults to 'default' when neither is set", () => {
    expect(resolvePermissionMode({})).toBe('default');
  });
});

describe('permissionModeDisplay', () => {
  it('returns icon + label + chip for each mode', () => {
    expect(permissionModeDisplay('default')).toEqual({ icon: '🔐', label: 'Default', chip: '🔐 Default' });
    expect(permissionModeDisplay('auto')).toEqual({ icon: '⚡', label: 'Auto', chip: '⚡ Auto' });
    expect(permissionModeDisplay('bypass')).toEqual({ icon: '⚠️', label: 'Bypass', chip: '⚠️ Bypass' });
  });
});

describe('permissionModeDescription', () => {
  it('returns a distinct human-readable description per mode', () => {
    const d = permissionModeDescription('default');
    const a = permissionModeDescription('auto');
    const b = permissionModeDescription('bypass');
    expect(d).not.toBe(a);
    expect(a).not.toBe(b);
    expect(d).toContain('prompt');
    expect(b.toLowerCase()).toContain('allow');
  });
});

describe('effectivePermissionMode', () => {
  const noOverride = undefined;

  it('returns bot-wide mode when no session-level overrides are set', () => {
    expect(effectivePermissionMode({ override: noOverride, sessionHasInteractiveOverride: false, botWideMode: 'default' })).toBe('default');
    expect(effectivePermissionMode({ override: noOverride, sessionHasInteractiveOverride: false, botWideMode: 'auto' })).toBe('auto');
    expect(effectivePermissionMode({ override: noOverride, sessionHasInteractiveOverride: false, botWideMode: 'bypass' })).toBe('bypass');
  });

  it('forceInteractivePermissions forces default, even over auto or bypass bot-wide', () => {
    expect(effectivePermissionMode({ override: noOverride, sessionHasInteractiveOverride: true, botWideMode: 'default' })).toBe('default');
    expect(effectivePermissionMode({ override: noOverride, sessionHasInteractiveOverride: true, botWideMode: 'auto' })).toBe('default');
    expect(effectivePermissionMode({ override: noOverride, sessionHasInteractiveOverride: true, botWideMode: 'bypass' })).toBe('default');
  });

  it('explicit override wins over both sticky flag and bot-wide', () => {
    expect(effectivePermissionMode({ override: 'auto', sessionHasInteractiveOverride: false, botWideMode: 'bypass' })).toBe('auto');
    expect(effectivePermissionMode({ override: 'bypass', sessionHasInteractiveOverride: true, botWideMode: 'default' })).toBe('bypass');
    expect(effectivePermissionMode({ override: 'default', sessionHasInteractiveOverride: false, botWideMode: 'auto' })).toBe('default');
  });
});

// ===========================================================================
// resolveOverheadVisibility — issue #383
// Per-platform sessionHeader / stickyMessage parsing.
// ===========================================================================

describe('resolveOverheadVisibility', () => {
  it('exposes the three valid values and a default of full', () => {
    expect([...OVERHEAD_VISIBILITY_VALUES].sort()).toEqual(['full', 'hidden', 'minimal']);
    expect(DEFAULT_OVERHEAD_VISIBILITY).toBe('full');
  });

  it('isOverheadVisibility narrows known values and rejects junk', () => {
    expect(isOverheadVisibility('full')).toBe(true);
    expect(isOverheadVisibility('minimal')).toBe(true);
    expect(isOverheadVisibility('hidden')).toBe(true);
    expect(isOverheadVisibility('FULL')).toBe(false);  // case-sensitive
    expect(isOverheadVisibility('off')).toBe(false);
    expect(isOverheadVisibility(undefined)).toBe(false);
    expect(isOverheadVisibility(null)).toBe(false);
    expect(isOverheadVisibility(true)).toBe(false);
  });

  it('returns the default when value is undefined or null (backward compat)', () => {
    expect(resolveOverheadVisibility(undefined, 'platforms[a].sessionHeader')).toBe('full');
    expect(resolveOverheadVisibility(null, 'platforms[a].sessionHeader')).toBe('full');
  });

  it('returns the value verbatim when valid', () => {
    expect(resolveOverheadVisibility('full', 'x')).toBe('full');
    expect(resolveOverheadVisibility('minimal', 'x')).toBe('minimal');
    expect(resolveOverheadVisibility('hidden', 'x')).toBe('hidden');
  });

  it('throws with the field path when value is invalid', () => {
    expect(() => resolveOverheadVisibility('off', 'platforms[mm-main].sessionHeader')).toThrow(
      /platforms\[mm-main\]\.sessionHeader.*expected one of full, minimal, hidden/i
    );
    expect(() => resolveOverheadVisibility(true, 'platforms[mm-main].stickyMessage')).toThrow(
      /platforms\[mm-main\]\.stickyMessage.*expected one of/
    );
  });
});
