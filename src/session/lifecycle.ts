/**
 * Session lifecycle management module
 *
 * Handles session start, resume, exit, cleanup, and shutdown.
 */

import type { Session } from './types.js';
import {
  getSessionStatus,
  createSessionTimers,
  createSessionLifecycle,
  createResumedLifecycle,
  transitionTo,
  isSessionRestarting,
  isSessionCancelled,
} from './types.js';
import { clearAllTimers } from './timer-manager.js';
import type { PlatformClient, PlatformFile } from '../platform/index.js';
import type { ClaudeCliOptions, ClaudeEvent } from '../claude/cli.js';
import { ClaudeCli } from '../claude/cli.js';
import type { PersistedSession } from '../persistence/session-store.js';
import { createThreadLogger } from '../persistence/thread-logger.js';
import { getLogo } from '../logo.js';
import { VERSION } from '../version.js';
import { generateChatPlatformPrompt, buildSessionContext } from '../commands/index.js';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { keepAlive } from '../utils/keep-alive.js';
import { logAndNotify, withErrorHandling } from '../utils/error-handler/index.js';
import { createLogger } from '../utils/logger.js';
import { createSessionLog } from '../utils/session-log.js';
import { postError, postInfo, postResume, postWarning, postTimeout, updateLastMessage } from '../operations/post-helpers/index.js';
import type { SessionContext } from '../operations/session-context/index.js';
import { suggestSessionMetadata } from '../operations/suggestions/title.js';
import { suggestSessionTags } from '../operations/suggestions/tag.js';
import { MessageManager, PostTracker } from '../operations/index.js';
import {
  getThreadMessagesForContext,
  formatContextForClaude,
} from '../operations/context-prompt/index.js';

const log = createLogger('lifecycle');
const sessionLog = createSessionLog(log);

// ---------------------------------------------------------------------------
// Internal helpers for DRY code
// ---------------------------------------------------------------------------

/**
 * Get sessions map with correct mutable type.
 * Reduces type casting noise throughout the module.
 */
function mutableSessions(ctx: SessionContext): Map<string, Session> {
  return ctx.state.sessions as Map<string, Session>;
}

/**
 * Get postIndex map with correct mutable type.
 * Reduces type casting noise throughout the module.
 */
function mutablePostIndex(ctx: SessionContext): Map<string, string> {
  return ctx.state.postIndex as Map<string, string>;
}

/**
 * Clean up session timers (updateTimer, typingTimer, statusBarTimer).
 * Call this before removing a session from the map.
 */
function cleanupSessionTimers(session: Session): void {
  clearAllTimers(session.timers);
}

/**
 * Close the thread logger for a session.
 * Call this before removing a session from the map.
 */
async function closeThreadLogger(session: Session, action?: string, details?: Record<string, unknown>): Promise<void> {
  if (session.threadLogger) {
    // Log the lifecycle event before closing
    if (action) {
      session.threadLogger.logLifecycle(action as 'exit' | 'timeout' | 'interrupt' | 'kill', details);
    }
    await session.threadLogger.close();
  }
}

/**
 * Remove all postIndex entries for a given threadId.
 * Call this when cleaning up a session.
 */
function cleanupPostIndex(ctx: SessionContext, threadId: string): void {
  const postIndex = mutablePostIndex(ctx);
  for (const [postId, tid] of postIndex.entries()) {
    if (tid === threadId) {
      postIndex.delete(postId);
    }
  }
}

/**
 * Helper to find a persisted session by raw threadId.
 * Persisted sessions are keyed by composite sessionId, so we need to iterate.
 */
function findPersistedByThreadId(
  persisted: Map<string, PersistedSession>,
  threadId: string
): PersistedSession | undefined {
  for (const session of persisted.values()) {
    if (session.threadId === threadId) {
      return session;
    }
  }
  return undefined;
}

/**
 * Create a MessageManager for a session.
 * Handles all content, task list, question, and subagent operations.
 *
 * Uses event subscriptions to handle callbacks from MessageManager.
 * This replaces the old callback-based approach for cleaner code.
 */
