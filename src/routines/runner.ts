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
import type { PlatformClient } from '../platform/index.js';
import { isAuthorizedForSession } from '../session/authorization.js';
import { startSession } from '../session/lifecycle.js';
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
export async function fireRoutine(
  routine: Routine,
  platformId: string,
  ctx: SessionContext,
): Promise<RoutineRunStatus | 'unauthorized'> {
  const platforms = ctx.state.platforms as ReadonlyMap<string, PlatformClient>;
  const platform = platforms.get(platformId);
  if (!platform) {
    log.debug(`Routine "${routine.name}": platform ${platformId} not registered — skipping`);
    return 'skipped';
  }

  // Pre-check the creator's authorization so the outcome is observable —
  // startSession's own fail-closed gate returns silently, which the
  // scheduler could not tell apart from success.
  if (!isAuthorizedForSession({ username: routine.createdBy, platform, sessionAllowedUsers: undefined })) {
    log.warn(`Routine "${routine.name}": creator @${routine.createdBy} no longer authorized on ${platformId}`);
    return 'unauthorized';
  }

  if (ctx.state.sessions.size >= ctx.config.maxSessions) {
    log.debug(`Routine "${routine.name}": at MAX_SESSIONS — skipping this tick`);
    return 'skipped';
  }

  const formatter = platform.getFormatter();
  const rootPost = await platform.createPost(
    `🕘 ${formatter.formatBold(`Routine: ${routine.name}`)}\n` +
    `${formatter.formatItalic(`${describeSchedule(routine.schedule)} · created by`)} ${formatter.formatUserMention(routine.createdBy)}`,
  );

  await startSession(
    {
      // The prefix tells Claude this is unattended scheduled work, not a live
      // request — it should complete the task and post results in this thread.
      prompt:
        `[Scheduled routine "${routine.name}" — started automatically on its schedule, not by a live user. ` +
        `Complete the task and post the result in this thread.]\n\n${routine.prompt}`,
      // Autonomous runs must not stall on the interactive worktree prompt.
      skipWorktreePrompt: true,
    },
    routine.createdBy,
    undefined,
    rootPost.id,
    platformId,
    ctx,
  );

  // startSession reports admission failures by posting into the thread, not
  // by throwing — it declines silently when the session cap was hit between
  // our pre-check and its own (which also counts in-flight starts), or when
  // its header post fails. Verify the session actually registered before
  // reporting success: a silent decline must retry within the window
  // ('skipped'), not consume the period as a phantom 'ok'.
  if (!ctx.state.sessions.has(ctx.ops.getSessionId(platformId, rootPost.id))) {
    log.debug(`Routine "${routine.name}": startSession declined to start a session — skipping this tick`);
    return 'skipped';
  }
  return 'ok';
}
