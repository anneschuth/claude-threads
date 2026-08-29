/**
 * Automation commands — routines (!routine, !routines) and watches
 * (!watch, !watches): natural-language creation with a human 👍 gate, and
 * the shared list/pause/resume/delete management surface. Split from
 * handler.ts; shares the owner gate and audit hook via guards.ts.
 */

import type { Session } from '../../session/types.js';
import type { SessionContext } from '../session-context/index.js';
import { post, postInteractiveAndRegister } from '../post-helpers/index.js';
import { APPROVAL_EMOJIS, ALLOW_ALL_EMOJIS, DENIAL_EMOJIS } from '../../utils/emoji.js';
import { describeSchedule } from '../../persistence/routines-store.js';
import { parseRoutineRequest, hostTimezone, type ParsedRoutineRequest } from '../../routines/parser.js';
import { parseWatchRequest, type ParsedWatchRequest } from '../../watches/parser.js';
import { formatIsoMinute } from '../../utils/format.js';
import { auditCommand, requireSessionOwner } from './guards.js';
import { createLogger } from '../../utils/logger.js';
import { createSessionLog } from '../../utils/session-log.js';

const log = createLogger('commands');
const sessionLog = createSessionLog(log);

// ---------------------------------------------------------------------------
// Routine commands (!routine, !routines)
// ---------------------------------------------------------------------------

/**
 * Post `message` and return true when the platform runs in direct channel
 * mode. Routine/watch creation is refused there: a fired session would be
 * keyed on a thread that no typed message can reach (everything routes to
 * the synthetic channel-session key).
 */
async function refuseInDirectChannelMode(session: Session, message: string): Promise<boolean> {
  if (!session.platform.directChannelMode?.enabled) return false;
  await post(session, 'info', message);
  return true;
}

async function requireRoutinesEnabled(session: Session, ctx: SessionContext): Promise<boolean> {
  if (ctx.ops.isRoutinesEnabled(session.platformId)) return true;
  await post(
    session,
    'info',
    `🕘 Routines are disabled for this platform (see the \`routines\` option in config.yaml).`,
  );
  return false;
}

/**
 * `!routine <natural language>` — parse the request with haiku, show the
 * structured result, and wait for a 👍/👎 confirmation before saving.
 * Owner-gated like other channel-shaping settings: routines run unattended
 * as their creator and cost a session per run.
 */
export async function createRoutine(
  session: Session,
  request: string,
  username: string,
  ctx: SessionContext,
  // Injectable for tests: other test files module-mock quick-query.js, so
  // stubbing via CLAUDE_PATH is unreliable in full-suite runs.
  parse: typeof parseRoutineRequest = parseRoutineRequest,
): Promise<void> {
  if (!await requireRoutinesEnabled(session, ctx)) return;
  // Creation only: routines that predate this guard stay listable/pausable/
  // deletable via !routines, and their write-only fires keep working.
  if (await refuseInDirectChannelMode(
    session,
    `🕘 Routines are not available in direct channel mode — a fired routine's session could not be reached from this channel.`,
  )) return;
  if (!await requireSessionOwner(session, username, 'create routines')) return;
  const formatter = session.platform.getFormatter();

  const trimmed = request.trim();
  if (!trimmed) {
    await post(session, 'warning', `Usage: ${formatter.formatCode('!routine every weekday at 9:00, <task>')}`);
    return;
  }

  await post(session, 'info', `🕘 Parsing the schedule...`);
  const result = await parse(trimmed, hostTimezone());
  if (!result.ok) {
    await post(session, 'warning', `🕘 Could not create a routine: ${result.error}`);
    sessionLog(session).warn(`🕘 Routine parse failed for @${username}: ${result.error}`);
    return;
  }

  const { parsed, timezoneDefaulted } = result;
  const tzNote = timezoneDefaulted
    ? `\n${formatter.formatItalic(`Timezone defaulted to the bot host's ${parsed.schedule.timezone} — name one explicitly ("9am Pacific") to override.`)}`
    : '';
  await postRoutineConfirmation(session, ctx, parsed, username, { extraNote: tzNote });
}

