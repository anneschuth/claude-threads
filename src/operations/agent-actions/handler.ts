/**
 * Bot-side executor for agent-initiated feature actions — the MCP tools
 * (remember_fact, list_memory, propose_routine, propose_watch, list_*)
 * Claude can call from inside a session. The MCP child forwards each call
 * over the session's decision bridge; it executes HERE because the stores,
 * their per-platform mutexes, and their caps all live in the bot process.
 *
 * Gating philosophy (see docs/CONFIGURATION.md § Agent tools):
 * - Every check in this file is AUTHORITATIVE. The env-var gates that decide
 *   which tools the MCP child registers (src/mcp/agent-features-env.ts) are
 *   advisory only — they exist so disabled features' tools never appear in
 *   the model's tool list, not to enforce anything.
 * - `remember_fact` writes without a human prompt (precedent: the distiller
 *   already writes ungated channel memory at session end), but every write
 *   is visible (thread post + audit log), capped per session, labeled with
 *   an `agent` source, and can never displace a user's entry.
 * - `propose_routine` / `propose_watch` NEVER save anything: they post the
 *   same confirmation card the `!routine` / `!watch` commands use, and only
 *   a human 👍 (authorization-gated in the reaction router) persists it.
 *   Both are refused outright in unattended sessions (routine/watch fires)
 *   — an unattended session proposing new unattended work would be a
 *   self-replication loop.
 * - Destructive operations (forget, pause, delete, manual run) are not
 *   exposed to the agent at all.
 */

import type { Session } from '../../session/types.js';
import type { SessionContext } from '../session-context/index.js';
import type { AgentActionRequest, AgentActionResponse } from '../../mcp/decision-bridge.js';
import { post } from '../post-helpers/index.js';
import { postRoutineConfirmation, postWatchConfirmation } from '../commands/automation.js';
import { sanitizeEntryText, entryTextExceedsCap, entrySourceLabel, MAX_ENTRY_LENGTH } from '../../memory/store.js';
import {
  validateSchedule,
  describeSchedule,
  type RoutineSchedule,
  SCHEDULE_PRESETS,
} from '../../persistence/routines-store.js';
import { validateKeywords } from '../../persistence/watches-store.js';
import { hostTimezone } from '../../routines/parser.js';
import { isDcmThreadId } from '../../platform/utils.js';
import { auditLog } from '../../persistence/audit-log.js';
import { createLogger } from '../../utils/logger.js';
import { createSessionLog } from '../../utils/session-log.js';

const log = createLogger('agent-actions');
const sessionLog = createSessionLog(log);

/** Max remember_fact writes per session (process lifetime). Bounds a burst
 *  (e.g. a prompt-injected "remember everything" loop) well below the
 *  store's eviction threshold; the distiller stays the bulk path. */
export const AGENT_MEMORY_WRITES_PER_SESSION = 5;

/** Cap list_* outputs: bridge responses are one JSON line; keep them small. */
const LIST_LIMIT = 100;

