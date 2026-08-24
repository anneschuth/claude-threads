/**
 * Channel memory commands (!remember, !memory) — the bot-owned shared-notes
 * layer. Split from handler.ts; shares the owner gate and audit hook via
 * guards.ts.
 */

import type { Session } from '../../session/types.js';
import type { SessionContext } from '../session-context/index.js';
import { post } from '../post-helpers/index.js';
import { MAX_ENTRY_LENGTH, sanitizeEntryText, entryTextExceedsCap } from '../../memory/store.js';
import { auditCommand, requireSessionOwner } from './guards.js';
import { createLogger } from '../../utils/logger.js';
import { createSessionLog } from '../../utils/session-log.js';

const log = createLogger('commands');
const sessionLog = createSessionLog(log);

// ---------------------------------------------------------------------------
// Channel memory commands (!remember, !memory)
// ---------------------------------------------------------------------------

/**
 * Guard for the memory commands: posts an explanation and returns false when
 * the platform's channel memory layer is disabled.
 */
async function requireChannelMemory(session: Session, ctx: SessionContext): Promise<boolean> {
  const memoryConfig = ctx.ops.getPlatformMemoryConfig(session.platformId);
  if (memoryConfig.enabled && memoryConfig.channelLayer) return true;
  await post(
    session,
    'info',
    `🧠 Channel memory is disabled for this platform (see the \`memory\` option in config.yaml).`,
  );
  return false;
}

/**
 * `!remember <text>` — save a note to the channel's shared memory. Any
 * session-authorized user may add entries (authorization is enforced
 * upstream by the executor's `isAllowed` gate).
 *
 * New sessions see the entry immediately; running sessions pick it up on
 * their next respawn/resume.
 */
export async function rememberEntry(
  session: Session,
  text: string,
  username: string,
  ctx: SessionContext,
): Promise<void> {
  if (!await requireChannelMemory(session, ctx)) return;
  const formatter = session.platform.getFormatter();

  const sanitized = sanitizeEntryText(text);
  if (!sanitized) {
    await post(session, 'warning', `Usage: ${formatter.formatCode('!remember <text>')}`);
    return;
  }
  if (entryTextExceedsCap(text)) {
    await post(
      session,
      'warning',
      `🧠 Note truncated to ${MAX_ENTRY_LENGTH} characters. For longer content, link to a document instead.`,
    );
  }

  const result = await ctx.state.memoryStore.addChannelEntries(session.platformId, [
    { text: sanitized, source: 'user', addedBy: username },
  ]);
  if (result.added.length > 0) {
    // Never silent about removals: name what the new note replaced.
    const replaced = result.superseded.length > 0
      ? ` It replaces ${result.superseded.length === 1
          ? `an earlier note (${formatter.formatItalic(result.superseded[0].text.substring(0, 120))})`
          : `${result.superseded.length} earlier notes`}.`
      : '';
    await post(
      session,
      'success',
      `🧠 Remembered for this channel.${replaced} ${formatter.formatItalic(`New sessions will see it; view with ${'`!memory`'}.`)}`,
    );
    sessionLog(session).info(`🧠 @${username} added a channel memory entry`);
  } else {
    await post(session, 'info', `🧠 Already known — an equivalent entry exists. See ${formatter.formatCode('!memory')}.`);
    sessionLog(session).debug(`🧠 @${username} tried to add a duplicate channel memory entry`);
  }
  session.threadLogger?.logCommand('remember', sanitized.substring(0, 80), username);
}

/**
 * `!memory` — show the channel's shared memory as a numbered list.
 */
