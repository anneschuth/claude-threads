import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, stat, rm, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setMode } from './chmod-portable.js';

describe('setMode', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'chmod-portable-')));
    file = join(dir, 'a');
    await writeFile(file, 'x');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lands the SUID bit (the original Bun footgun)', async () => {
    await setMode(file, 0o4755);
    const s = await stat(file);
    expect(s.mode & 0o7777).toBe(0o4755);
    expect(!!(s.mode & 0o4000)).toBe(true);
  });

  it('lands the SGID bit', async () => {
    await setMode(file, 0o2755);
    const s = await stat(file);
    expect(s.mode & 0o7777).toBe(0o2755);
  });

  it('lands plain mode bits without high bits unchanged', async () => {
    await setMode(file, 0o600);
    const s = await stat(file);
    expect(s.mode & 0o7777).toBe(0o600);
  });
});
