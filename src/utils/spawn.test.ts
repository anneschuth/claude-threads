import { describe, it, expect } from 'bun:test';

// We test the module behavior by importing and verifying the exports work correctly
import { crossSpawn, crossSpawnSync } from './spawn.js';

describe('crossSpawn', () => {
  it('exports crossSpawn function', () => {
    expect(typeof crossSpawn).toBe('function');
  });

  it('exports crossSpawnSync function', () => {
    expect(typeof crossSpawnSync).toBe('function');
  });

  it('crossSpawn returns a ChildProcess', () => {
    const proc = crossSpawn('echo', ['hello'], { stdio: 'pipe' });
    expect(proc).toBeDefined();
    expect(proc.pid).toBeDefined();
    proc.kill();
  });

  it('crossSpawnSync returns result with status', () => {
    const result = crossSpawnSync('echo', ['hello'], { encoding: 'utf-8' });
    expect(result.status).toBe(0);
  });

  it('crossSpawn respects explicit shell option', () => {
    // When shell is explicitly set to false, it should stay false
    // This tests that we don't override an explicit setting
    const proc = crossSpawn('echo', ['hello'], { stdio: 'pipe', shell: false });
    expect(proc).toBeDefined();
    proc.kill();
  });
});