function createMessageManager(
  session: Session,
  ctx: SessionContext
): MessageManager {
  const postTracker = new PostTracker();

  // Create the MessageManager with minimal options (no callbacks)
  const messageManager = new MessageManager({
    platform: session.platform,
    postTracker,
    threadId: session.threadId,
    sessionId: session.sessionId,
    worktreePath: session.worktreeInfo?.worktreePath,
    worktreeBranch: session.worktreeInfo?.branch,
    registerPost: (postId, options) => {
      ctx.ops.registerPost(postId, session.threadId);
      postTracker.register(postId, session.threadId, session.sessionId, options);
    },
    updateLastMessage: (post) => {
      updateLastMessage(session, post);
    },
    // onBumpTaskList callback not implemented - task list bumping is handled separately
    // via the legacy streaming.ts path during the transition period
  });

  // Subscribe to events from MessageManager
  // These replace the callback-based approach for cleaner separation of concerns

  messageManager.events.on('question:complete', ({ toolUseId: _toolUseId, answers }) => {
    // Send answers back to Claude
    const answerJson = JSON.stringify(answers);
    session.claude.sendMessage(answerJson);
  });

  messageManager.events.on('approval:complete', ({ toolUseId: _toolUseId, approved }) => {
    // Send approval/denial back to Claude
    const response = approved ? 'approved' : 'denied';
    session.claude.sendMessage(response);
  });

  messageManager.events.on('message-approval:complete', async ({ decision, fromUser, originalMessage }) => {
    if (decision === 'allow') {
      // Allow this single message
      session.claude.sendMessage(originalMessage);
      session.lastActivityAt = new Date();
      ctx.ops.startTyping(session);
      sessionLog(session).info(`Message from @${fromUser} approved`);
    } else if (decision === 'invite') {
      // Invite user to session and send their message
      session.sessionAllowedUsers.add(fromUser);
      await ctx.ops.updateSessionHeader(session);
      session.claude.sendMessage(originalMessage);
      session.lastActivityAt = new Date();
      ctx.ops.startTyping(session);
      sessionLog(session).info(`@${fromUser} invited to session`);
    }
    // 'deny' - nothing extra to do, post already updated by MessageManager
  });

  messageManager.events.on('context-prompt:complete', async ({ selection, queuedPrompt, queuedFiles: _queuedFiles, threadMessageCount: _threadMessageCount }) => {
    // Build message with or without context
    let messageToSend = queuedPrompt;
    if (typeof selection === 'number' && selection > 0) {
      // User selected to include context - fetch and format messages
      const messages = await getThreadMessagesForContext(session, selection);
      if (messages.length > 0) {
        const contextPrefix = formatContextForClaude(messages);
        messageToSend = contextPrefix + queuedPrompt;
      }
      sessionLog(session).debug(`🧵 Including ${selection} messages as context`);
    } else {
      // No context (selection is 0 for skip, or 'timeout')
      const reason = selection === 'timeout' ? 'timed out' : 'skipped';
      sessionLog(session).debug(`🧵 Context ${reason}, continuing without`);
    }

    // Increment message counter
    session.messageCount++;

    // Inject metadata reminder periodically
    messageToSend = maybeInjectMetadataReminder(messageToSend, session, ctx, session);

    // Build content with files (if any)
    // Note: queuedFiles from MessageManager are simplified refs (id, name)
    // For now, send without files - the full PlatformFile[] would need to be
    // stored separately if file support is needed here
    const content = await ctx.ops.buildMessageContent(messageToSend, session.platform, undefined);

    // Send the message to Claude
    if (session.claude.isRunning()) {
      session.claude.sendMessage(content);
      ctx.ops.startTyping(session);
    }

    // Update activity and persist
    session.lastActivityAt = new Date();
    ctx.ops.persistSession(session);
  });

  messageManager.events.on('worktree-prompt:complete', async ({ decision, branch, worktreePath, username }) => {
    if (decision === 'join') {
      // Switch to the existing worktree
      await ctx.ops.switchToWorktree(session.threadId, worktreePath, username);
      sessionLog(session).info(`🌿 @${username} joined existing worktree ${branch}`);
    } else {
      sessionLog(session).info(`❌ @${username} skipped joining existing worktree ${branch}`);
    }
    ctx.ops.persistSession(session);
  });

  messageManager.events.on('update-prompt:complete', async ({ decision }) => {
    if (decision === 'update_now') {
      sessionLog(session).info('🔄 User triggered immediate update');
      await ctx.ops.forceUpdate();
    } else {
      sessionLog(session).info('⏸️ User deferred update for 1 hour');
      ctx.ops.deferUpdate(60);
    }
    ctx.ops.persistSession(session);
  });

  messageManager.events.on('bug-report:complete', async ({ decision, report: _report }) => {
    await ctx.ops.handleBugReportApproval(session, decision === 'approve', session.startedBy);
  });

  // Status and lifecycle events (these are typically for session header updates)
  // Note: These are handled differently - they update session state directly
  // For now, these remain as part of the session management layer

  return messageManager;
}

// ---------------------------------------------------------------------------
// Out-of-band metadata suggestions (fire-and-forget)
// ---------------------------------------------------------------------------

/**
 * Fire metadata suggestions (title, description, tags) in the background.
 * This is fire-and-forget - it never blocks session startup and never throws.
 *
 * @param session - The session to update
 * @param prompt - The user's initial prompt
 * @param ctx - Session context for persistence and UI updates
 */
function fireMetadataSuggestions(
  session: Session,
  prompt: string,
  ctx: SessionContext
): void {
  // Fire immediately without awaiting
  void (async () => {
    try {
      const sessionId = session.sessionId;

      // Run title/description and tags in parallel
      const [metadata, tags] = await Promise.all([
        suggestSessionMetadata(prompt),
        suggestSessionTags(prompt),
      ]);

      // Check if session still exists (might have been cleaned up while we awaited)
      const currentSession = (ctx.state.sessions as Map<string, Session>).get(sessionId);
      if (!currentSession) {
        sessionLog(session).debug('Session gone before metadata suggestions completed');
        return;
      }

      // Only update if we got results and session doesn't already have metadata
      let updated = false;

      if (metadata && !currentSession.sessionTitle) {
        currentSession.sessionTitle = metadata.title;
        currentSession.sessionDescription = metadata.description;
        sessionLog(currentSession).debug(`Set title: "${metadata.title}"`);
        updated = true;
      }

      if (tags.length > 0 && (!currentSession.sessionTags || currentSession.sessionTags.length === 0)) {
        currentSession.sessionTags = tags;
        sessionLog(currentSession).debug(`Set tags: ${tags.join(', ')}`);
        updated = true;
      }

      // Update persistence and UI if anything changed
      if (updated) {
        ctx.ops.persistSession(currentSession);
        await ctx.ops.updateStickyMessage();
        await ctx.ops.updateSessionHeader(currentSession);
      }
    } catch (err) {
      // Fire-and-forget: log but never throw
      sessionLog(session).debug(`Metadata suggestion error: ${err}`);
    }
  })();
}

/**
 * Fire periodic re-classification if session focus might have shifted.
 * Called periodically (every N messages) to update title/tags.
 * This is fire-and-forget - it never blocks and never throws.
 *
 * Uses structured context with original task as anchor to prevent
 * title thrashing from minor conversation variations.
 *
 * @param session - The session to potentially re-classify
 * @param currentMessage - The latest user message (used for context)
 * @param ctx - Session context for persistence and UI updates
 */