export async function handleAgentAction(
  session: Session,
  ctx: SessionContext,
  request: AgentActionRequest,
  signal: AbortSignal,
): Promise<AgentActionResponse> {
  try {
    switch (request.action) {
      case 'remember_fact':
        return await rememberFact(session, ctx, request.input, signal);
      case 'list_memory':
        return listMemory(session, ctx);
      case 'propose_routine':
        return await proposeRoutine(session, ctx, request.input, signal);
      case 'propose_watch':
        return await proposeWatch(session, ctx, request.input, signal);
      case 'list_routines':
        return listRoutines(session, ctx);
      case 'list_watches':
        return listWatches(session, ctx);
      default:
        return { ok: false, reason: `unknown agent action '${String((request as { action?: unknown }).action)}'` };
    }
  } catch (err) {
    // Never throw across the bridge: a handler error must degrade into a
    // tool-visible failure, not a deny-shaped bridge fallback.
    const reason = err instanceof Error ? err.message : String(err);
    sessionLog(session).warn(`Agent action ${request.action} failed: ${reason}`);
    return { ok: false, reason };
  }
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

function memoryChannelEnabled(session: Session, ctx: SessionContext): boolean {
  const memory = ctx.ops.getPlatformMemoryConfig(session.platformId);
  return memory.enabled && memory.channelLayer;
}

async function rememberFact(
  session: Session,
  ctx: SessionContext,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<AgentActionResponse> {
  if (!memoryChannelEnabled(session, ctx)) {
    return { ok: false, reason: 'channel memory is disabled for this platform' };
  }
  // Unattended runs (routine/watch fires) act on untrusted triggering
  // content with no human necessarily reading the thread — a
  // prompt-injected fire must not be able to seed every FUTURE session's
  // context. The distiller remains the (haiku-mediated, exclusion-framed)
  // memory path for unattended sessions.
  if (session.unattended) {
    return { ok: false, reason: 'unattended sessions may not write channel memory directly' };
  }
  const raw = typeof input.text === 'string' ? input.text : '';
  const text = sanitizeEntryText(raw);
  if (!text) {
    return { ok: false, reason: 'text must be a non-empty string' };
  }
  // Refuse over-cap text instead of silently truncating mid-sentence: the
  // model can shorten and retry; a corrupted half-fact in shared memory
  // cannot be noticed by anyone (parity: !remember warns on truncation).
  if (entryTextExceedsCap(raw)) {
    return { ok: false, reason: `text is too long (max ${MAX_ENTRY_LENGTH} chars after normalization) — shorten it to one crisp fact` };
  }
  const writes = session.agentMemoryWrites ?? 0;
  if (writes >= AGENT_MEMORY_WRITES_PER_SESSION) {
    return {
      ok: false,
      reason: `session cap reached (${AGENT_MEMORY_WRITES_PER_SESSION} memories per session) — ask the user to \`!remember\` anything further`,
    };
  }
  // The bridge client already gave up — don't write a fact the model was
  // told failed (it would misreport, then 'duplicate' on retry).
  if (signal.aborted) return { ok: false, reason: 'cancelled' };

  // Reserve the cap slot SYNCHRONOUSLY (before the awaited store write):
  // parallel tool calls interleave only at awaits, so check-then-increment
  // with the increment after the await would let a burst of concurrent
  // calls each pass the check at 0 — the exact burst the cap bounds.
  // Duplicates and store failures refund the slot below.
  session.agentMemoryWrites = writes + 1;

  let result;
  try {
    result = await ctx.state.memoryStore.addChannelEntries(session.platformId, [
      { text, source: 'agent' },
    ]);
  } catch (err) {
    session.agentMemoryWrites = (session.agentMemoryWrites ?? 1) - 1;
    throw err;
  }
  if (result.added.length === 0) {
    // Refund: a duplicate is free.
    session.agentMemoryWrites = (session.agentMemoryWrites ?? 1) - 1;
  }
  const writesAfter = session.agentMemoryWrites;

  auditLog(session.platformId, {
    threadId: session.threadId,
    sessionId: session.sessionId,
    actor: session.startedBy,
    kind: 'command',
    tool: 'agent_remember_fact',
    detail: result.added.length > 0 ? `saved: ${text}` : `duplicate: ${text}`,
  });

  if (result.added.length === 0) {
    return { ok: true, result: { status: 'duplicate', note: 'an equivalent memory already exists' } };
  }

  // Visibility is the gate-replacement: the team must see what Claude
  // saved, in the thread where it happened, with the undo path named. A
  // failed announcement must not misreport the (already persisted) write
  // as failed — contain it and tell the model to announce it itself.
  let announced = true;
  try {
    const formatter = session.platform.getFormatter();
    await post(
      session,
      'info',
      `🧠 ${formatter.formatBold('Claude saved a channel memory:')} ${text}\n` +
      `${formatter.formatItalic(`View with ${'`!memory`'}, remove with ${'`!memory forget <n>`'}.`)}`,
    );
  } catch (err) {
    announced = false;
    sessionLog(session).warn(`🧠 Agent memory saved but the announcement post failed: ${err}`);
  }
  sessionLog(session).info(`🧠 Agent memory saved (${writesAfter}/${AGENT_MEMORY_WRITES_PER_SESSION}): "${text}"`);
  return {
    ok: true,
    result: {
      status: 'saved',
      supersededCount: result.superseded.length,
      remainingSessionWrites: AGENT_MEMORY_WRITES_PER_SESSION - writesAfter,
      ...(announced ? {} : { note: 'the announcement post failed — tell the user in your reply that you saved this memory' }),
    },
  };
}

function listMemory(session: Session, ctx: SessionContext): AgentActionResponse {
  if (!memoryChannelEnabled(session, ctx)) {
    return { ok: false, reason: 'channel memory is disabled for this platform' };
  }
  const entries = ctx.state.memoryStore.listChannelEntries(session.platformId);
  return {
    ok: true,
    result: {
      total: entries.length,
      // Newest entries matter most (the file appends at the end), and the
      // 1-based indices must stay aligned with `!memory forget <n>` — so
      // index BEFORE slicing from the tail.
      entries: entries
        .map((e, i) => ({
          index: i + 1,
          addedAt: e.addedAt,
          source: entrySourceLabel(e),
          text: e.text,
        }))
        .slice(-LIST_LIMIT),
      ...(entries.length > LIST_LIMIT ? { note: `showing the newest ${LIST_LIMIT} of ${entries.length} entries` } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Routine / watch proposals — human 👍 required, always
// ---------------------------------------------------------------------------

/**
 * Shared refusals for the propose_* actions. Order matters only for the
 * wording; all of them end the call.
 */
function refuseProposal(
  session: Session,
  ctx: SessionContext,
  flavor: 'routines' | 'watches',
): string | null {
  const enabled = flavor === 'routines'
    ? ctx.ops.isRoutinesEnabled(session.platformId)
    : ctx.ops.isWatchesEnabled(session.platformId);
  if (!enabled) return `${flavor} are disabled for this platform`;
  if (isDcmThreadId(session.threadId)) {
    return `${flavor} cannot be created in direct channel mode`;
  }
  // The self-replication gate: unattended sessions (routine/watch fires)
  // must not propose new unattended work.
  if (session.unattended) {
    return `this session is an unattended run — it may not propose new ${flavor}`;
  }
  return null;
}

const PROPOSED = 'proposed_awaiting_human_approval';

async function proposeRoutine(
  session: Session,
  ctx: SessionContext,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<AgentActionResponse> {
  const refusal = refuseProposal(session, ctx, 'routines');
  if (refusal) return { ok: false, reason: refusal };

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!name || !prompt) return { ok: false, reason: 'name and prompt must be non-empty strings' };
  // Refuse over-length fields instead of silently truncating (same policy
  // as remember_fact): the store's own slice-on-save would corrupt the
  // task mid-sentence with nobody the wiser.
  if (name.length > 80) return { ok: false, reason: 'name is too long (max 80 chars) — shorten it' };
  if (prompt.length > 2000) return { ok: false, reason: 'prompt is too long (max 2000 chars) — shorten it' };

  const rawSchedule = (input.schedule ?? {}) as Record<string, unknown>;
  const schedule: RoutineSchedule = {
    preset: rawSchedule.preset as RoutineSchedule['preset'],
    time: typeof rawSchedule.time === 'string' ? rawSchedule.time : undefined,
    weekday: typeof rawSchedule.weekday === 'number' ? rawSchedule.weekday : undefined,
    timezone: typeof rawSchedule.timezone === 'string' && rawSchedule.timezone
      ? rawSchedule.timezone
      : hostTimezone(),
  };
  const scheduleError = validateSchedule(schedule);
  if (scheduleError) {
    return { ok: false, reason: `invalid schedule: ${scheduleError} (presets: ${SCHEDULE_PRESETS.join('/')})` };
  }

  // The bridge client gave up (timeout / dead MCP child): don't post an
  // orphan card nobody's tool call is waiting on.
  if (signal.aborted) return { ok: false, reason: 'cancelled' };

  await postRoutineConfirmation(
    session,
    ctx,
    { name, prompt, schedule },
    // The routine runs as the session owner; per-fire re-authorization
    // (runUnattendedSession) depends on createdBy being a real user.
    session.startedBy,
    { proposedByAgent: true },
  );
  auditLog(session.platformId, {
    threadId: session.threadId,
    sessionId: session.sessionId,
    actor: session.startedBy,
    kind: 'command',
    tool: 'agent_propose_routine',
    detail: `${name} (${describeSchedule(schedule)})`,
  });
  return {
    ok: true,
    result: {
      status: PROPOSED,
      name,
      note: 'Nothing is saved yet: a human must react 👍 on the confirmation card. Say you have PROPOSED the routine — do not claim it was created.',
    },
  };
}

async function proposeWatch(
  session: Session,
  ctx: SessionContext,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<AgentActionResponse> {
  const refusal = refuseProposal(session, ctx, 'watches');
  if (refusal) return { ok: false, reason: refusal };

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const condition = typeof input.condition === 'string' ? input.condition.trim() : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!name || !condition || !prompt) {
    return { ok: false, reason: 'name, condition and prompt must be non-empty strings' };
  }
  if (name.length > 80) return { ok: false, reason: 'name is too long (max 80 chars) — shorten it' };
  if (condition.length > 500) return { ok: false, reason: 'condition is too long (max 500 chars) — shorten it' };
  if (prompt.length > 2000) return { ok: false, reason: 'prompt is too long (max 2000 chars) — shorten it' };
  const keywords = validateKeywords(input.keywords);
  if (typeof keywords === 'string') {
    return { ok: false, reason: `invalid keywords: ${keywords}` };
  }

  if (signal.aborted) return { ok: false, reason: 'cancelled' };

  await postWatchConfirmation(
    session,
    ctx,
    { name, condition, prompt, keywords },
    session.startedBy,
    { proposedByAgent: true },
  );
  auditLog(session.platformId, {
    threadId: session.threadId,
    sessionId: session.sessionId,
    actor: session.startedBy,
    kind: 'command',
    tool: 'agent_propose_watch',
    detail: `${name} (when: ${condition})`,
  });
  return {
    ok: true,
    result: {
      status: PROPOSED,
      name,
      note: 'Nothing is saved yet: a human must react 👍 on the confirmation card. Say you have PROPOSED the watch — do not claim it was created.',
    },
  };
}

// ---------------------------------------------------------------------------
// Read-only listings
// ---------------------------------------------------------------------------

function listRoutines(session: Session, ctx: SessionContext): AgentActionResponse {
  if (!ctx.ops.isRoutinesEnabled(session.platformId)) {
    return { ok: false, reason: 'routines are disabled for this platform' };
  }
  const routines = ctx.state.routinesStore.list(session.platformId);
  return {
    ok: true,
    result: {
      total: routines.length,
      routines: routines.slice(0, LIST_LIMIT).map((r, i) => ({
        index: i + 1,
        name: r.name,
        schedule: describeSchedule(r.schedule),
        enabled: r.enabled,
        createdBy: r.createdBy,
        lastRunAt: r.lastRunAt,
      })),
    },
  };
}

function listWatches(session: Session, ctx: SessionContext): AgentActionResponse {
  if (!ctx.ops.isWatchesEnabled(session.platformId)) {
    return { ok: false, reason: 'watches are disabled for this platform' };
  }
  const watches = ctx.state.watchesStore.list(session.platformId);
  return {
    ok: true,
    result: {
      total: watches.length,
      watches: watches.slice(0, LIST_LIMIT).map((w, i) => ({
        index: i + 1,
        name: w.name,
        condition: w.condition,
        keywords: w.keywords,
        enabled: w.enabled,
        createdBy: w.createdBy,
        lastFiredAt: w.lastFiredAt,
      })),
    },
  };
}
