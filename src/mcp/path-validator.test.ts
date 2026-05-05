import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, stat } from 'fs/promises';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { validateOutboundPath } from './path-validator.js';

const MAX = 1024 * 1024;

describe('validateOutboundPath', () => {
  let root: string;
  let allowedRoot: string;
  let outsideRoot: string;
  let okFile: string;
  let emptyFile: string;
  let bigFile: string;
  let suidFile: string;
  let dirInside: string;
  let symlinkInside: string;
  let symlinkEscape: string;

  beforeAll(async () => {
    // realpath the tmpdir root because on macOS /tmp -> /private/tmp; the
    // validator returns realpath-resolved paths, so the allowed roots fed to
    // it must also be realpath-resolved or every legitimate file fails.
    root = await realpath(await mkdtemp(join(tmpdir(), 'path-validator-test-')));
    allowedRoot = join(root, 'session');
    outsideRoot = join(root, 'outside');
    await mkdir(allowedRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });

    okFile = join(allowedRoot, 'ok.txt');
    await writeFile(okFile, 'hello world');

    emptyFile = join(allowedRoot, 'empty.txt');
    await writeFile(emptyFile, '');

    bigFile = join(allowedRoot, 'big.bin');
    await writeFile(bigFile, Buffer.alloc(MAX + 1, 0xff));

    suidFile = join(allowedRoot, 'suid.bin');
    await writeFile(suidFile, 'x');
    // Bun's fs.promises.chmod strips the SUID bit (verified 2026-05-05); shell out so
    // the bit actually lands. The validator itself uses fs.stat which surfaces SUID
    // correctly when a real filesystem reports it.
    execFileSync('chmod', ['4755', suidFile]);
    const s = await stat(suidFile);
    if (!(s.mode & 0o4000)) {
      throw new Error(`SUID setup failed: mode is ${s.mode.toString(8)}`);
    }

    dirInside = join(allowedRoot, 'subdir');
    await mkdir(dirInside);

    // Symlink that points back inside — should be allowed.
    symlinkInside = join(allowedRoot, 'link-inside');
    await symlink(okFile, symlinkInside);

    // Symlink that escapes the allowed root — should be rejected.
    const escapeTarget = join(outsideRoot, 'secret.txt');
    await writeFile(escapeTarget, 'secret');
    symlinkEscape = join(allowedRoot, 'link-escape');
    await symlink(escapeTarget, symlinkEscape);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('accepts a plain file inside the allowed root', async () => {
    const result = await validateOutboundPath(okFile, { allowedRoots: [allowedRoot], maxBytes: MAX });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.size).toBe(11);
      expect(result.basename).toBe('ok.txt');
    }
  });

  it('rejects relative paths', async () => {
    const result = await validateOutboundPath('relative/path.txt', { allowedRoots: [allowedRoot], maxBytes: MAX });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/absolute/);
  });

  it('rejects empty path', async () => {
    const result = await validateOutboundPath('', { allowedRoots: [allowedRoot], maxBytes: MAX });
    expect(result.ok).toBe(false);
  });

  it('rejects a path outside any allowed root', async () => {
    const outside = join(outsideRoot, 'somefile.txt');
    await writeFile(outside, 'data');
    const result = await validateOutboundPath(outside, { allowedRoots: [allowedRoot], maxBytes: MAX });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/outside/i);
  });

  it('rejects a symlink that escapes the allowed root via realpath', async () => {
    const result = await validateOutboundPath(symlinkEscape, { allowedRoots: [allowedRoot], maxBytes: MAX });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/outside/i);
  });

  it('accepts a symlink whose target is inside the allowed root', async () => {
    const result = await validateOutboundPath(symlinkInside, { allowedRoots: [allowedRoot], maxBytes: MAX });
    expect(result.ok).toBe(true);
  });

  it('rejects directories', async () => {
    const result = await validateOutboundPath(dirInside, { allowedRoots: [allowedRoot], maxBytes: MAX });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/regular file/i);
  });

  it('rejects SUID files', async () => {
    const result = await validateOutboundPath(suidFile, { allowedRoots: [allowedRoot], maxBytes: MAX });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SUID/i);
  });

  it('rejects oversized files', async () => {
    const result = await validateOutboundPath(bigFile, { allowedRoots: [allowedRoot], maxBytes: MAX });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/too large/i);
  });

  it('rejects zero-byte files', async () => {
    const result = await validateOutboundPath(emptyFile, { allowedRoots: [allowedRoot], maxBytes: MAX });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/empty/i);
  });

  it('rejects a path-prefix collision (sibling directory with same prefix)', async () => {
    // Allowed: /tmp/.../session ; attempt: /tmp/.../session-evil/file.txt
    const sibling = `${allowedRoot}-evil`;
    await mkdir(sibling, { recursive: true });
    const evilFile = join(sibling, 'data.txt');
    await writeFile(evilFile, 'data');
    const result = await validateOutboundPath(evilFile, { allowedRoots: [allowedRoot], maxBytes: MAX });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/outside/i);
  });

  it('accepts a file under any of multiple allowed roots', async () => {
    const second = join(root, 'uploads');
    await mkdir(second, { recursive: true });
    const f = join(second, 'thing.txt');
    await writeFile(f, 'thing');
    const result = await validateOutboundPath(f, { allowedRoots: [allowedRoot, second], maxBytes: MAX });
    expect(result.ok).toBe(true);
  });

  it('rejects a non-existent path', async () => {
    const result = await validateOutboundPath(join(allowedRoot, 'nope.txt'), {
      allowedRoots: [allowedRoot],
      maxBytes: MAX,
    });
    expect(result.ok).toBe(false);
  });
});