export async function showMemory(
  session: Session,
  username: string,
  ctx: SessionContext,
): Promise<void> {
  if (!await requireChannelMemory(session, ctx)) return;
  const formatter = session.platform.getFormatter();

  const entries = ctx.state.memoryStore.listChannelEntries(session.platformId);
  if (entries.length === 0) {
    await post(
      session,
      'info',
      `🧠 No channel memory yet. Add a note with ${formatter.formatCode('!remember <text>')} — it will be shared with every session in this channel.`,
    );
    return;
  }

  const lines = entries.map((e, i) => {
    // Author as inline code, NOT formatUserMention: a live @mention would
    // ping every entry author each time anyone views the listing.
    const source = e.source === 'user' ? formatter.formatCode(`@${e.addedBy ?? 'unknown'}`) : formatter.formatItalic('distilled');
    return `${i + 1}. [${e.addedAt}] (${source}) ${e.text}`;
  });
  const intro = `🧠 ${formatter.formatBold(`Channel memory (${entries.length} ${entries.length === 1 ? 'entry' : 'entries'})`)} — shared by all threads in this channel:`;
  const outro = formatter.formatItalic(`Remove with ${'`!memory forget <number>`'} or ${'`!memory forget <text>`'}; add with ${'`!remember <text>`'}.`);

  // A full channel memory (hundreds of entries, up to ~530 chars per line)
  // can exceed the platform's post size limit — batch the listing so the
  // createPost call can't fail on length.
  const batchBudget = Math.max(
    1000,
    session.platform.getMessageLimits().maxLength - intro.length - outro.length - 100,
  );
  const batches: string[] = [];
  let current = '';
  for (const line of lines) {
    if (current && current.length + 1 + line.length > batchBudget) {
      batches.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) batches.push(current);

  for (let i = 0; i < batches.length; i++) {
    const prefix = i === 0 ? `${intro}\n\n` : '';
    const suffix = i === batches.length - 1 ? `\n\n${outro}` : '';
    await post(session, 'info', `${prefix}${batches[i]}${suffix}`);
  }
  session.threadLogger?.logCommand('memory', 'show', username);
}

/**
 * `!memory forget <n|text>` / `!memory forget all` — remove channel memory.
 * Owner-gated like other session-shaping settings: memory is shared channel
 * state, so removal is restricted to the session owner / allowed users.
 *
 * Removal is atomic and applies to all future sessions; sessions already
 * running keep their injected copy until their next respawn.
 */
export async function forgetMemory(
  session: Session,
  selector: string,
  username: string,
  ctx: SessionContext,
): Promise<void> {
  if (!await requireChannelMemory(session, ctx)) return;
  if (!await requireSessionOwner(session, username, 'edit channel memory')) {
    return;
  }
  const formatter = session.platform.getFormatter();
  const trimmed = selector.trim();

  if (trimmed.toLowerCase() === 'all') {
    const count = ctx.state.memoryStore.listChannelEntries(session.platformId).length;
    await ctx.state.memoryStore.clearChannel(session.platformId);
    await post(
      session,
      'success',
      `🧠 Channel memory cleared (${count} ${count === 1 ? 'entry' : 'entries'} removed). Running sessions keep their copy until their next restart.`,
    );
    sessionLog(session).info(`🧠 @${username} cleared channel memory (${count} entries)`);
    auditCommand(session, 'memory', 'forget all', username);
    session.threadLogger?.logCommand('memory', 'forget all', username);
    return;
  }

  const asNumber = /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : undefined;
  const result = await ctx.state.memoryStore.forgetChannelEntry(
    session.platformId,
    asNumber ?? trimmed,
  );

  if (result.ok) {
    await post(session, 'success', `🧠 Forgot: ${formatter.formatItalic(result.removed.text)}`);
    sessionLog(session).info(`🧠 @${username} removed a channel memory entry`);
    auditCommand(session, 'memory', 'forget', username);
    session.threadLogger?.logCommand('memory', 'forget', username);
    return;
  }

  switch (result.reason) {
    case 'empty':
      await post(session, 'info', `🧠 No channel memory to forget.`);
      break;
    case 'ambiguous': {
      // Cap the preview so a broad selector can't blow the post size limit.
      const MAX_AMBIGUOUS_SHOWN = 10;
      const shown = result.matches.slice(0, MAX_AMBIGUOUS_SHOWN);
      const more = result.matches.length > shown.length
        ? `\n… and ${result.matches.length - shown.length} more`
        : '';
      const list = shown.map((e) => `- ${e.text}`).join('\n');
      await post(
        session,
        'warning',
        `🧠 That matches ${result.matches.length} entries — use ${formatter.formatCode('!memory')} and forget by number instead:\n${list}${more}`,
      );
      break;
    }
    default:
      await post(
        session,
        'warning',
        `🧠 No matching entry. Use ${formatter.formatCode('!memory')} to list entries, then ${formatter.formatCode('!memory forget <number>')}.`,
      );
  }
}