function firePeriodicReclassification(
  session: Session,
  currentMessage: string,
  ctx: SessionContext
): void {
  // Fire immediately without awaiting
  void (async () => {
    try {
      const sessionId = session.sessionId;

      // Use structured context for stability:
      // - Original task is PRIMARY (anchor for title)
      // - Recent message is SECONDARY (only matters if focus fundamentally changed)
      // - Current title helps LLM maintain stability
      const titleContext = session.firstPrompt
        ? {
            originalTask: session.firstPrompt,
            recentContext: currentMessage,
            currentTitle: session.sessionTitle,
          }
        : currentMessage;  // Fallback to simple string if no firstPrompt

      // For tags, still use combined context (tags are less sensitive to thrashing)
      const tagContext = session.firstPrompt
        ? `Original task: ${session.firstPrompt}\n\nRecent activity: ${currentMessage}`
        : currentMessage;

      // Run title/description and tags in parallel
      const [metadata, tags] = await Promise.all([
        suggestSessionMetadata(titleContext),
        suggestSessionTags(tagContext),
      ]);

      // Check if session still exists
      const currentSession = (ctx.state.sessions as Map<string, Session>).get(sessionId);
      if (!currentSession) {
        sessionLog(session).debug('Session gone before reclassification completed');
        return;
      }

      // Update metadata if we got valid results
      // Note: With structured context, the LLM is instructed to prefer keeping
      // the current title unless there's a fundamental focus shift
      let updated = false;

      if (metadata) {
        // Only update if title actually changed (LLM may return same title for stability)
        if (metadata.title !== currentSession.sessionTitle) {
          currentSession.sessionTitle = metadata.title;
          currentSession.sessionDescription = metadata.description;
          sessionLog(currentSession).debug(`Updated title: "${metadata.title}"`);
          updated = true;
        } else {
          sessionLog(currentSession).debug('Title unchanged (stable)');
        }
      }

      if (tags.length > 0) {
        currentSession.sessionTags = tags;
        sessionLog(currentSession).debug(`Updated tags: ${tags.join(', ')}`);
        updated = true;
      }

      // Update persistence and UI if anything changed
      if (updated) {
        ctx.ops.persistSession(currentSession);
        await ctx.ops.updateStickyMessage();
        await ctx.ops.updateSessionHeader(currentSession);
      }
    } catch (err) {
      // Fire-and-forget: log but never throw
      sessionLog(session).debug(`Reclassification error: ${err}`);
    }
  })();
}

// ---------------------------------------------------------------------------
// System prompt for chat platform context
// ---------------------------------------------------------------------------

/**
 * System prompt that gives Claude context about running in a chat platform.
 * This is appended to Claude's system prompt via --append-system-prompt.
 *
 * GENERATED from the unified command registry in src/commands/registry.ts.
 * Edit the registry to update this prompt - do not edit this constant directly.
 */
export const CHAT_PLATFORM_PROMPT = generateChatPlatformPrompt();

/**
 * How often to fire periodic reclassification (every N messages).
 */
const RECLASSIFICATION_INTERVAL = 5;

/**
 * Check if periodic reclassification should be triggered for this message.
 * Fires out-of-band re-classification of title/tags at regular intervals.
 * Always returns the original message unchanged (no longer injects reminders
 * since we now handle metadata out-of-band via quickQuery).
 */
export function maybeInjectMetadataReminder(
  message: string,
  session: { messageCount: number },
  ctx?: SessionContext,
  fullSession?: Session
): string {
  // Fire out-of-band re-classification periodically
  if (session.messageCount > 1 && session.messageCount % RECLASSIFICATION_INTERVAL === 0) {
    if (ctx && fullSession) {
      firePeriodicReclassification(fullSession, message, ctx);
    }
  }
  // Always return the message unchanged
  return message;
}

// ---------------------------------------------------------------------------
// Session creation
// ---------------------------------------------------------------------------

/**
 * Create a new session for a thread.
 */
