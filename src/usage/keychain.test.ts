import { describe, it, expect } from 'bun:test';
import { userInfo } from 'os';
import { keychainReadArgs, keychainWriteArgs, keychainFailure } from './client.js';

const SERVICE = 'Claude Code-credentials-166321ee';
const BLOB = JSON.stringify({
  claudeAiOauth: { accessToken: 'sk-ACCESS-SENTINEL', refreshToken: 'sk-REFRESH-SENTINEL' },
});

describe('keychain argv', () => {
  it('writes to the item Claude Code actually owns: service + OS username', () => {
    // Verified against the live Keychain: the account on Claude Code's items is
    // the OS username, not the service string. Writing with the service string
    // as the account creates a SECOND item — Claude Code then keeps reading its
    // old, now-rotated-away refresh token and the seat is dead until someone
    // logs in by hand.
    const args = keychainWriteArgs(SERVICE, BLOB);

    expect(args[args.indexOf('-s') + 1]).toBe(SERVICE);
    expect(args[args.indexOf('-a') + 1]).toBe(userInfo().username);
  });

  it('reads the same item it writes', () => {
    const read = keychainReadArgs(SERVICE);

    expect(read[read.indexOf('-s') + 1]).toBe(SERVICE);
    expect(read[read.indexOf('-a') + 1]).toBe(userInfo().username);
  });
});

describe('keychainFailure', () => {
  it('never repeats the command, because the blob is in argv and this reaches Slack', () => {
    // `security -w <blob>` puts both tokens in argv, and execFile puts the whole
    // argv in its error message. That message is rendered into a Slack post
    // verbatim, so it must be rebuilt from the exit code and stderr alone.
    const raw = Object.assign(
      new Error(`Command failed: security add-generic-password -U -s ${SERVICE} -a almir -w ${BLOB}`),
      { code: 45, stderr: 'security: SecKeychainItemModifyContent: Write permissions error.' }
    );

    const message = keychainFailure(raw).message;

    expect(message).not.toContain('sk-ACCESS-SENTINEL');
    expect(message).not.toContain('sk-REFRESH-SENTINEL');
    expect(message).not.toContain('add-generic-password');
    // Still has to say something a human can act on.
    expect(message).toContain('45');
    expect(message).toContain('Write permissions error');
  });

  it('survives an error carrying no code or stderr without leaking the original', () => {
    const raw = new Error(`Command failed: security ... -w ${BLOB}`);

    const message = keychainFailure(raw).message;

    expect(message).not.toContain('sk-ACCESS-SENTINEL');
    expect(message).not.toContain('sk-REFRESH-SENTINEL');
  });
});
