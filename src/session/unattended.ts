/**
 * The shared admission shell for unattended session starts — routine runs
 * and watch fires. One policy for the gates both runners had hand-copied:
 *
 *   platform registered?      → else 'skipped'
 *   creator still authorized? → else 'unauthorized' (observable, so the
 *                               caller can disable the routine/watch —
 *                               startSession's own fail-closed gate returns
 *                               silently, indistinguishable from success)
 *   session capacity left?    → else 'skipped'
 *   anchor thread free?       → else 'skipped' (re-checked HERE, with no
 *                               await between the check and startSession:
 *                               calling startSession while a start for the
 *                               same key is in flight would deliver the
 *                               synthetic prompt into that other session as
 *                               a follow-up)
 *   started and registered?   → else 'skipped' (phantom-'ok' would burn a
 *                               cooldown/period without a run)
 */

import type { SessionContext } from '../operations/session-context/index.js';
import type { PlatformClient } from '../platform/index.js';
import type { Session } from './types.js';
import { isAuthorizedForSession } from './authorization.js';
import { isSessionStartInFlight, startSession } from './lifecycle.js';

export async function runUnattendedSession(opts: {
  ctx: SessionContext;
  platformId: string;
  /** The user the session runs as; re-gated against the platform allowlist per fire. */
  createdBy: string;
  /** Log prefix, e.g. `Routine "daily standup"`. */
  label: string;
  log: { debug(message: string): void; warn(message: string): void };
  /**
   * Resolve the thread to anchor the session on — may post a root message
   * (routines) or return the triggering message's thread (watches). Runs
   * after the platform/authorization/capacity gates; return null to skip.
   */
  resolveAnchor(platform: PlatformClient): Promise<string | null> | string | null;
  /** Full session prompt, including any unattended-run framing prefix. */
  prompt: string;
  /** Force auto-inclusion of thread context (watch fires; see offerContextPrompt). */
  autoIncludeContext?: boolean;
  /**
   * When true, the fired session runs with interactive permissions even if the
   * platform is configured `skipPermissions: true` — every tool action then
   * needs a human 👍 in the thread. This is the watch/routine's per-item
   * `requireApproval` posture: an unattended run acting on untrusted content
   * must not silently execute tools unless the creator explicitly opted out.
   */
  forceApproval?: boolean;
}): Promise<'ok' | 'skipped' | 'unauthorized'> {
  const { ctx, platformId, createdBy, label, log } = opts;

  const platforms = ctx.state.platforms as ReadonlyMap<string, PlatformClient>;
  const platform = platforms.get(platformId);
  if (!platform) {
    log.debug(`${label}: platform ${platformId} not registered — skipping`);
    return 'skipped';
  }

  if (!isAuthorizedForSession({ username: createdBy, platform, sessionAllowedUsers: undefined })) {
    log.warn(`${label}: creator @${createdBy} no longer authorized on ${platformId}`);
    return 'unauthorized';
  }

  if (ctx.state.sessions.size >= ctx.config.maxSessions) {
    log.debug(`${label}: at MAX_SESSIONS — skipping this run`);
    return 'skipped';
  }

  const threadRoot = await opts.resolveAnchor(platform);
  if (!threadRoot) return 'skipped';

  const sessions = ctx.state.sessions as ReadonlyMap<string, Session>;
  const sessionKey = ctx.ops.getSessionId(platformId, threadRoot);
  if (sessions.has(sessionKey) || isSessionStartInFlight(sessionKey)) {
    log.debug(`${label}: thread already hosts a session (or one is starting) — skipping`);
    return 'skipped';
  }

  await startSession(
    {
      prompt: opts.prompt,
      // Autonomous runs must not stall on interactive prompts.
      skipWorktreePrompt: true,
      autoIncludeContext: opts.autoIncludeContext,
      // Marks the session so the agent propose_routine/propose_watch tools
      // are suppressed — unattended work must not schedule more unattended
      // work (self-replication loop).
      unattended: true,
    },
    createdBy,
    undefined,
    threadRoot,
    platformId,
    ctx,
    undefined,
    // Per-item approval posture: force interactive permissions (persisted via
    // Session.forceInteractivePermissions) so tool actions require a human 👍
    // even under a skipPermissions platform. No-op on platforms already
    // running interactive. Omitted (undefined) when the creator chose autonomous.
    opts.forceApproval ? { forceInteractivePermissions: true } : undefined,
  );

  // startSession reports admission failures by posting, not throwing —
  // verify the session actually registered before reporting success.
  if (!sessions.has(sessionKey)) {
    log.debug(`${label}: startSession declined to start a session — skipping`);
    return 'skipped';
  }
  return 'ok';
}
