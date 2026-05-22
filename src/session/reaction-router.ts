/**
 * ReactionRouter — dispatches platform reaction events to the right handler.
 *
 * Extracted from `SessionManager` in PR 4. No behavior change vs. the old
 * inline code path; the goal is just to separate reaction routing
 * responsibilities from the rest of `SessionManager` so `manager.ts` shrinks
 * toward a pure orchestration role.
 *
 * Split rationale (unchanged from SessionManager comments):
 * - **SessionManager-owned reactions**: session lifecycle posts (cancel /
 *   escape on the session-start post), worktree prompt (skip / branch pick),
 *   bug-report emoji on the last error post. These mutate session-level
 *   state that lives outside MessageManager, so they stay here.
 * - **MessageManager-delegated reactions**: questions, plan approvals,
 *   minimize toggles, message-approval prompts, context prompts. These are
 *   owned by executors and dispatched via `MessageManager.handleReaction`.
 *
 * The router is a thin adapter around those two layers plus the SECURITY
 * allowlist check that was previously embedded in `SessionManager`.
 */

import type { PlatformClient } from '../platform/index.js';
import type { Session } from './types.js';
import type { ReactionAction } from '../operations/executors/types.js';
import type { SessionRegistry } from './registry.js';
import type { SessionStore } from '../persistence/session-store.js';
import type { ResolvedLimits } from '../config/index.js';
import type { SessionContext } from '../operations/session-context/index.js';
import type { ContextPromptHandler } from '../operations/context-prompt/index.js';
import {
  isCancelEmoji,
  isEscapeEmoji,
  isResumeEmoji,
  getNumberEmojiIndex,
  isBugReportEmoji,
} from '../utils/emoji.js';
import { normalizeEmojiName } from '../platform/utils.js';
import { isAuthorizedForSession } from './authorization.js';
import * as lifecycle from './lifecycle.js';
import * as commands from '../operations/commands/index.js';
import * as worktreeModule from '../operations/worktree/index.js';
import * as contextPrompt from '../operations/context-prompt/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('manager');

/**
 * Dependencies the router needs from `SessionManager`. Passing a plain
 * object keeps the coupling explicit — no hidden access to private state.
 */
export interface ReactionRouterDeps {
  registry: SessionRegistry;
  sessionStore: SessionStore;
  platforms: Map<string, PlatformClient>;
  limits: ResolvedLimits;
  getContext: () => SessionContext;
  getContextPromptHandler: () => ContextPromptHandler;
  persistSession: (session: Session) => void;
  createAndSwitchToWorktree: (
    threadId: string,
    branch: string,
    username: string,
  ) => Promise<void>;
}

/**
 * Route a platform reaction event to the appropriate handler.
 *
 * Returns nothing — the router swallows unhandled reactions (they're just
 * a no-op). Callers wire this to `PlatformClient.on('reaction' | 'reaction_removed')`.
 */
export async function handleReaction(
  deps: ReactionRouterDeps,
  platformId: string,
  postId: string,
  emojiName: string,
  username: string,
  action: ReactionAction,
): Promise<void> {
  // Normalize emoji name to handle platform differences (e.g. Slack's
  // "thumbsup" vs Mattermost's "+1"). Every downstream check assumes the
  // normalized shape.
  const normalizedEmoji = normalizeEmojiName(emojiName);

  // Resume-emoji on a timed-out session's header or timeout post is special:
  // the session is inactive, so the allowlist check can't rely on the active
  // session's `sessionAllowedUsers`. `tryResumeFromReaction` does its own
  // authorization check against the *persisted* allowlist.
  if (action === 'added' && isResumeEmoji(normalizedEmoji)) {
    const resumed = await tryResumeFromReaction(deps, platformId, postId, username);
    if (resumed) return;
  }

  const session = deps.registry.findByPost(postId);
  if (!session) return;

  // Verify this reaction is from the same platform (composite session IDs
  // make this cheap — a Slack post ID can't collide with a Mattermost one,
  // but the guard protects against a future platform that reuses ID shapes).
  if (session.platformId !== platformId) return;

  // SECURITY: Only process reactions from allowed users.
  // This is the primary authorization gate for all reaction-based actions.
  // All reactions are validated here before reaching MessageManager/executors.
  if (
    !session.sessionAllowedUsers.has(username) &&
    !session.platform.isUserAllowed(username)
  ) {
    // Audit trail: record unauthorized reaction attempts so operators can
    // detect probing. Structured fields stay searchable across platforms.
    log.info(`🚫 rejected reaction from unauthorized user`, {
      event: 'reaction.rejected',
      platformId,
      sessionId: session.sessionId,
      postId,
      emoji: normalizedEmoji,
      action,
      user: username,
    });
    return;
  }

  await dispatch(deps, session, postId, normalizedEmoji, username, action);
}

