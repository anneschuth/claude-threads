/**
 * End-of-session distillation: when a session ends, a one-shot haiku pass
 * (via the existing `quickQuery` util) distills the thread into durable
 * channel-memory entries — decisions, conventions, stable facts — so the
 * channel learns over time even when nobody typed `!remember`.
 *
 * Fire-and-forget by design: distillation must never delay or fail session
 * teardown, never post to the thread, and fail silently (debug-logged) on
 * any error. Concurrent session ends serialize in the store's per-platform
 * mutex; the dedupe pass absorbs overlapping extractions.
 */

import type { Session } from '../session/types.js';
import type { SessionContext } from '../operations/session-context/index.js';
import { quickQuery } from '../claude/quick-query.js';
import { isDcmThreadId } from '../platform/utils.js';
import { createLogger } from '../utils/logger.js';
import type { ChannelMemoryEntry, MemoryStore } from './store.js';

const log = createLogger('memory');

/** Threads shorter than this carry nothing durable — skip the LLM call. */
export const MIN_THREAD_MESSAGES = 4;

/** How many recent thread messages feed the distillation prompt. */
export const DISTILL_MESSAGE_LIMIT = 30;

/** Per-message truncation, matching `generateWorkSummary`. */
const MESSAGE_CHAR_CAP = 500;

/** Max facts extracted per session end. */
export const MAX_FACTS_PER_SESSION = 3;

/**
 * How many of the newest existing entries ride along in the prompt for
 * at-the-source dedupe. The channel file can hold up to 400 entries × 500
 * chars — embedding all of it in every distillation call would dwarf the
 * conversation itself; the store's merge-time dedupe still catches repeats
 * of anything older than this window.
 */
export const DISTILL_EXISTING_LIMIT = 50;

const DISTILL_TIMEOUT_MS = 15000;

export type DistillationReason = 'stop' | 'exit' | 'timeout';

/**
 * Build the haiku prompt. Existing memory rides along so duplicates are cut
 * at the source, not just at merge time.
 */
export function buildDistillationPrompt(
  existingEntries: ChannelMemoryEntry[],
  messages: Array<{ username: string; message: string }>,
): string {
  const existing = existingEntries.length > 0
    ? existingEntries.map((e) => `- ${e.text}`).join('\n')
    : '(none)';
  const conversation = messages
    .map((m) => `${m.username}: ${m.message.substring(0, MESSAGE_CHAR_CAP)}`)
    .join('\n');

  return `You maintain a shared memory file for a team chat channel. From the conversation below, extract at most ${MAX_FACTS_PER_SESSION} durable facts worth remembering for FUTURE, unrelated conversations in this channel: team decisions, conventions, preferences, stable project facts.

Exclude: task-specific details, transient state, secrets/tokens/credentials, personal data, anything only relevant to this one thread.

Existing memory (do not repeat any of these):
${existing}

Conversation:
${conversation}

Output exactly one line per fact, each starting with "- ", max 200 characters per line. If nothing qualifies, output exactly: NONE`;
}

/**
 * Parse the model output defensively: only `- ` bullet lines of sane length
 * count; anything else (chatter, NONE, overlong lines) is ignored.
 */
export function parseDistillationOutput(output: string): string[] {
  if (!output || /^\s*NONE\s*$/i.test(output.trim())) return [];
  const facts: string[] = [];
  for (const line of output.split('\n')) {
    const m = line.trim().match(/^- (.{3,200})$/);
    if (m) facts.push(m[1].trim());
    if (facts.length >= MAX_FACTS_PER_SESSION) break;
  }
  return facts;
}

/**
 * Schedule distillation for an ending session. Fire-and-forget: returns
 * immediately; all failures are swallowed at debug level. Snapshots what it
 * needs from the session up front since the session object is being torn down.
 */
export function scheduleDistillation(
  session: Session,
  ctx: SessionContext,
  reason: DistillationReason,
): void {
  const memoryConfig = ctx.ops.getPlatformMemoryConfig(session.platformId);
  if (!memoryConfig.enabled || !memoryConfig.channelLayer || !memoryConfig.distillation) {
    return;
  }
  // Direct channel mode: the synthetic session id is not a thread root, so
  // there is no thread history to distill — getThreadHistory would fail and
  // the fire-and-forget catch would swallow it silently. Skip loudly instead.
  // (Distilling from channel history needs a platform API that does not exist
  // yet; see the PR discussion.)
  if (isDcmThreadId(session.threadId)) {
    log.debug(`Skipping distillation for DCM session ${session.platformId}:${session.threadId}`);
    return;
  }
  // Snapshot before teardown — the promise below outlives the session.
  const { platformId, threadId, platform } = session;
  const store = ctx.state.memoryStore;

  void distillThread(store, platformId, threadId, platform)
    .then((added) => {
      if (added > 0) {
        log.debug(`Distilled ${added} memory entries from ${platformId}:${threadId} (${reason})`);
      }
    })
    .catch((err) => {
      log.debug(`Distillation failed for ${platformId}:${threadId}: ${(err as Error).message}`);
    });
}

/**
 * The actual distillation pass. Exported for tests; production entry point is
 * `scheduleDistillation`.
 */
export async function distillThread(
  store: MemoryStore,
  platformId: string,
  threadId: string,
  platform: Pick<Session['platform'], 'getThreadHistory'>,
): Promise<number> {
  const messages = await platform.getThreadHistory(threadId, {
    limit: DISTILL_MESSAGE_LIMIT,
    excludeBotMessages: false,
  });
  if (messages.length < MIN_THREAD_MESSAGES) return 0;

  const existing = store.listChannelEntries(platformId).slice(-DISTILL_EXISTING_LIMIT);
  const prompt = buildDistillationPrompt(existing, messages);

  // No workingDir: distillation needs no repo context, and a CWD-independent
  // call can't trip over a deleted worktree.
  const result = await quickQuery({
    prompt,
    model: 'haiku',
    timeout: DISTILL_TIMEOUT_MS,
  });
  if (!result.success || !result.response) return 0;

  const facts = parseDistillationOutput(result.response);
  if (facts.length === 0) return 0;

  const { added } = await store.addChannelEntries(
    platformId,
    facts.map((text) => ({ text, source: 'distilled' as const })),
  );
  return added.length;
}