export async function startSession(
  options: { prompt: string; files?: PlatformFile[] },
  username: string,
  displayName: string | undefined,
  replyToPostId: string | undefined,
  platformId: string,
  ctx: SessionContext
): Promise<void> {
  const threadId = replyToPostId || '';

  // Check if session already exists for this thread
  const existingSessionId = ctx.ops.getSessionId(platformId, threadId);
  const existingSession = mutableSessions(ctx).get(existingSessionId);
  if (existingSession && existingSession.claude.isRunning()) {
    // Send as follow-up instead
    await sendFollowUp(existingSession, options.prompt, options.files, ctx, username, displayName);
    return;
  }

  const platforms = ctx.state.platforms as Map<string, PlatformClient>;
  const platform = platforms.get(platformId);
  if (!platform) {
    throw new Error(`Platform '${platformId}' not found. Call addPlatform() first.`);
  }

  // Check max sessions limit
  if (ctx.state.sessions.size >= ctx.config.maxSessions) {
    const formatter = platform.getFormatter();
    // Create a temporary pseudo-session just for posting the message
    // (we don't have a real session yet since we're at capacity)
    const tempSession = {
      platform,
      threadId: replyToPostId || '',
      sessionId: 'temp',
    } as Session;
    await postWarning(tempSession, `${formatter.formatBold('Too busy')} - ${ctx.state.sessions.size} sessions active. Please try again later.`);
    return;
  }

  // Post initial session message
  const startFormatter = platform.getFormatter();
  const post = await withErrorHandling(
    () => platform.createPost(
      `${getLogo(VERSION)}\n\n${startFormatter.formatItalic('Starting session...')}`,
      replyToPostId
    ),
    { action: 'Create session post' }
  );
  if (!post) return;
  const actualThreadId = replyToPostId || post.id;
  const sessionId = ctx.ops.getSessionId(platformId, actualThreadId);

  // Generate a unique session ID for this Claude session
  const claudeSessionId = randomUUID();

  // Build system prompt with session context
  const sessionContext = buildSessionContext(platform, ctx.config.workingDir);
  const systemPrompt = `${sessionContext}\n\n${CHAT_PLATFORM_PROMPT}`;

  // Create Claude CLI with options
  const platformMcpConfig = platform.getMcpConfig();

  const cliOptions: ClaudeCliOptions = {
    workingDir: ctx.config.workingDir,
    threadId: actualThreadId,
    skipPermissions: ctx.config.skipPermissions,
    sessionId: claudeSessionId,
    resume: false,
    chrome: ctx.config.chromeEnabled,
    platformConfig: platformMcpConfig,
    appendSystemPrompt: systemPrompt,
    logSessionId: sessionId,  // Route logs to session panel
    permissionTimeoutMs: ctx.config.permissionTimeoutMs,
  };
  const claude = new ClaudeCli(cliOptions);

  // Create the session object
  const session: Session = {
    platformId,
    threadId: actualThreadId,
    sessionId,
    platform,
    claudeSessionId,
    startedBy: username,
    startedByDisplayName: displayName,
    startedAt: new Date(),
    lastActivityAt: new Date(),
    sessionNumber: ctx.state.sessions.size + 1,
    workingDir: ctx.config.workingDir,
    claude,
    planApproved: false,
    sessionAllowedUsers: new Set([username]),
    forceInteractivePermissions: false,
    sessionStartPostId: post.id,
    tasksPostId: null,
    lastTasksContent: null,
    tasksCompleted: false,
    tasksMinimized: false,
    timers: createSessionTimers(),
    lifecycle: createSessionLifecycle(),
    timeoutWarningPosted: false,
    inProgressTaskStart: null,
    activeToolStarts: new Map(),
    firstPrompt: options.prompt,  // Set early so sticky message can use it
    messageCount: 0,  // Will be incremented when first message is sent
    isProcessing: true,  // Starts as true since we're sending initial prompt
    recentEvents: [],  // Bug report context: recent tool uses/errors
    // Thread logger for persisting events to disk
    threadLogger: createThreadLogger(platformId, actualThreadId, claudeSessionId, {
      enabled: ctx.config.threadLogsEnabled ?? true,
    }),
  };

  // Create MessageManager for this session
  session.messageManager = createMessageManager(session, ctx);

  // Log session start
  session.threadLogger?.logLifecycle('start', {
    username,
    workingDir: ctx.config.workingDir,
  });

  // Register session
  mutableSessions(ctx).set(sessionId, session);
  ctx.ops.registerPost(post.id, actualThreadId);
  ctx.ops.emitSessionAdd(session);
  sessionLog(session).info(`▶ Session started by @${username}`);

  // Fire out-of-band title/tag suggestions (don't block session startup)
  fireMetadataSuggestions(session, options.prompt, ctx);

  // Notify keep-alive that a session started
  keepAlive.sessionStarted();

  // Update the header with full session info
  await ctx.ops.updateSessionHeader(session);

  // Update sticky channel message with new session
  await ctx.ops.updateStickyMessage();

  // Start typing indicator
  ctx.ops.startTyping(session);

  // Bind event handlers (use sessionId which is the composite key)
  claude.on('event', (e: ClaudeEvent) => ctx.ops.handleEvent(sessionId, e));
  claude.on('exit', (code: number) => ctx.ops.handleExit(sessionId, code));

  try {
    claude.start();
  } catch (err) {
    await logAndNotify(err, { action: 'Start Claude', session });
    ctx.ops.stopTyping(session);
    ctx.ops.emitSessionRemove(session.sessionId);
    mutableSessions(ctx).delete(session.sessionId);
    await ctx.ops.updateStickyMessage();
    return;
  }

  // Check if we should prompt for worktree
  const shouldPrompt = await ctx.ops.shouldPromptForWorktree(session);
  if (shouldPrompt) {
    session.queuedPrompt = options.prompt;
    session.queuedFiles = options.files;
    session.pendingWorktreePrompt = true;
    await ctx.ops.postWorktreePrompt(session, shouldPrompt);
    ctx.ops.persistSession(session);
    await ctx.ops.updateStickyMessage();
    return;
  }

  // Build message content
  const content = await ctx.ops.buildMessageContent(options.prompt, session.platform, options.files);
  const messageText = typeof content === 'string' ? content : options.prompt;

  // Check if this is a mid-thread start (replyToPostId means we're replying in an existing thread)
  // Offer context prompt if there are previous messages in the thread
  // Pass replyToPostId to exclude the triggering message from the count
  if (replyToPostId) {
    const contextOffered = await ctx.ops.offerContextPrompt(session, messageText, options.files, replyToPostId);
    if (contextOffered) {
      // Context prompt was posted, message is queued
      // Don't persist yet - offerContextPrompt handles that
      return;
    }
  }

  // Increment message counter for first message
  session.messageCount++;

  // Send the message to Claude (no context prompt, or no previous messages)
  claude.sendMessage(content);

  // NOTE: We don't persist here. We wait for Claude to actually respond before persisting.
  // This prevents persisting sessions where Claude dies before saving its conversation,
  // which would result in "No conversation found" errors on resume.
  // Persistence happens in events.ts when we receive the first response from Claude.
}

/**
 * Resume a session from persisted state.
 */