/**
 * Post the routine confirmation card and park the pending prompt. Shared by
 * the `!routine` command (haiku-parsed input) and the agent's
 * `propose_routine` MCP tool (structured input) — one card, one approval
 * flow, one save path: NOTHING saves without a human 👍 on this card.
 */
export async function postRoutineConfirmation(
  session: Session,
  ctx: SessionContext,
  parsed: ParsedRoutineRequest,
  requestedBy: string,
  opts: { extraNote?: string; proposedByAgent?: boolean } = {},
): Promise<void> {
  const formatter = session.platform.getFormatter();
  const heading = opts.proposedByAgent
    ? `🕘 ${formatter.formatBold(`Claude proposes routine "${parsed.name}"`)} — approve?`
    : `🕘 ${formatter.formatBold(`Create routine "${parsed.name}"?`)}`;
  // Human creations may choose an autonomous posture; agent proposals never
  // do (an autonomous unattended item must be a deliberate human choice).
  const offerAutonomous = !opts.proposedByAgent;
  const reactions = offerAutonomous
    ? [APPROVAL_EMOJIS[0], ALLOW_ALL_EMOJIS[0], DENIAL_EMOJIS[0]]
    : [APPROVAL_EMOJIS[0], DENIAL_EMOJIS[0]];
  const choiceLine = offerAutonomous
    ? '👍 save (Claude asks approval before each action) · ✅ save + run autonomously (no approval prompts) · 👎 discard'
    : 'React 👍 to save or 👎 to discard.';
  const confirmPost = await postInteractiveAndRegister(
    session,
    `${heading}\n` +
    `${formatter.formatBold('Schedule:')} ${describeSchedule(parsed.schedule)}\n` +
    `${formatter.formatBold('Task:')} ${parsed.prompt}${opts.extraNote ?? ''}\n\n` +
    `${formatter.formatItalic(`Each run starts a full Claude session in a new thread. ${choiceLine}`)}`,
    reactions,
    (postId, threadId) => ctx.ops.registerPost(postId, threadId),
  );

  session.messageManager?.setPendingRoutinePrompt({
    postId: confirmPost.id,
    parsed,
    requestedBy,
    proposedByAgent: opts.proposedByAgent,
  });
  sessionLog(session).info(`🕘 Routine proposal posted for @${requestedBy}${opts.proposedByAgent ? ' (agent-proposed)' : ''}: "${parsed.name}"`);
}

/**
 * Shared implementation of the `!routines` / `!watches` management commands:
 * numbered list, pause/resume/delete (owner-gated), plus flavor-specific
 * extra actions (routines' `run`, which is platform-allowlist-gated
 * instead). One policy for parsing, index lookup, gating, logging and audit;
 * the flavors carry only wording and store wiring.
 */
