/**
 * PlatformListStore base-class tests — the invariants every subclass
 * (routines, watches) inherits: the read cache must never diverge from disk
 * after a failed write, and the cached object graph must never leak out as
 * live references (exercised through a minimal concrete subclass, per the
 * red-green policy: these fail against a base without the fixes).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PlatformListStore } from './platform-list-store.js';

interface Item {
  id: string;
  name: string;
  nested?: { count: number };
}

class TestStore extends PlatformListStore<Item> {
  failNextPersist = false;
  warnings: string[] = [];

  constructor(filePath: string) {
    super('items', filePath, filePath);
  }

  protected applyItemDefaults(): void {}

  protected warn(message: string): void {
    this.warnings.push(message);
  }

  protected override persistFile(content: string): void {
    if (this.failNextPersist) {
      this.failNextPersist = false;
      throw new Error('disk full');
    }
    super.persistFile(content);
  }

  add(platformId: string, item: Item): Promise<void> {
    return this.runExclusive(() => {
      const data = this.loadRaw(true);
      data.items[platformId] = [...(data.items[platformId] ?? []), item];
      this.writeAtomic(data);
    });
  }
}

describe('PlatformListStore', () => {
  let dir: string;
  let store: TestStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ct-pls-test-'));
    store = new TestStore(join(dir, 'items.yaml'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('a failed write leaves no phantom item in the cache (add)', async () => {
    await store.add('mm', { id: 'a', name: 'first' });

    store.failNextPersist = true;
    await expect(store.add('mm', { id: 'b', name: 'phantom' })).rejects.toThrow('disk full');

    // Disk still holds only the first item; the cache must agree — a phantom
    // 'b' here means the user was told the save failed while the item lists
    // (and, for watches, fires) anyway.
    expect(store.list('mm').map((i) => i.id)).toEqual(['a']);
  });

  test('a failed write leaves no phantom mutation in the cache (update)', async () => {
    await store.add('mm', { id: 'a', name: 'original' });

    store.failNextPersist = true;
    await expect(store.update('mm', 'a', { name: 'phantom' })).rejects.toThrow('disk full');

    expect(store.get('mm', 'a')?.name).toBe('original');
  });

  test('a failed write leaves no phantom removal in the cache (remove)', async () => {
    await store.add('mm', { id: 'a', name: 'keep me' });

    store.failNextPersist = true;
    await expect(store.remove('mm', 'a')).rejects.toThrow('disk full');

    expect(store.get('mm', 'a')?.name).toBe('keep me');
  });

  test('list() returns a snapshot — caller mutations never reach the store', async () => {
    await store.add('mm', { id: 'a', name: 'first', nested: { count: 1 } });
    await store.add('mm', { id: 'b', name: 'second' });

    const listed = store.list('mm');
    listed.splice(0, 1); // a concurrent remove() must not shift an iterating caller
    listed[0].name = 'mutated';
    store.list('mm')[0].nested!.count = 99;

    expect(store.list('mm').map((i) => i.name)).toEqual(['first', 'second']);
    expect(store.get('mm', 'a')?.nested?.count).toBe(1);
  });

  test('mutating ops refuse to write over an existing but unreadable file', async () => {
    const { writeFileSync, readFileSync } = await import('fs');
    await store.add('mm', { id: 'a', name: 'survivor' });
    const file = join(dir, 'items.yaml');

    // Simulate corruption (or a transient read failure): the file EXISTS but
    // cannot be parsed. Reads degrade to empty; writes proceeding on that
    // emptiness would atomically replace the file, destroying every
    // platform's items — so they must refuse instead.
    writeFileSync(file, '{');

    await expect(store.add('mm', { id: 'b', name: 'destroyer' })).rejects.toThrow('refusing to write');
    await expect(store.update('mm', 'a', { name: 'x' })).rejects.toThrow('refusing to write');
    await expect(store.remove('mm', 'a')).rejects.toThrow('refusing to write');

    // The unreadable file is preserved on disk for recovery, not replaced.
    expect(readFileSync(file, 'utf-8')).toBe('{');
    // Reads still degrade gracefully.
    expect(store.list('mm')).toEqual([]);
    expect(store.warnings.length).toBeGreaterThan(0);
  });

  test('update() returns a copy, not the live cached item', async () => {
    await store.add('mm', { id: 'a', name: 'original' });

    const updated = await store.update('mm', 'a', { name: 'renamed' });
    updated!.name = 'mutated-by-caller';

    expect(store.get('mm', 'a')?.name).toBe('renamed');
  });
});