export async function resumeSession(
  state: PersistedSession,
  ctx: SessionContext
): Promise<void> {
  // Validate required fields - skip gracefully if critical data is missing
  if (!state.threadId || !state.platformId || !state.claudeSessionId || !state.workingDir) {
    const missing = [
      !state.threadId && 'threadId',
      !state.platformId && 'platformId',
      !state.claudeSessionId && 'claudeSessionId',
      !state.workingDir && 'workingDir',
    ].filter(Boolean).join(', ');
    log.warn(`Skipping session with missing required fields: ${missing}`);
    return;
  }

  const shortId = state.threadId.substring(0, 8);

  // Get platform for this session
  const platforms = ctx.state.platforms as Map<string, PlatformClient>;
  const platform = platforms.get(state.platformId);
  if (!platform) {
    log.warn(`Platform ${state.platformId} not registered, skipping resume for ${shortId}...`);
    return;
  }

  // Verify thread still exists
  const post = await platform.getPost(state.threadId);
  if (!post) {
    log.warn(`Thread ${shortId}... deleted, skipping resume`);
    ctx.state.sessionStore.remove(`${state.platformId}:${state.threadId}`);
    return;
  }

  // Check max sessions limit
  if (ctx.state.sessions.size >= ctx.config.maxSessions) {
    log.warn(`Max sessions reached, skipping resume for ${shortId}...`);
    return;
  }

  // Verify working directory exists
  if (!existsSync(state.workingDir)) {
    log.warn(`Working directory ${state.workingDir} no longer exists, skipping resume for ${shortId}...`);
    ctx.state.sessionStore.remove(`${state.platformId}:${state.threadId}`);
    const resumeFormatter = platform.getFormatter();
    // Create a temporary pseudo-session just for posting the message
    const tempSession = {
      platform,
      threadId: state.threadId,
      sessionId: `${state.platformId}:${state.threadId}`,
    } as Session;
    await withErrorHandling(
      () => postWarning(tempSession, `${resumeFormatter.formatBold('Cannot resume session')} - working directory no longer exists:\n${resumeFormatter.formatCode(state.workingDir)}\n\nPlease start a new session.`),
      { action: 'Post resume failure notification' }
    );
    return;
  }

  const platformId = state.platformId;
  const sessionId = ctx.ops.getSessionId(platformId, state.threadId);

  // Create Claude CLI with resume flag
  const skipPerms = ctx.config.skipPermissions && !state.forceInteractivePermissions;
  const platformMcpConfig = platform.getMcpConfig();

  // Include system prompt for resumed sessions (provides platform context and command info)
  const sessionContext = buildSessionContext(platform, state.workingDir);
  const appendSystemPrompt = `${sessionContext}\n\n${CHAT_PLATFORM_PROMPT}`;

  const cliOptions: ClaudeCliOptions = {
    workingDir: state.workingDir,
    threadId: state.threadId,
    skipPermissions: skipPerms,
    sessionId: state.claudeSessionId,
    resume: true,
    chrome: ctx.config.chromeEnabled,
    platformConfig: platformMcpConfig,
    appendSystemPrompt,
    logSessionId: sessionId,  // Route logs to session panel
    permissionTimeoutMs: ctx.config.permissionTimeoutMs,
  };
  const claude = new ClaudeCli(cliOptions);

  // Rebuild Session object from persisted state
  // Use defensive defaults for all fields to handle old/incomplete persisted data
  const session: Session = {
    platformId,
    threadId: state.threadId,
    sessionId,
    platform,
    claudeSessionId: state.claudeSessionId,
    startedBy: state.startedBy || 'unknown',
    startedByDisplayName: state.startedByDisplayName,
    startedAt: state.startedAt ? new Date(state.startedAt) : new Date(),
    lastActivityAt: new Date(),
    sessionNumber: state.sessionNumber ?? 1,
    workingDir: state.workingDir,
    claude,
    planApproved: state.planApproved ?? false,
    sessionAllowedUsers: new Set(state.sessionAllowedUsers || [state.startedBy].filter(Boolean)),
    forceInteractivePermissions: state.forceInteractivePermissions ?? false,
    sessionStartPostId: state.sessionStartPostId ?? null,
    tasksPostId: state.tasksPostId ?? null,
    lastTasksContent: state.lastTasksContent ?? null,
    tasksCompleted: state.tasksCompleted ?? false,
    tasksMinimized: state.tasksMinimized ?? false,
    timers: createSessionTimers(),
    lifecycle: createResumedLifecycle(state.resumeFailCount ?? 0),
    timeoutWarningPosted: false,
    inProgressTaskStart: null,
    activeToolStarts: new Map(),
    worktreeInfo: state.worktreeInfo,
    isWorktreeOwner: state.isWorktreeOwner,
    pendingWorktreePrompt: state.pendingWorktreePrompt,
    worktreePromptDisabled: state.worktreePromptDisabled,
    queuedPrompt: state.queuedPrompt,
    queuedFiles: state.queuedFiles,
    firstPrompt: state.firstPrompt,
    needsContextPromptOnNextMessage: state.needsContextPromptOnNextMessage,
    sessionTitle: state.sessionTitle,
    sessionDescription: state.sessionDescription,
    sessionTags: state.sessionTags || [],
    pullRequestUrl: state.pullRequestUrl,
    messageCount: state.messageCount ?? 0,
    isProcessing: false,  // Resumed sessions are idle until user sends a message
    lifecyclePostId: state.lifecyclePostId,  // Pass through for resume message handling
    recentEvents: [],  // Bug report context: recent tool uses/errors (cleared on resume)
    // Thread logger for persisting events to disk (appends to existing log)
    threadLogger: createThreadLogger(platformId, state.threadId, state.claudeSessionId, {
      enabled: ctx.config.threadLogsEnabled ?? true,
    }),
  };

  // Create MessageManager for this session
  session.messageManager = createMessageManager(session, ctx);

  // Hydrate MessageManager with persisted task state
  session.messageManager.hydrateTaskListState({
    tasksPostId: state.tasksPostId,
    lastTasksContent: state.lastTasksContent,
    tasksCompleted: state.tasksCompleted,
    tasksMinimized: state.tasksMinimized,
  });

  // Hydrate MessageManager with persisted interactive state (if any)
  // Note: These fields may not exist in older persisted sessions
  const persistedWithInteractive = state as PersistedSession & {
    pendingQuestionSet?: {
      toolUseId: string;
      currentIndex: number;
      currentPostId: string | null;
      questions: Array<{
        header: string;
        question: string;
        options: Array<{ label: string; description: string }>;
        answer: string | null;
      }>;
    } | null;
    pendingApproval?: {
      postId: string;
      type: 'plan' | 'action';
      toolUseId: string;
    } | null;
  };
  if (persistedWithInteractive.pendingQuestionSet || persistedWithInteractive.pendingApproval) {
    session.messageManager.hydrateInteractiveState({
      pendingQuestionSet: persistedWithInteractive.pendingQuestionSet,
      pendingApproval: persistedWithInteractive.pendingApproval,
    });
  }

  // Log session resume
  session.threadLogger?.logLifecycle('resume', {
    username: state.startedBy,
    workingDir: state.workingDir,
  });

  // Register session
  mutableSessions(ctx).set(sessionId, session);

  // Register worktree user for reference counting (if session has a worktree)
  if (session.worktreeInfo) {
    ctx.ops.registerWorktreeUser(session.worktreeInfo.worktreePath, sessionId);
  }
  if (state.sessionStartPostId) {
    ctx.ops.registerPost(state.sessionStartPostId, state.threadId);
  }
  // Register task post for reaction routing (task collapse toggle)
  if (state.tasksPostId) {
    ctx.ops.registerPost(state.tasksPostId, state.threadId);
  }
  ctx.ops.emitSessionAdd(session);

  // Notify keep-alive that a session started
  keepAlive.sessionStarted();

  // Bind event handlers (use sessionId which is the composite key)
  claude.on('event', (e: ClaudeEvent) => ctx.ops.handleEvent(sessionId, e));
  claude.on('exit', (code: number) => ctx.ops.handleExit(sessionId, code));

  try {
    claude.start();
    sessionLog(session).info(`🔄 Session resumed (@${state.startedBy})`);

    // Post or update resume message
    // If we have a lifecyclePostId, this was a timeout/shutdown - update that post
    // Otherwise create a new post (normal for old persisted sessions without lifecyclePostId)
    const sessionFormatter = session.platform.getFormatter();
    if (session.lifecyclePostId) {
      const postId = session.lifecyclePostId;
      const resumeMsg = `🔄 ${sessionFormatter.formatBold('Session resumed')} by ${sessionFormatter.formatUserMention(session.startedBy)}\n${sessionFormatter.formatItalic('Reconnected to Claude session. You can continue where you left off.')}`;
      await withErrorHandling(
        () => session.platform.updatePost(postId, resumeMsg),
        { action: 'Update timeout/shutdown post for resume', session }
      );
      // Clear the paused state since we're now active again
      session.lifecyclePostId = undefined;
      transitionTo(session, 'active');
    } else {
      // Fallback: create new post if no lifecyclePostId (e.g., old persisted sessions)
      const restartMsg = `${sessionFormatter.formatBold('Session resumed')} after bot restart (v${VERSION})\n${sessionFormatter.formatItalic('Reconnected to Claude session. You can continue where you left off.')}`;
      await postResume(session, restartMsg);
    }

    // Update session header
    await ctx.ops.updateSessionHeader(session);

    // Update sticky channel message with resumed session
    await ctx.ops.updateStickyMessage();

    // Update persistence with new activity time
    ctx.ops.persistSession(session);
  } catch (err) {
    log.error(`Failed to resume session ${shortId}`, err instanceof Error ? err : undefined);
    ctx.ops.emitSessionRemove(sessionId);
    mutableSessions(ctx).delete(sessionId);
    ctx.state.sessionStore.remove(sessionId);

    // Try to notify user
    const failFormatter = session.platform.getFormatter();
    await withErrorHandling(
      () => postWarning(session, `${failFormatter.formatBold('Could not resume previous session.')} Starting fresh.\n${failFormatter.formatItalic('Your previous conversation context is preserved, but Claude needs to re-read it.')}`),
      { action: 'Post resume failure notification', session }
    );

    // Update sticky message after session removal
    await ctx.ops.updateStickyMessage();
  }
}

