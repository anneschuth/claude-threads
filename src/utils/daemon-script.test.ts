import { describe, it, expect, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const daemonPath = resolve(import.meta.dir, '..', '..', 'bin', 'claude-threads-daemon');

// The daemon used to `eval` its command, which re-parsed the entry path:
// backslashes (every Windows path) vanished and a space split it in two (#600).
describe.skipIf(process.platform === 'win32')('claude-threads-daemon', () => {
  const root = mkdtempSync(join(tmpdir(), 'daemon-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('runs an entry point whose path has a space and a backslash', () => {
    const dir = join(root, 'dir with space\\and backslash');
    mkdirSync(dir, { recursive: true });
    const entry = join(dir, 'entry.js');
    writeFileSync(entry, 'process.stdout.write("RAN " + JSON.stringify(process.argv.slice(2)) + "\\n");\n');

    const result = spawnSync('bash', [daemonPath, '--flag', 'two words'], {
      env: { ...process.env, CLAUDE_THREADS_BIN: entry },
      encoding: 'utf-8',
      timeout: 10000,
    });

    expect(result.stdout).toContain('RAN ["--flag","two words"]');
    expect(result.status).toBe(0);
  });
});