async function manageListItems<T extends { id: string; name: string; createdBy: string; enabled: boolean }>(
  session: Session,
  args: string | undefined,
  username: string,
  flavor: {
    emoji: string;
    /** Capitalized item noun ('Routine'). */
    noun: string;
    /** Command + audit name ('routines'). */
    command: string;
    /** Action alternation for the usage/footer lines ('pause|resume|delete|run'). */
    actions: string;
    /** Creation hint shown for an empty list. */
    createHint: string;
    /** List headline after the bold count ('each run starts ... new thread:'). */
    headlineSuffix: string;
    /** Per-item line body after the "N. " numbering. */
    describe(item: T, formatter: ReturnType<Session['platform']['getFormatter']>): string;
    list(): T[];
    update(id: string, patch: { enabled?: boolean; consecutiveFailures?: number }): Promise<unknown>;
    remove(id: string): Promise<unknown>;
    /**
     * Actions exempt from the owner gate but requiring the platform
     * allowlist: each such action starts unattended work under the item
     * creator's identity, so a temporarily !invite'd guest's session-level
     * allowance must not buy it.
     */
    platformAllowedActions?: Set<string>;
    /** Handle a flavor-specific action; only called for non-CRUD actions. */
    extraAction?(action: string, item: T): Promise<void>;
  },
): Promise<void> {
  const formatter = session.platform.getFormatter();
  const trimmed = args?.trim();
  const cmd = `!${flavor.command}`;
  const plural = flavor.command.charAt(0).toUpperCase() + flavor.command.slice(1);

  if (!trimmed) {
    const items = flavor.list();
    if (items.length === 0) {
      await post(
        session,
        'info',
        `${flavor.emoji} No ${flavor.command} yet. Create one with ${formatter.formatCode(flavor.createHint)}.`,
      );
      return;
    }
    const lines = items.map((item, i) => `${i + 1}. ${flavor.describe(item, formatter)}`);
    await post(
      session,
      'info',
      `${flavor.emoji} ${formatter.formatBold(`${plural} (${items.length})`)} — ${flavor.headlineSuffix}\n\n` +
      `${lines.join('\n')}\n\n` +
      `${formatter.formatItalic(`Manage with ${'`' + cmd + ' ' + flavor.actions + ' <n>`'}.`)}`,
    );
    session.threadLogger?.logCommand(flavor.command, 'list', username);
    return;
  }

  const match = trimmed.match(new RegExp(`^(${flavor.actions})\\s+(\\d+)$`, 'i'));
  if (!match) {
    await post(
      session,
      'warning',
      `${flavor.emoji} Usage: ${formatter.formatCode(cmd)} or ${formatter.formatCode(`${cmd} ${flavor.actions} <n>`)}`,
    );
    return;
  }
  const [, action, indexArg] = match;
  const item = flavor.list()[parseInt(indexArg, 10) - 1];
  if (!item) {
    await post(session, 'warning', `${flavor.emoji} No ${flavor.noun.toLowerCase()} ${indexArg}. See ${formatter.formatCode(cmd)}.`);
    return;
  }

  const lowered = action.toLowerCase();
  const platformGated = flavor.platformAllowedActions?.has(lowered) ?? false;
  if (!platformGated && !await requireSessionOwner(session, username, `manage ${flavor.command}`)) {
    return;
  }
  if (platformGated && !session.platform.isUserAllowed(username)) {
    await post(
      session,
      'warning',
      `${flavor.emoji} Only platform-allowed users can ${lowered} ${flavor.command} (${formatter.formatCode('@' + username)} is invited to this session only).`,
    );
    return;
  }

  switch (lowered) {
    case 'pause':
      await flavor.update(item.id, { enabled: false });
      await post(session, 'success', `⏸️ ${flavor.noun} ${formatter.formatBold(item.name)} paused.`);
      break;
    case 'resume':
      await flavor.update(item.id, { enabled: true, consecutiveFailures: 0 });
      await post(session, 'success', `▶️ ${flavor.noun} ${formatter.formatBold(item.name)} resumed.`);
      break;
    case 'delete':
      await flavor.remove(item.id);
      await post(session, 'success', `🗑️ ${flavor.noun} ${formatter.formatBold(item.name)} deleted.`);
      break;
    default:
      await flavor.extraAction?.(lowered, item);
  }
  sessionLog(session).info(`${flavor.emoji} @${username}: ${cmd} ${lowered} ${indexArg} ("${item.name}")`);
  auditCommand(session, flavor.command, `${lowered} ${indexArg}`, username);
  session.threadLogger?.logCommand(flavor.command, `${lowered} ${indexArg}`, username);
}

/**
 * `!routines` — list; `!routines pause|resume|delete <n>` (owner-gated);
 * `!routines run <n>` (platform-allowed users, not !invite'd guests; fires
 * outside the schedule).
 */
