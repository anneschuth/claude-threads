import { describe, it, expect, afterAll } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';

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

// A command resolved through PATH the way the bot resolves `claude`: on
// Windows an npm-style .cmd shim, elsewhere a shell script. The shim hands its
// argv to a script that echoes it back as JSON.
describe('crossSpawn argument passing (#600)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cross-spawn-'));
  writeFileSync(join(dir, 'echo-args.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'argshim.cmd'), `@"${process.execPath}" "%~dp0echo-args.js" %*\r\n`);
  } else {
    const shim = join(dir, 'argshim');
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/echo-args.js" "$@"\n`);
    chmodSync(shim, 0o755);
  }
  // Windows spells it Path; set both so whichever the lookup reads wins.
  const searchPath = `${dir}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`;
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: searchPath };
  if (process.platform === 'win32') env.Path = searchPath;

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const args = [
    // The --append-system-prompt value that broke every session on Windows.
    '**Platform:** mattermost (Main) | **Working Directory:** C:\\repo | **Thread:** https://chat/x',
    'a & b',
    'semi; colon',
    '"quoted" and \'single\'',
    '100% %PATH% ^caret',
    '<in> out >> append',
    '(parens) !bang!',
    '{"mcpServers":{"x":{"type":"stdio","args":["a b"]}}}',
    'C:\\path with space\\',
    '',
  ];

  it('crossSpawnSync passes every argument through unchanged', () => {
    const result = crossSpawnSync('argshim', args, { env, encoding: 'utf-8' });
    expect(result.stderr).toBe('');
    expect(JSON.parse(String(result.stdout))).toEqual(args);
  });

  it('crossSpawn passes every argument through unchanged', async () => {
    const proc = crossSpawn('argshim', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
    proc.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const code = await new Promise<number | null>((resolve) => proc.on('close', resolve));
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual(args);
  });
});