/**
 * Try to resume a timed-out session via emoji reaction on the timeout post
 * or session header.
 */
async function tryResumeFromReaction(
  deps: ReactionRouterDeps,
  platformId: string,
  postId: string,
  username: string,
): Promise<boolean> {
  const persistedSession = deps.sessionStore.findByPostId(platformId, postId);
  if (!persistedSession) return false;

  // Already active? Nothing to resume.
  const sessionId = `${platformId}:${persistedSession.threadId}`;
  if (deps.registry.hasById(sessionId)) return false;

  // Authorization against the *persisted* allowlist — the session object
  // doesn't exist yet, so we can't use `session.sessionAllowedUsers`. Routed
  // through the same isAuthorizedForSession helper as the lifecycle sinks
  // (#388) so there is one authorization decision, not two copies.
  const platform = deps.platforms.get(platformId);
  const sessionAllowedUsers = new Set(
    persistedSession.sessionAllowedUsers || [persistedSession.startedBy].filter(Boolean),
  );
  if (!platform || !isAuthorizedForSession({ username, platform, sessionAllowedUsers })) {
    if (platform) {
      await platform.createPost(
        `⚠️ @${username} is not authorized to resume this session`,
        persistedSession.threadId,
      );
    }
    return false;
  }

  // Capacity check — a resumed session consumes a slot.
  if (deps.registry.size >= deps.limits.maxSessions) {
    if (platform) {
      const fmt = platform.getFormatter();
      await platform.createPost(
        `⚠️ ${fmt.formatBold('Too busy')} - ${deps.registry.size} sessions active. Please try again later.`,
        persistedSession.threadId,
      );
    }
    return false;
  }

  const shortId = persistedSession.threadId.substring(0, 8);
  log.info(`🔄 Resuming session ${shortId}... via emoji reaction by @${username}`);

  await lifecycle.resumeSession(persistedSession, deps.getContext());
  return true;
}

/**
 * Dispatch a normalized, authorized reaction to the right handler.
 *
 * Session-level reactions are checked first — they mutate state that lives
 * on `Session` directly (worktree info, last error, lifecycle flags) and
 * need `SessionManager` callbacks. If no session-level handler claims the
 * reaction, it falls through to `MessageManager.handleReaction` which
 * iterates executors.
 */
async function dispatch(
  deps: ReactionRouterDeps,
  session: Session,
  postId: string,
  emojiName: string,
  username: string,
  action: ReactionAction,
): Promise<void> {
  // ---------------------------------------------------------------------------
  // Session-level reactions (lifecycle, worktrees, bug reports)
  // ---------------------------------------------------------------------------
  if (action === 'added') {
    // Cancel/escape on the session start post
    if (session.sessionStartPostId === postId) {
      if (isCancelEmoji(emojiName)) {
        await commands.cancelSession(session, username, deps.getContext());
        return;
      }
      if (isEscapeEmoji(emojiName)) {
        await commands.interruptSession(session, username);
        return;
      }
    }

    // ❌ on worktree prompt → skip worktree
    if (session.worktreePromptPostId === postId && emojiName === 'x') {
      await worktreeModule.handleWorktreeSkip(
        session,
        username,
        (s) => deps.persistSession(s),
        (s, q) =>
          contextPrompt.offerContextPrompt(
            s,
            q,
            undefined,
            deps.getContextPromptHandler(),
          ),
      );
      return;
    }

    // Number emoji on worktree prompt → select branch suggestion
    if (session.pendingWorktreeSuggestions?.postId === postId) {
      const emojiIndex = getNumberEmojiIndex(emojiName);
      if (emojiIndex >= 0) {
        const handled = await worktreeModule.handleBranchSuggestionReaction(
          session,
          postId,
          emojiIndex,
          username,
          (tid, branch, user) => deps.createAndSwitchToWorktree(tid, branch, user),
        );
        if (handled) return;
      }
    }

    // 🐛 on the last error post → open bug report
    if (session.lastError?.postId === postId && isBugReportEmoji(emojiName)) {
      if (
        session.startedBy === username ||
        session.platform.isUserAllowed(username) ||
        session.sessionAllowedUsers.has(username)
      ) {
        log.info(`🐛 @${username} triggered bug report from error reaction`);
        await commands.reportBug(
          session,
          undefined,
          username,
          deps.getContext(),
          session.lastError,
        );
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // MessageManager-delegated reactions (questions, approvals, toggles)
  // ---------------------------------------------------------------------------
  if (session.messageManager) {
    const handled = await session.messageManager.handleReaction(
      postId,
      emojiName,
      username,
      action,
    );
    if (handled) return;
  }
}