export async function manageRoutines(
  session: Session,
  args: string | undefined,
  username: string,
  ctx: SessionContext,
): Promise<void> {
  if (!await requireRoutinesEnabled(session, ctx)) return;
  const platformId = session.platformId;
  await manageListItems(session, args, username, {
    emoji: '🕘',
    noun: 'Routine',
    command: 'routines',
    actions: 'pause|resume|delete|run',
    createHint: '!routine every weekday at 9:00, <task>',
    headlineSuffix: 'each run starts a full Claude session in a new thread:',
    describe: (r, formatter) => {
      const status = r.enabled ? '' : ' — ⏸️ paused';
      const last = r.lastRunAt ? ` · last run ${formatIsoMinute(r.lastRunAt)} (${r.lastRunStatus})` : '';
      return `${formatter.formatBold(r.name)} — ${describeSchedule(r.schedule)} · by ${formatter.formatCode('@' + r.createdBy)}${status}${last}`;
    },
    list: () => ctx.state.routinesStore.list(platformId),
    update: (id, patch) => ctx.state.routinesStore.update(platformId, id, patch),
    remove: (id) => ctx.state.routinesStore.remove(platformId, id),
    // `run` spawns a full unattended session under the routine creator's
    // identity, outside the thread a guest was invited to — hence the
    // platform-allowlist gate instead of the owner gate.
    platformAllowedActions: new Set(['run']),
    extraAction: async (action, routine) => {
      if (action !== 'run') return;
      const formatter = session.platform.getFormatter();
      await post(session, 'info', `🕘 Running ${formatter.formatBold(routine.name)} now — it will post in a new thread.`);
      const status = await ctx.ops.fireRoutineNow(platformId, routine);
      if (status === 'skipped') {
        await post(session, 'warning', `🕘 Could not run now (session limit reached or platform busy) — try again shortly.`);
      } else if (status === 'unauthorized') {
        await post(session, 'warning', `🕘 The routine's creator ${formatter.formatCode('@' + routine.createdBy)} is no longer authorized — routine disabled.`);
      } else if (status === 'failed') {
        await post(session, 'warning', `🕘 The run failed to start — check the bot logs.`);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Event triggers (watches)
// ---------------------------------------------------------------------------

/**
 * Guard for the watch commands: posts an explanation and returns false when
 * watches are disabled for the platform or can never fire on it.
 */
async function requireWatchesEnabled(session: Session, ctx: SessionContext): Promise<boolean> {
  if (ctx.ops.isWatchesEnabled(session.platformId)) return true;
  await post(
    session,
    'info',
    `\u{1F441}\uFE0F Watches are disabled for this platform (see the \`watches\` option in config.yaml).`,
  );
  return false;
}

/**
 * `!watch <natural language>` — parse the request with haiku, show the
 * structured result (including the derived prefilter keywords), and wait for
 * a 👍/👎 confirmation before saving. Owner-gated: watches fire unattended
 * sessions as their creator.
 */
export async function createWatch(
  session: Session,
  request: string,
  username: string,
  ctx: SessionContext,
  // Injectable for tests: other test files module-mock quick-query.js, so
  // stubbing via CLAUDE_PATH is unreliable in full-suite runs.
  parse: typeof parseWatchRequest = parseWatchRequest,
): Promise<void> {
  if (!await requireWatchesEnabled(session, ctx)) return;
  // Creation only (mirrors createRoutine): watches never evaluate in direct
  // channel mode, so refuse instead of saving a permanently inert watch —
  // but watches that predate a switch to DCM must stay listable/pausable/
  // deletable via !watches.
  if (await refuseInDirectChannelMode(
    session,
    `\u{1F441}\uFE0F Watches are not available in direct channel mode \u2014 the whole channel already routes to one session.`,
  )) return;
  if (!await requireSessionOwner(session, username, 'create watches')) return;
  const formatter = session.platform.getFormatter();

  const trimmed = request.trim();
  if (!trimmed) {
    await post(session, 'warning', `Usage: ${formatter.formatCode('!watch when <something happens>, <task>')}`);
    return;
  }

  await post(session, 'info', `\u{1F441}\uFE0F Parsing the trigger...`);
  const result = await parse(trimmed);
  if (!result.ok) {
    await post(session, 'warning', `\u{1F441}\uFE0F Could not create a watch: ${result.error}`);
    sessionLog(session).warn(`\u{1F441}\uFE0F Watch parse failed for @${username}: ${result.error}`);
    return;
  }

  const { parsed } = result;
  await postWatchConfirmation(session, ctx, parsed, username);
}

/**
 * Post the watch confirmation card and park the pending prompt. Shared by
 * `!watch` and the agent's `propose_watch` MCP tool — one card, one
 * approval flow: NOTHING saves without a human 👍.
 */
export async function postWatchConfirmation(
  session: Session,
  ctx: SessionContext,
  parsed: ParsedWatchRequest,
  requestedBy: string,
  opts: { proposedByAgent?: boolean } = {},
): Promise<void> {
  const formatter = session.platform.getFormatter();
  const heading = opts.proposedByAgent
    ? `\u{1F441}\uFE0F ${formatter.formatBold(`Claude proposes watch "${parsed.name}"`)} — approve?`
    : `\u{1F441}\uFE0F ${formatter.formatBold(`Create watch "${parsed.name}"?`)}`;
  // Human creations may choose an autonomous posture; agent proposals never do.
  const offerAutonomous = !opts.proposedByAgent;
  const reactions = offerAutonomous
    ? [APPROVAL_EMOJIS[0], ALLOW_ALL_EMOJIS[0], DENIAL_EMOJIS[0]]
    : [APPROVAL_EMOJIS[0], DENIAL_EMOJIS[0]];
  // A watch fires on channel content anyone can post, so spell out the
  // security tradeoff of the autonomous option.
  const choiceLine = offerAutonomous
    ? '👍 save (Claude asks approval before each action) · ✅ save + run autonomously — no approval prompts; only for triggers you fully trust · 👎 discard'
    : 'React \u{1F44D} to save or \u{1F44E} to discard.';
  const confirmPost = await postInteractiveAndRegister(
    session,
    `${heading}\n` +
    `${formatter.formatBold('Fires when:')} ${parsed.condition}\n` +
    `${formatter.formatBold('Task:')} ${parsed.prompt}\n` +
    `${formatter.formatBold('Prefilter keywords:')} ${parsed.keywords.map((k) => formatter.formatCode(k)).join(', ')}\n` +
    `${formatter.formatItalic('Only messages containing one of these keywords are considered; a semantic check then confirms each match before firing.')}\n\n` +
    `${formatter.formatItalic(`Each fire starts a full Claude session in the triggering thread (per-watch cooldown and daily cap apply). ${choiceLine}`)}`,
    reactions,
    (postId, threadId) => ctx.ops.registerPost(postId, threadId),
  );

  session.messageManager?.setPendingWatchPrompt({
    postId: confirmPost.id,
    parsed,
    requestedBy,
    proposedByAgent: opts.proposedByAgent,
  });
  sessionLog(session).info(`\u{1F441}\uFE0F Watch proposal posted for @${requestedBy}${opts.proposedByAgent ? ' (agent-proposed)' : ''}: "${parsed.name}"`);
}

/**
 * `!watches` — list; `!watches pause|resume|delete <n>` (owner-gated).
 * No manual run: watches are event-driven (use `!routines run` for
 * on-demand work).
 */
export async function manageWatches(
  session: Session,
  args: string | undefined,
  username: string,
  ctx: SessionContext,
): Promise<void> {
  if (!await requireWatchesEnabled(session, ctx)) return;
  const platformId = session.platformId;
  await manageListItems(session, args, username, {
    emoji: '👁️',
    noun: 'Watch',
    command: 'watches',
    actions: 'pause|resume|delete',
    createHint: '!watch when <something happens>, <task>',
    headlineSuffix: 'each fire starts a full Claude session in the triggering thread:',
    describe: (w, formatter) => {
      const status = w.enabled ? '' : ' — ⏸️ paused';
      const last = w.lastFiredAt ? ` · last fired ${formatIsoMinute(w.lastFiredAt)} (${w.lastFireStatus})` : '';
      return `${formatter.formatBold(w.name)} — fires when ${w.condition} · by ${formatter.formatCode('@' + w.createdBy)}${status}${last}`;
    },
    list: () => ctx.state.watchesStore.list(platformId),
    update: (id, patch) => ctx.state.watchesStore.update(platformId, id, patch),
    remove: (id) => ctx.state.watchesStore.remove(platformId, id),
  });
}
