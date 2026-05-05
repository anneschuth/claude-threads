import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { validateOutboundPath } from './path-validator.js';
import { setMode } from '../test-utils/chmod-portable.js';

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
    // Use the portable setMode helper — Bun's fs.chmod strips SUID, so this
    // verifies-then-shells-out as needed. See src/test-utils/chmod-portable.ts.
    await setMode(suidFile, 0o4755);
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

  // -- Dangerously wide roots ------------------------------------------------

  it.each([['/'], ['/home'], ['/Users'], ['/root'], ['/etc'], ['/var'], ['/tmp'], ['/usr'], ['/opt']])(
    'refuses dangerously wide allowed root %s',
    async (root) => {
      const result = await validateOutboundPath('/etc/passwd', {
        allowedRoots: [root],
        maxBytes: MAX,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/dangerously wide|SESSION_WORKING_DIR/i);
    },
  );

  it.each([['/private/tmp'], ['/private/var'], ['/private/etc']])(
    'refuses macOS-resolved wide roots %s',
    async (root) => {
      const result = await validateOutboundPath(okFile, {
        allowedRoots: [root],
        maxBytes: MAX,
      });
      expect(result.ok).toBe(false);
    },
  );

  it('refuses if ANY of multiple roots is dangerously wide', async () => {
    const result = await validateOutboundPath(okFile, {
      allowedRoots: [allowedRoot, '/'],
      maxBytes: MAX,
    });
    expect(result.ok).toBe(false);
  });

  it('accepts a normal nested working directory (e.g. /home/anne/proj)', async () => {
    // The allowedRoot in beforeAll is mkdtemp'd under tmpdir() — already
    // several segments deep, not a wide root. This test mostly documents
    // that the wide-root check doesn't accidentally trip on legitimate
    // session dirs.
    const result = await validateOutboundPath(okFile, { allowedRoots: [allowedRoot], maxBytes: MAX });
    expect(result.ok).toBe(true);
  });

  // -- Invalid maxBytes ------------------------------------------------------

  it('rejects negative maxBytes with a config-blame message', async () => {
    const result = await validateOutboundPath(okFile, { allowedRoots: [allowedRoot], maxBytes: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/invalid maxBytes|outboundFiles\.maxBytes/i);
  });

  it('rejects zero maxBytes', async () => {
    const result = await validateOutboundPath(okFile, { allowedRoots: [allowedRoot], maxBytes: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/invalid maxBytes/i);
  });

  it('rejects NaN maxBytes', async () => {
    const result = await validateOutboundPath(okFile, { allowedRoots: [allowedRoot], maxBytes: NaN });
    expect(result.ok).toBe(false);
  });

  it('rejects Infinity maxBytes (treated as misconfiguration)', async () => {
    const result = await validateOutboundPath(okFile, { allowedRoots: [allowedRoot], maxBytes: Infinity });
    expect(result.ok).toBe(false);
  });
});
