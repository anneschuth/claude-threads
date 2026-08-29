/**
 * Routine firing: turn a due routine into a bot-initiated session thread.
 *
 * The bot posts the thread's root message itself (`startSession` anchors the
 * session at any post id, whoever authored it), then starts a completely
 * normal session as the routine's creator: platform-default permission mode,
 * account-pool balancing, channel memory injection, idle timeout, and
 * end-of-session distillation all apply unchanged.
 */

import type { SessionContext } from '../operations/session-context/index.js';
import { runUnattendedSession } from '../session/unattended.js';
import { describeSchedule, type Routine, type RoutineRunStatus } from '../persistence/routines-store.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('routines');

/**
 * Fire one routine on one platform.
 *
 * - 'unauthorized': the creator is no longer allowed on the platform — the
 *   scheduler disables the routine (Claude Tag parity: routines stop when
 *   their creator loses access).
 * - 'skipped': transient condition (platform missing, MAX_SESSIONS reached);
 *   the scheduler retries within the firing window and does not count a
 *   failure.
 * - 'failed': the fire itself broke; counts toward auto-disable.
 */
export function fireRoutine(
  routine: Routine,
  platformId: string,
  ctx: SessionContext,
): Promise<RoutineRunStatus | 'unauthorized'> {
  return runUnattendedSession({
    ctx,
    platformId,
    createdBy: routine.createdBy,
    label: `Routine "${routine.name}"`,
    log,
    // Routines anchor on a fresh root post announcing the run.
    resolveAnchor: async (platform) => {
      const formatter = platform.getFormatter();
      const rootPost = await platform.createPost(
        `🕘 ${formatter.formatBold(`Routine: ${routine.name}`)}\n` +
        `${formatter.formatItalic(`${describeSchedule(routine.schedule)} · created by`)} ${formatter.formatUserMention(routine.createdBy)}`,
      );
      return rootPost.id;
    },
    // The prefix tells Claude this is unattended scheduled work, not a live
    // request — it should complete the task and post results in this thread.
    prompt:
      `[Scheduled routine "${routine.name}" — started automatically on its schedule, not by a live user. ` +
      `Complete the task and post the result in this thread.]\n\n${routine.prompt}`,
    // Safe default (true) unless the creator explicitly chose autonomous.
    forceApproval: routine.requireApproval ?? true,
  });
}