// ---------------------------------------------------------------------------
// Session messaging
// ---------------------------------------------------------------------------

/**
 * Send a follow-up message to an existing session.
 */
export async function sendFollowUp(
  session: Session,
  message: string,
  files: PlatformFile[] | undefined,
  ctx: SessionContext,
  username?: string,
  displayName?: string
): Promise<void> {
  if (!session.claude.isRunning()) return;

  // Log the user message
  session.threadLogger?.logUserMessage(
    username || session.startedBy,
    message,
    displayName,
    files && files.length > 0
  );

  // Prepare MessageManager for new message (flush, reset, bump task list)
  await session.messageManager?.prepareForUserMessage();

  const content = await ctx.ops.buildMessageContent(message, session.platform, files);
  const messageText = typeof content === 'string' ? content : message;

  // Check if we need to offer context prompt (e.g., after !cd)
  if (session.needsContextPromptOnNextMessage) {
    session.needsContextPromptOnNextMessage = false;
    const contextOffered = await ctx.ops.offerContextPrompt(session, messageText, files);
    if (contextOffered) {
      // Context prompt was posted, message is queued - don't send directly
      session.lastActivityAt = new Date();
      return;
    }
    // No thread history or context prompt declined, fall through to send directly
  }

  // Increment message counter
  session.messageCount++;

  // Inject metadata reminder periodically (also fires re-classification)
  const messageToSend = typeof content === 'string'
    ? maybeInjectMetadataReminder(content, session, ctx, session)
    : content;

  // Mark as processing and update UI
  session.isProcessing = true;
  ctx.ops.emitSessionUpdate(session.sessionId, { status: getSessionStatus(session) });

  session.claude.sendMessage(messageToSend);
  session.lastActivityAt = new Date();
  ctx.ops.startTyping(session);
}

/**
 * Resume a paused session and send a message to it.
 */
export async function resumePausedSession(
  threadId: string,
  message: string,
  files: PlatformFile[] | undefined,
  ctx: SessionContext
): Promise<void> {
  // Find persisted session by raw threadId
  const persisted = ctx.state.sessionStore.load();
  const state = findPersistedByThreadId(persisted, threadId);
  if (!state) {
    log.debug(`No persisted session found for ${threadId.substring(0, 8)}...`);
    return;
  }

  const shortId = threadId.substring(0, 8);
  log.info(`🔄 Resuming paused session ${shortId}... for new message`);

  // Resume the session
  await resumeSession(state, ctx);

  // Wait a moment for the session to be ready, then send the message
  const session = ctx.ops.findSessionByThreadId(threadId);
  if (session && session.claude.isRunning()) {
    // Increment message counter
    session.messageCount++;

    const content = await ctx.ops.buildMessageContent(message, session.platform, files);

    // Inject metadata reminder periodically (also fires re-classification)
    const messageToSend = typeof content === 'string'
      ? maybeInjectMetadataReminder(content, session, ctx, session)
      : content;

    session.claude.sendMessage(messageToSend);
    session.lastActivityAt = new Date();
    ctx.ops.startTyping(session);
  } else {
    log.warn(`Failed to resume session ${shortId}..., could not send message`);
  }
}

// ---------------------------------------------------------------------------
// Session termination
// ---------------------------------------------------------------------------

/**
 * Handle Claude CLI exit event.
 */
