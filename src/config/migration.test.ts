import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';
import { join } from 'path';
import { tmpdir } from 'os';
import { saveConfig, loadConfigWithMigration, configExists, CONFIG_PATH, type Config } from './migration.js';

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
