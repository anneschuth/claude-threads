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

import { existsSync, mkdirSync, readFileSync } from 'fs';
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

  list(platformId: string): T[] {
    return this.loadRaw().items[platformId] ?? [];
  }

  get(platformId: string, id: string): T | undefined {
    return this.list(platformId).find((item) => item.id === id);
  }

  /** Merge a partial update into one item. Returns the updated item or undefined. */
  update(platformId: string, id: string, patch: Partial<T>): Promise<T | undefined> {
    return this.runExclusive(() => {
      const data = this.loadRaw();
      const items = data.items[platformId] ?? [];
      const idx = items.findIndex((item) => item.id === id);
      if (idx < 0) return undefined;
      items[idx] = { ...items[idx], ...patch };
      this.writeAtomic(data);
      return items[idx];
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
      return { version: STORE_VERSION, items: {} };
    }
    try {
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
      return { version: (parsed.version as number | undefined) ?? STORE_VERSION, items };
    } catch (err) {
      this.warn(`Failed to read ${this.file}: ${(err as Error).message} — starting empty`);
      return { version: STORE_VERSION, items: {} };
    }
  }

  protected writeAtomic(data: FileShape<T>): void {
    writeFileAtomic(
      this.file,
      yaml.dump({ version: data.version, [this.collectionKey]: data.items }, { sortKeys: true, lineWidth: -1 }),
    );
  }
}
