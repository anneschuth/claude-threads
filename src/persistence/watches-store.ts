/**
 * WatchesStore — persistence for event triggers (Claude Tag-style
 * proactiveness: "when someone reports a production incident, triage it").
 *
 * Watches are scoped per platform instance (platformId ≈ one channel — the
 * same hard privacy boundary the memory and routines stores use): a watch
 * created on one platform never fires on, or is visible from, another.
 *
 * Storage: YAML at ~/.config/claude-threads/watches.yaml, 0600 atomic
 * writes, versioned. Override path with CLAUDE_THREADS_WATCHES_PATH.
 * CRUD/mutex/atomic-write machinery is shared via PlatformListStore.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from '../utils/logger.js';
import { PlatformListStore, STORES_CONFIG_DIR } from './platform-list-store.js';

const log = createLogger('watches');

const DEFAULT_FILE = join(STORES_CONFIG_DIR, 'watches.yaml');

/** Watches are disabled after this many consecutive failed fires. */
export const MAX_CONSECUTIVE_WATCH_FAILURES = 3;

/** Hard cap default; overridable via limits.maxWatches. */
export const DEFAULT_MAX_WATCHES = 10;

/** Prefilter keyword bounds (enforced on LLM-parsed input). */
export const MIN_KEYWORDS = 1;
export const MAX_KEYWORDS = 12;
const MAX_KEYWORD_LENGTH = 60;

export type WatchFireStatus = 'ok' | 'failed' | 'skipped';

export interface Watch {
  id: string;
  /** Short human name, shown in lists and fire announcements. */
  name: string;
  /** Natural-language condition the haiku confirm step evaluates messages against. */
  condition: string;
  /** The task the fired session is asked to do. */
  prompt: string;
  /**
   * Lowercase prefilter terms derived at creation. A message is a candidate
   * when ANY keyword occurs as a substring; candidates still require a
   * semantic confirmation before firing — keywords only bound the cost.
   */
  keywords: string[];
  /**
   * Username the watch fires as. The runner re-gates this against the
   * platform allowlist at every fire — a creator who loses authorization
   * disables the watch (mirrors routines).
   */
  createdBy: string;
  createdAt: string;
  enabled: boolean;
  lastFiredAt?: string;
  lastFireStatus?: WatchFireStatus;
  /** Rolling daily fire counter (local server date), for the daily cap. */
  firesToday?: { date: string; count: number };
  consecutiveFailures: number;
}

/** Input for creating a watch; id/bookkeeping fields are filled in by the store. */
export type NewWatch = Omit<Watch, 'id' | 'createdAt' | 'enabled' | 'consecutiveFailures'>;

/**
 * Normalize and validate LLM-derived prefilter keywords. Returns the cleaned
 * list, or an error string. Defensive: keywords come from a haiku parse.
 */
export function validateKeywords(raw: unknown): string[] | string {
  if (!Array.isArray(raw)) return 'keywords must be a list';
  const cleaned = [...new Set(
    raw
      .filter((k): k is string => typeof k === 'string')
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k.length > 0 && k.length <= MAX_KEYWORD_LENGTH),
  )];
  if (cleaned.length < MIN_KEYWORDS) return 'at least one usable keyword is required';
  return cleaned.slice(0, MAX_KEYWORDS);
}

export class WatchesStore extends PlatformListStore<Watch> {
  constructor(filePath?: string) {
    super('watches', DEFAULT_FILE, filePath ?? process.env.CLAUDE_THREADS_WATCHES_PATH);
  }

  protected applyItemDefaults(w: Watch): void {
    w.enabled = w.enabled ?? true;
    w.consecutiveFailures = w.consecutiveFailures ?? 0;
    w.keywords = Array.isArray(w.keywords) ? w.keywords : [];
  }

  protected warn(message: string): void {
    log.warn(message);
  }

  protected override onRemoved(platformId: string, watch: Watch): void {
    log.info(`Watch "${watch.name}" removed from ${platformId}`);
  }

  /**
   * Add a watch. Rejects (returns an error string) on invalid fields or when
   * the platform is at `maxWatches` — validation lives here so no caller can
   * bypass it.
   */
  add(platformId: string, watch: NewWatch, maxWatches = DEFAULT_MAX_WATCHES): Promise<{ ok: true; watch: Watch } | { ok: false; error: string }> {
    return this.runExclusive(() => {
      const name = watch.name.trim().slice(0, 80);
      const condition = watch.condition.trim().slice(0, 500);
      const prompt = watch.prompt.trim().slice(0, 2000);
      if (!name || !condition || !prompt) return { ok: false as const, error: 'name, condition and prompt are required' };
      const keywords = validateKeywords(watch.keywords);
      if (typeof keywords === 'string') return { ok: false as const, error: keywords };

      const data = this.loadRaw();
      const existing = data.items[platformId] ?? [];
      if (existing.length >= maxWatches) {
        return { ok: false as const, error: `watch limit reached (${maxWatches}); delete one first` };
      }
      const full: Watch = {
        ...watch,
        name,
        condition,
        prompt,
        keywords,
        id: randomUUID().slice(0, 8),
        createdAt: new Date().toISOString(),
        enabled: true,
        consecutiveFailures: 0,
      };
      data.items[platformId] = [...existing, full];
      this.writeAtomic(data);
      log.info(`Watch "${full.name}" created on ${platformId} by @${full.createdBy}`);
      // Copy: `full` is now part of the cached graph (see PlatformListStore's
      // no-live-reference invariant on list/update).
      return { ok: true as const, watch: structuredClone(full) };
    });
  }

  /** Merge a partial update into one watch. Returns the updated watch or undefined. */
  override update(platformId: string, id: string, patch: Partial<Pick<Watch, 'enabled' | 'lastFiredAt' | 'lastFireStatus' | 'firesToday' | 'consecutiveFailures'>>): Promise<Watch | undefined> {
    return super.update(platformId, id, patch);
  }
}