export async function handleExit(
  sessionId: string,
  code: number,
  ctx: SessionContext
): Promise<void> {
  const session = mutableSessions(ctx).get(sessionId);
  const shortId = sessionId.substring(0, 8);

  sessionLog(session).debug(`handleExit called code=${code} isShuttingDown=${ctx.state.isShuttingDown}`);

  if (!session) {
    log.debug(`Session ${shortId}... not found (already cleaned up)`);
    return;
  }

  // If we're intentionally restarting (e.g., !cd), don't clean up
  if (isSessionRestarting(session)) {
    sessionLog(session).debug(`Restarting, skipping cleanup`);
    transitionTo(session, 'active');
    return;
  }

  // If session was cancelled (via !stop or ❌), don't clean up or re-persist
  // The killSession function handles all cleanup - we just exit early here
  if (isSessionCancelled(session)) {
    sessionLog(session).debug(`Cancelled, skipping cleanup (handled by killSession)`);
    return;
  }

  // If bot is shutting down, preserve persistence
  if (ctx.state.isShuttingDown) {
    sessionLog(session).debug(`Bot shutting down, preserving persistence`);
    ctx.ops.stopTyping(session);
    cleanupSessionTimers(session);
    await closeThreadLogger(session, 'exit', { reason: 'shutdown', exitCode: code });
    ctx.ops.emitSessionRemove(session.sessionId);
    mutableSessions(ctx).delete(session.sessionId);
    // Notify keep-alive that a session ended
    keepAlive.sessionEnded();
    return;
  }

  // If session was interrupted, preserve for resume (only if Claude has responded)
  if (session.lifecycle.state === 'interrupted') {
    sessionLog(session).debug(`Exited after interrupt, preserving for resume`);
    ctx.ops.stopTyping(session);
    cleanupSessionTimers(session);
    await closeThreadLogger(session, 'interrupt', { exitCode: code });

    // Notify user first, then persist with the lifecyclePostId
    // This ensures the session won't auto-resume on bot restart
    const message = session.lifecycle.hasClaudeResponded
      ? `ℹ️ Session paused. Send a new message to continue.`
      : `ℹ️ Session ended before Claude could respond. Send a new message to start fresh.`;
    const pausePost = await withErrorHandling(
      () => postInfo(session, message),
      { action: 'Post session pause notification', session }
    );

    // Only persist if Claude actually responded (otherwise there's nothing to resume)
    if (session.lifecycle.hasClaudeResponded) {
      // Mark as paused so it won't auto-resume on bot restart
      transitionTo(session, 'paused');
      if (pausePost) {
        session.lifecyclePostId = pausePost.id;
        ctx.ops.registerPost(pausePost.id, session.threadId);
      }
      ctx.ops.persistSession(session);
    }
    ctx.ops.emitSessionRemove(session.sessionId);
    mutableSessions(ctx).delete(session.sessionId);
    cleanupPostIndex(ctx, session.threadId);
    // Notify keep-alive that a session ended
    keepAlive.sessionEnded();
    sessionLog(session).info(`⏸ Session paused`);
    // Update sticky channel message after session pause
    await ctx.ops.updateStickyMessage();
    return;
  }

  // If session exits before Claude responded, notify user (no point trying to resume)
  const wasResumed = session.lifecycle.resumeFailCount > 0 || session.lifecycle.state !== 'starting';
  if (!session.lifecycle.hasClaudeResponded && !wasResumed) {
    sessionLog(session).debug(`Exited before Claude responded, not persisting`);
    ctx.ops.stopTyping(session);
    cleanupSessionTimers(session);
    await closeThreadLogger(session, 'exit', { reason: 'early_exit', exitCode: code });
    ctx.ops.emitSessionRemove(session.sessionId);
    mutableSessions(ctx).delete(session.sessionId);
    cleanupPostIndex(ctx, session.threadId);
    keepAlive.sessionEnded();
    // Notify user
    const earlyExitFormatter = session.platform.getFormatter();
    await withErrorHandling(
      () => postWarning(session, `${earlyExitFormatter.formatBold('Session ended')} before Claude could respond (exit code ${code}). Please start a new session.`),
      { action: 'Post early exit notification', session }
    );
    sessionLog(session).info(`⚠ Session ended early (exit code ${code})`);
    await ctx.ops.updateStickyMessage();
    return;
  }

  // For resumed sessions that exit with error, track failures and give up after too many
  if (wasResumed && code !== 0) {
    const MAX_RESUME_FAILURES = 3;
    session.lifecycle.resumeFailCount = (session.lifecycle.resumeFailCount || 0) + 1;

    // Check if this is a permanent failure that shouldn't be retried
    const isPermanent = session.claude.isPermanentFailure();
    const permanentReason = session.claude.getPermanentFailureReason();

    sessionLog(session).debug(`Resumed session failed with code ${code}, attempt ${session.lifecycle.resumeFailCount}/${MAX_RESUME_FAILURES}, permanent=${isPermanent}`);
    ctx.ops.stopTyping(session);
    cleanupSessionTimers(session);
    ctx.ops.emitSessionRemove(session.sessionId);
    mutableSessions(ctx).delete(session.sessionId);
    // Notify keep-alive that a session ended
    keepAlive.sessionEnded();

    // Immediately give up on permanent failures
    const resumeFailFormatter = session.platform.getFormatter();
    if (isPermanent) {
      sessionLog(session).warn(`Detected permanent failure, removing from persistence: ${permanentReason}`);
      // Unregister from worktree but don't cleanup - user may want to recover work
      // Orphan cleanup will handle it after 24h
      if (session.worktreeInfo) {
        ctx.ops.unregisterWorktreeUser(session.worktreeInfo.worktreePath, session.sessionId);
      }
      ctx.ops.unpersistSession(session.sessionId);
      await withErrorHandling(
        () => postError(session, `${resumeFailFormatter.formatBold('Session cannot be resumed')} — ${permanentReason}\n\nPlease start a new session.`),
        { action: 'Post session permanent failure', session }
      );
      await ctx.ops.updateStickyMessage();
      return;
    }

    if (session.lifecycle.resumeFailCount >= MAX_RESUME_FAILURES) {
      // Too many failures - give up and delete from persistence
      sessionLog(session).warn(`Exceeded ${MAX_RESUME_FAILURES} resume failures, removing from persistence`);
      // Unregister from worktree but don't cleanup - user may want to recover work
      // Orphan cleanup will handle it after 24h
      if (session.worktreeInfo) {
        ctx.ops.unregisterWorktreeUser(session.worktreeInfo.worktreePath, session.sessionId);
      }
      ctx.ops.unpersistSession(session.sessionId);
      await withErrorHandling(
        () => postError(session, `${resumeFailFormatter.formatBold('Session permanently failed')} after ${MAX_RESUME_FAILURES} resume attempts (exit code ${code}). Session data has been removed. Please start a new session.`),
        { action: 'Post session permanent failure', session }
      );
    } else {
      // Still have retries left - persist with updated fail count
      ctx.ops.persistSession(session);
      await withErrorHandling(
        () => postWarning(session, `${resumeFailFormatter.formatBold('Session resume failed')} (exit code ${code}, attempt ${session.lifecycle.resumeFailCount}/${MAX_RESUME_FAILURES}). Will retry on next bot restart.`),
        { action: 'Post session resume failure', session }
      );
    }

    // Update sticky channel message after session failure
    await ctx.ops.updateStickyMessage();
    return;
  }

  // Normal exit cleanup
  sessionLog(session).debug(`Normal exit, cleaning up`);

  ctx.ops.stopTyping(session);
  cleanupSessionTimers(session);
  await closeThreadLogger(session, 'exit', { exitCode: code });

  // Unpin task post on session exit
  if (session.tasksPostId) {
    await session.platform.unpinPost(session.tasksPostId).catch(() => {});
  }

  await ctx.ops.flush(session);

  if (code !== 0 && code !== null) {
    const exitFormatter = session.platform.getFormatter();
    await postInfo(session, exitFormatter.formatBold(`[Exited: ${code}]`));
  }

  // Unregister from worktree reference counting, but DON'T cleanup automatically
  // Worktrees are preserved for potential reuse - cleanup happens via:
  // - !worktree cleanup command (manual)
  // - Orphan cleanup on startup (worktrees > 24h old with no session)
  if (session.worktreeInfo) {
    ctx.ops.unregisterWorktreeUser(session.worktreeInfo.worktreePath, session.sessionId);
  }

  // Clean up session from maps
  ctx.ops.emitSessionRemove(session.sessionId);
  mutableSessions(ctx).delete(session.sessionId);
  cleanupPostIndex(ctx, session.threadId);

  // Notify keep-alive that a session ended
  keepAlive.sessionEnded();

  // Only unpersist for normal exits
  if (code === 0 || code === null) {
    ctx.ops.unpersistSession(session.sessionId);
  } else {
    sessionLog(session).debug(`Non-zero exit, preserving for potential retry`);
  }

  sessionLog(session).info(`■ Session ended`);

  // Update sticky channel message after session end
  await ctx.ops.updateStickyMessage();
}

