/**
 * Shared primitives for the bot's small on-disk stores: a promise-tail mutex
 * to serialize mutations in-process, and an owner-only atomic file write
 * (tmp + rename + chmod). session-store and github-emails-store still carry
 * hand-rolled copies of this pattern from before the extraction — migrate
 * them here opportunistically so hardening (fsync, tmp cleanup, error
 * policy) lands once instead of per store.
 */

import { chmodSync, renameSync, writeFileSync } from 'fs';

/** Serialize async mutations: each call runs after the previous one settles. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    // Park the tail, swallowing rejections so one failure doesn't poison the chain.
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** Write owner-only (0600) via tmp file + rename so readers never see a torn file. */
export function writeFileAtomic(file: string, content: string): void {
  const tempFile = `${file}.tmp`;
  writeFileSync(tempFile, content, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tempFile, file);
  chmodSync(file, 0o600);
}
