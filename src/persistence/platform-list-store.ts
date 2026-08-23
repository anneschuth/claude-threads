/**
 * PlatformListStore — shared base for the small per-platform YAML list
 * stores (routines, watches): a versioned file holding
 * `Record<platformId, T[]>`, 0600 atomic writes, and an in-process write
 * mutex. platformId is the hard privacy boundary (≈ one channel), mirroring
 * the memory store.
 *
 * Subclasses own their domain: the `add` validation, the narrowed `update`
 * patch type, and any defensive per-item defaults (`applyItemDefaults`).
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import yaml from 'js-yaml';
import { SerialQueue, writeFileAtomic } from './atomic-file.js';

export const STORES_CONFIG_DIR = join(homedir(), '.config', 'claude-threads');

const STORE_VERSION = 1;

interface FileShape<T> {
  version: number;
  items: Record<string, T[]>;
}

export abstract class PlatformListStore<T extends { id: string }> {
  protected readonly file: string;
  private readonly configDir: string;
  /** In-process write mutex (single bot process owns the file). */
  private readonly queue = new SerialQueue();
  /** Top-level YAML key the platform map lives under (e.g. "routines"). */
  private readonly collectionKey: string;
  /**
   * mtime-keyed read cache: list() sits on hot paths (every channel message
   * for watches, every scheduler tick for routines), and re-parsing YAML per
   * call would put blocking parse work on the event loop. A stat() per read
   * still detects out-of-band writes (another store instance, hand edits).
   */
  private cache: { mtimeMs: number; size: number; data: FileShape<T> } | null = null;

  protected constructor(collectionKey: string, defaultFile: string, filePath?: string) {
    this.collectionKey = collectionKey;
    if (filePath) {
      this.file = filePath;
      this.configDir = join(filePath, '..');
    } else {
      this.file = defaultFile;
      this.configDir = STORES_CONFIG_DIR;
    }
    mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
  }

  /** Defensive defaults applied to every loaded item (forward/backward compat). */
  protected abstract applyItemDefaults(item: T): void;

  /** Read-failure log hook (subclasses own their logger/component name). */
  protected abstract warn(message: string): void;

  /**
   * List a platform's items. Returns a deep copy — the cached graph is the
   * store's source of truth between writes, so handing out live references
   * would let callers corrupt it (a mutation would stick in memory without
   * ever being persisted) and would let a concurrent remove() splice an
   * array out from under an iterating caller.
   */
  list(platformId: string): T[] {
    return structuredClone(this.loadRaw().items[platformId] ?? []);
  }

  get(platformId: string, id: string): T | undefined {
    return this.list(platformId).find((item) => item.id === id);
  }

  /** Merge a partial update into one item. Returns a copy of the updated item or undefined. */
  update(platformId: string, id: string, patch: Partial<T>): Promise<T | undefined> {
    return this.runExclusive(() => {
      const data = this.loadRaw();
      const items = data.items[platformId] ?? [];
      const idx = items.findIndex((item) => item.id === id);
      if (idx < 0) return undefined;
      items[idx] = { ...items[idx], ...patch };
      this.writeAtomic(data);
      return structuredClone(items[idx]);
    });
  }

  /** Remove an item. Returns the removed item or undefined. */
  remove(platformId: string, id: string): Promise<T | undefined> {
    return this.runExclusive(() => {
      const data = this.loadRaw();
      const items = data.items[platformId] ?? [];
      const idx = items.findIndex((item) => item.id === id);
      if (idx < 0) return undefined;
      const [removed] = items.splice(idx, 1);
      if (items.length === 0) delete data.items[platformId];
      this.writeAtomic(data);
      this.onRemoved(platformId, removed);
      return removed;
    });
  }

  /** Post-remove log hook. */
  protected onRemoved(_platformId: string, _item: T): void {}

  // -- protected plumbing for subclass `add` implementations ------------------

  protected runExclusive<R>(fn: () => R): Promise<R> {
    return this.queue.run(fn);
  }

  protected loadRaw(): FileShape<T> {
    if (!existsSync(this.file)) {
      this.cache = null;
      return { version: STORE_VERSION, items: {} };
    }
    try {
      const stat = statSync(this.file);
      if (this.cache && this.cache.mtimeMs === stat.mtimeMs && this.cache.size === stat.size) {
        return this.cache.data;
      }
      const parsed = yaml.load(readFileSync(this.file, 'utf-8')) as Record<string, unknown> | undefined;
      if (!parsed || typeof parsed !== 'object') {
        return { version: STORE_VERSION, items: {} };
      }
      const rawItems = parsed[this.collectionKey];
      const items = (rawItems && typeof rawItems === 'object')
        ? rawItems as Record<string, T[]>
        : {};
      for (const list of Object.values(items)) {
        for (const item of list) this.applyItemDefaults(item);
      }
      const data = { version: (parsed.version as number | undefined) ?? STORE_VERSION, items };
      this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, data };
      return data;
    } catch (err) {
      this.warn(`Failed to read ${this.file}: ${(err as Error).message} — starting empty`);
      this.cache = null;
      return { version: STORE_VERSION, items: {} };
    }
  }

  protected writeAtomic(data: FileShape<T>): void {
    try {
      this.persistFile(yaml.dump({ version: data.version, [this.collectionKey]: data.items }, { sortKeys: true, lineWidth: -1 }));
    } catch (err) {
      // `data` IS the cached object graph, already mutated by the caller,
      // while the file still holds the old state (atomic write: the target
      // is untouched on failure) — so its mtime/size still match the cache
      // key. Without invalidation every later read would serve the phantom
      // mutation until restart, diverging from what the user was told
      // (e.g. "could not save watch" — yet the watch lists and fires).
      this.cache = null;
      throw err;
    }
    // The written object graph is what loadRaw would parse back; caching it
    // directly avoids an immediate re-read. mtime/size from the fresh stat.
    try {
      const stat = statSync(this.file);
      this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, data };
    } catch {
      this.cache = null;
    }
  }

  /** The actual disk write, separated so tests can inject write failures. */
  protected persistFile(content: string): void {
    writeFileAtomic(this.file, content);
  }
}
