import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { OUTBOUND_ENV } from './outbound-env.js';

const ROOT = join(import.meta.dir, '..', '..');

/**
 * Contract test: pin the env-variable names that flow from the bot
 * (buildPermissionArgs) into the MCP child (mcp-server.ts).
 *
 * Without this, a rename like SESSION_UPLOAD_DIR → SESSION_UPLOADS_DIR on
 * one side only would compile, type-check, pass every existing unit test,
 * and break send_file silently at runtime by zeroing out the allowed-roots
 * list inside the validator.
 *
 * Strategy:
 *   1. The names live in `src/mcp/outbound-env.ts` as a typed const map.
 *   2. Both sides import `OUTBOUND_ENV` and read it as `OUTBOUND_ENV.X`,
 *      never as a bare string literal.
 *   3. This test reads both source files and asserts:
 *      a) every name in OUTBOUND_ENV is referenced via OUTBOUND_ENV.<name>
 *         on each side.
 *      b) the names don't appear as bare string literals on either side
 *         (catches a copy-paste rename that switched to a literal).
 *
 * Drift detector. Cheap. Trips loudly.
 */

describe('OUTBOUND_ENV contract', () => {
  const cliSrc = readFileSync(join(ROOT, 'src/claude/cli.ts'), 'utf-8');
  const serverSrc = readFileSync(join(ROOT, 'src/mcp/mcp-server.ts'), 'utf-8');

  for (const name of Object.keys(OUTBOUND_ENV) as Array<keyof typeof OUTBOUND_ENV>) {
    it(`bot side (cli.ts) reads ${name} via OUTBOUND_ENV.${name}`, () => {
      expect(cliSrc).toContain(`OUTBOUND_ENV.${name}`);
    });

    it(`MCP child (mcp-server.ts) reads ${name} via OUTBOUND_ENV.${name}`, () => {
      expect(serverSrc).toContain(`OUTBOUND_ENV.${name}`);
    });

    it(`${name} is not used as a bare string literal on either side`, () => {
      // Bare literal: a quoted occurrence of the name that's NOT prefixed with
      // OUTBOUND_ENV. Easiest robust check: the string `'${name}'` or
      // `"${name}"` should not appear in either file. (The shared module
      // outbound-env.ts is allowed to use the literal — that's where the
      // names are defined.)
      const literalSingle = `'${name}'`;
      const literalDouble = `"${name}"`;
      expect(cliSrc.includes(literalSingle) || cliSrc.includes(literalDouble)).toBe(false);
      expect(serverSrc.includes(literalSingle) || serverSrc.includes(literalDouble)).toBe(false);
    });
  }

  it('shared module exports the expected name set', () => {
    // If a name is added/removed without intent, this fails — forces an
    // explicit choice to update the contract.
    expect(Object.keys(OUTBOUND_ENV).sort()).toEqual([
      'OUTBOUND_FILES_ENABLED',
      'OUTBOUND_FILES_MAX_BYTES',
      'SESSION_UPLOAD_DIR',
      'SESSION_WORKING_DIR',
    ]);
  });

  it('every value matches its key (catches mistyped values like SESSION_UPLOADS_DIR)', () => {
    for (const [k, v] of Object.entries(OUTBOUND_ENV)) {
      expect(v as string).toBe(k);
    }
  });
});