/**
 * Kill a specific session.
 */
export async function killSession(
  session: Session,
  unpersist: boolean,
  ctx: SessionContext
): Promise<void> {
  // Set restarting state to prevent handleExit from also unpersisting
  if (!unpersist) {
    transitionTo(session, 'restarting');
  }

  ctx.ops.stopTyping(session);
  await closeThreadLogger(session, 'kill', { unpersist });
  session.claude.kill();

  // Unpin task post on session kill
  if (session.tasksPostId) {
    await session.platform.unpinPost(session.tasksPostId).catch(() => {});
  }

  // Unregister from worktree reference counting, but DON'T cleanup automatically
  // Worktrees are preserved for potential reuse - cleanup via !worktree cleanup or orphan cleanup
  if (unpersist && session.worktreeInfo) {
    ctx.ops.unregisterWorktreeUser(session.worktreeInfo.worktreePath, session.sessionId);
  }

  // Clean up session from maps
  ctx.ops.emitSessionRemove(session.sessionId);
  mutableSessions(ctx).delete(session.sessionId);
  cleanupPostIndex(ctx, session.threadId);

  // Notify keep-alive that a session ended
  keepAlive.sessionEnded();

  // Explicitly unpersist if requested
  if (unpersist) {
    ctx.ops.unpersistSession(session.sessionId);
  }

  sessionLog(session).info(`✖ Session killed`);

  // Update sticky channel message after session kill
  await ctx.ops.updateStickyMessage();
}

/**
 * Kill all active sessions.
 * If isShuttingDown is true, persists sessions before killing so they can resume on restart.
 * Returns a Promise that resolves when all processes have exited.
 */
export async function killAllSessions(ctx: SessionContext): Promise<void> {
  const killPromises: Promise<void>[] = [];

  for (const session of ctx.state.sessions.values()) {
    ctx.ops.stopTyping(session);
    // Persist session state before killing if we're shutting down gracefully
    if (ctx.state.isShuttingDown) {
      ctx.ops.persistSession(session);
    }
    killPromises.push(session.claude.kill());
  }

  // Wait for all processes to exit
  await Promise.all(killPromises);

  mutableSessions(ctx).clear();
  mutablePostIndex(ctx).clear();

  // Force stop keep-alive
  keepAlive.forceStop();
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Clean up idle sessions that have timed out.
 */
export async function cleanupIdleSessions(
  timeoutMs: number,
  warningMs: number,
  ctx: SessionContext
): Promise<void> {
  const now = Date.now();

  for (const [_sessionId, session] of ctx.state.sessions) {
    const idleMs = now - session.lastActivityAt.getTime();

    // Check for timeout
    if (idleMs > timeoutMs) {
      sessionLog(session).info(`⏰ Session timed out after ${Math.round(idleMs / 60000)}min idle`);

      const timeoutFormatter = session.platform.getFormatter();
      const timeoutMessage = `${timeoutFormatter.formatBold('Session timed out')} after ${Math.round(idleMs / 60000)} minutes of inactivity\n\n💡 React with 🔄 to resume, or send a new message to continue.`;

      // Update existing warning post or create a new one
      if (session.lifecyclePostId) {
        // Update the existing warning post to show timeout
        const postId = session.lifecyclePostId;
        await withErrorHandling(
          () => session.platform.updatePost(postId, `⏱️ ${timeoutMessage}`),
          { action: 'Update timeout post', session }
        );
      } else {
        // Create new timeout post (no warning was posted)
        const timeoutPost = await withErrorHandling(
          () => postTimeout(session, timeoutMessage),
          { action: 'Post session timeout', session }
        );
        if (timeoutPost) {
          session.lifecyclePostId = timeoutPost.id;
          ctx.ops.registerPost(timeoutPost.id, session.threadId);
        }
      }
      // Mark as paused so it won't auto-resume on bot restart
      transitionTo(session, 'paused');
      ctx.ops.persistSession(session);

      // Kill without unpersisting to allow resume
      await killSession(session, false, ctx);
      continue;
    }

    // Check for warning threshold (warn when X minutes before timeout)
    // warningMs = how long before timeout to warn (e.g., 5 min = 300000)
    // So warn when: idleMs > (timeoutMs - warningMs)
    const warningThresholdMs = timeoutMs - warningMs;
    if (idleMs > warningThresholdMs && !session.timeoutWarningPosted) {
      const remainingMins = Math.max(0, Math.round((timeoutMs - idleMs) / 60000));
      const warningFormatter = session.platform.getFormatter();
      const warningMessage = `${warningFormatter.formatBold('Session idle')} - will timeout in ~${remainingMins} minutes without activity`;

      // Create the warning post and store its ID for later updates
      const warningPost = await withErrorHandling(
        () => postTimeout(session, warningMessage),
        { action: 'Post timeout warning', session }
      );
      if (warningPost) {
        session.lifecyclePostId = warningPost.id;
        ctx.ops.registerPost(warningPost.id, session.threadId);
      }
      session.timeoutWarningPosted = true;
      sessionLog(session).debug(`⏰ Idle warning posted`);
    }
  }
}
