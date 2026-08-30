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
import { singleLine } from '../utils/format.js';
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
  /**
   * Whether a fired session must ask for per-action approval in-thread
   * (interactive permissions) even when the platform is configured
   * `skipPermissions: true`. Chosen explicitly by the human at creation time.
   * SECURITY: a watch fires on attacker-influenceable channel content, so the
   * safe default is `true` — an autonomous (`false`) watch runs tool actions
   * with no human in the loop and should be reserved for fully-trusted
   * triggers. Optional for backward-compat with watches persisted before this
   * field existed; `applyItemDefaults` fills the safe default on read.
   */
  requireApproval?: boolean;
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
      // singleLine, not trim: keywords are model-derived and rendered
      // verbatim on the human-approval card — an inner newline could smuggle
      // multi-line markdown past the card's single-line framing.
      .map((k) => singleLine(k).toLowerCase())
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
    // Fail safe: a watch with no recorded posture (older data, or a hand-edited
    // file) requires approval rather than running autonomously.
    w.requireApproval = w.requireApproval ?? true;
    // Normalize like validateKeywords: the file is documented as
    // hand-editable, and the prefilter lowercases only the message — a
    // hand-added 'Deploy' would otherwise be silently dead.
    w.keywords = Array.isArray(w.keywords)
      ? w.keywords
        .filter((k): k is string => typeof k === 'string')
        .map((k) => singleLine(k).toLowerCase())
        .filter((k) => k.length > 0)
      : [];
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
  async add(platformId: string, watch: NewWatch, maxWatches = DEFAULT_MAX_WATCHES): Promise<{ ok: true; watch: Watch } | { ok: false; error: string }> {
    const result = await this.addItem(platformId, maxWatches, 'watch', () => {
      // name/condition render in lists, cards and fire announcements —
      // collapse to one line at the authoritative gate. The prompt is task
      // text for the fired session; multi-line stays legal there.
      const name = singleLine(watch.name).slice(0, 80);
      const condition = singleLine(watch.condition).slice(0, 500);
      const prompt = watch.prompt.trim().slice(0, 2000);
      if (!name || !condition || !prompt) return 'name, condition and prompt are required';
      const keywords = validateKeywords(watch.keywords);
      if (typeof keywords === 'string') return keywords;
      return {
        ...watch,
        name,
        condition,
        prompt,
        keywords,
        // Default to the safe posture unless the creator explicitly opted out.
        requireApproval: watch.requireApproval ?? true,
        id: randomUUID().slice(0, 8),
        createdAt: new Date().toISOString(),
        enabled: true,
        consecutiveFailures: 0,
      };
    });
    if (!result.ok) return result;
    log.info(`Watch "${result.item.name}" created on ${platformId} by @${result.item.createdBy}`);
    return { ok: true, watch: result.item };
  }

  /** Merge a partial update into one watch. Returns the updated watch or undefined. */
  override update(platformId: string, id: string, patch: Partial<Pick<Watch, 'enabled' | 'requireApproval' | 'lastFiredAt' | 'lastFireStatus' | 'firesToday' | 'consecutiveFailures'>>): Promise<Watch | undefined> {
    return super.update(platformId, id, patch);
  }
}
