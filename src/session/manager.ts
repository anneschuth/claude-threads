/**
 * SessionManager - Orchestrates Claude Code sessions across chat platforms
 *
 * This is the main coordinator that delegates to specialized modules:
 * - lifecycle.ts: Session start, resume, exit
 * - streaming.ts: Message streaming and flushing
 * - operations/events: Claude event handling
 * - operations/commands: User commands (!cd, !invite, etc.)
 * - operations/worktree: Git worktree management
 *
 * User reactions are handled via MessageManager.handleReaction() which routes
 * to the appropriate executor (QuestionApprovalExecutor, TaskListExecutor, etc.)
 */

import { EventEmitter } from 'events';
import { ClaudeEvent } from '../claude/cli.js';
import type { PlatformClient, PlatformUser, PlatformPost, PlatformFile } from '../platform/index.js';
import { SessionStore, PersistedSession, PersistedContextPrompt } from '../persistence/session-store.js';
import { WorktreeMode, type LimitsConfig, resolveLimits } from '../config.js';
import type { SessionInfo } from '../ui/types.js';
import {
  isCancelEmoji,
  isEscapeEmoji,
  isResumeEmoji,
  getNumberEmojiIndex,
  isBugReportEmoji,
} from '../utils/emoji.js';
import { normalizeEmojiName } from '../platform/utils.js';
import { CleanupScheduler } from '../cleanup/index.js';
import { SessionMonitor } from '../operations/monitor/index.js';

// Import extracted modules
import * as streaming from '../operations/streaming/index.js';
import * as events from '../operations/events/index.js';
import * as commands from '../operations/commands/index.js';
import * as lifecycle from './lifecycle.js';
import { CHAT_PLATFORM_PROMPT } from './lifecycle.js';
import * as worktreeModule from '../operations/worktree/index.js';
import * as contextPrompt from '../operations/context-prompt/index.js';
import * as stickyMessage from '../operations/sticky-message/index.js';
import type { Session } from './types.js';
import { SessionRegistry } from './registry.js';
import { post } from '../operations/post-helpers/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('manager');

// Import unified context
import {
  type SessionContext,
  type SessionConfig,
  type SessionState,
  type SessionOperations,
  createSessionContext,
} from '../operations/session-context/index.js';

// Import constants for internal use
import { getSessionStatus } from './types.js';

/**
 * SessionManager - Main orchestrator for Claude Code sessions
 *
 * Emits events:
 * - 'session:add' (session: SessionInfo) - New session started
 * - 'session:update' (sessionId: string, updates: Partial<SessionInfo>) - Session state changed
 * - 'session:remove' (sessionId: string) - Session ended
 */
export class SessionManager extends EventEmitter {
  // Platform management
  private platforms: Map<string, PlatformClient> = new Map();
  private workingDir: string;
  private skipPermissions: boolean;
  private chromeEnabled: boolean;
  private worktreeMode: WorktreeMode;
  private threadLogsEnabled: boolean;
  private threadLogsRetentionDays: number;
  // Resolved limits configuration
  private readonly limits: Required<LimitsConfig>;
  // Debug is a getter so it reads current process.env.DEBUG (can be toggled at runtime)
  private get debug(): boolean {
    return process.env.DEBUG === '1' || process.argv.includes('--debug');
  }

  // Session registry - tracks active sessions and post mappings
  public readonly registry!: SessionRegistry;

  // Worktree reference counting
  // Key: worktreePath, Value: Set of sessionIds using that worktree
  private worktreeUsers: Map<string, Set<string>> = new Map();

  // Persistence (accessed via registry.getSessionStore())
  private sessionStore!: SessionStore;

  // Background tasks
  private sessionMonitor: SessionMonitor | null = null;       // Idle timeout + sticky refresh (1 min)
  private backgroundCleanup: CleanupScheduler | null = null;  // Logs + worktrees cleanup (1 hour)

  // Shutdown flag
  private isShuttingDown = false;

  // Auto-update manager (set via setAutoUpdateManager)
  private autoUpdateManager: commands.AutoUpdateManagerInterface | null = null;

  constructor(
    workingDir: string,
    skipPermissions = false,
    chromeEnabled = false,
    worktreeMode: WorktreeMode = 'prompt',
    sessionsPath?: string,
    threadLogsEnabled = true,
    threadLogsRetentionDays = 30,
    limits?: LimitsConfig
  ) {
    super();
    this.workingDir = workingDir;
    this.skipPermissions = skipPermissions;
    this.chromeEnabled = chromeEnabled;
    this.worktreeMode = worktreeMode;
    this.threadLogsEnabled = threadLogsEnabled;
    this.threadLogsRetentionDays = threadLogsRetentionDays;
    this.limits = resolveLimits(limits);
    this.sessionStore = new SessionStore(sessionsPath);
    this.registry = new SessionRegistry(this.sessionStore);

    // Create background tasks (started in initialize())
    this.sessionMonitor = new SessionMonitor({
      sessionTimeoutMs: this.limits.sessionTimeoutMinutes * 60 * 1000,
      sessionWarningMs: this.limits.sessionWarningMinutes * 60 * 1000,
      getContext: () => this.getContext(),
      getSessionCount: () => this.registry.size,
      updateStickyMessage: () => this.updateStickyMessage(),
    });

    this.backgroundCleanup = new CleanupScheduler({
      sessionStore: this.sessionStore,
      threadLogsEnabled: this.threadLogsEnabled,
      logRetentionDays: this.threadLogsRetentionDays,
      intervalMs: this.limits.cleanupIntervalMinutes * 60 * 1000,
      maxWorktreeAgeMs: this.limits.maxWorktreeAgeHours * 60 * 60 * 1000,
      cleanupWorktrees: this.limits.cleanupWorktrees,
    });
  }

  // ---------------------------------------------------------------------------
  // Platform Management
  // ---------------------------------------------------------------------------

  addPlatform(platformId: string, client: PlatformClient): void {
    this.platforms.set(platformId, client);
    client.on('message', (post, user) => this.handleMessage(platformId, post, user));
    client.on('reaction', (reaction, user) => {
      if (user) {
        this.handleReaction(platformId, reaction.postId, reaction.emojiName, user.username, 'added');
      }
    });
    client.on('reaction_removed', (reaction, user) => {
      if (user) {
        this.handleReaction(platformId, reaction.postId, reaction.emojiName, user.username, 'removed');
      }
    });
    // Bump sticky message to bottom when someone posts in the channel
    client.on('channel_post', () => {
      stickyMessage.markNeedsBump(platformId);
      this.updateStickyMessage();
    });
    log.info(`📡 Platform "${platformId}" registered`);
  }

  removePlatform(platformId: string): void {
    this.platforms.delete(platformId);
  }

  /**
   * Set the auto-update manager for update commands.
   */
  setAutoUpdateManager(manager: typeof this.autoUpdateManager): void {
    this.autoUpdateManager = manager;
  }

  // ---------------------------------------------------------------------------
  // Worktree Reference Counting
  // ---------------------------------------------------------------------------

  /**
   * Register a session as using a worktree.
   * Called when a session creates or joins a worktree.
   */
  private registerWorktreeUser(worktreePath: string, sessionId: string): void {
    if (!this.worktreeUsers.has(worktreePath)) {
      this.worktreeUsers.set(worktreePath, new Set());
    }
    const users = this.worktreeUsers.get(worktreePath);
    if (users) {
      users.add(sessionId);
    }
    log.debug(`Registered session ${sessionId.substring(0, 20)} as worktree user for ${worktreePath}`);
  }

  /**
   * Unregister a session from using a worktree.
   * Called when a session ends or switches worktrees.
   */
  private unregisterWorktreeUser(worktreePath: string, sessionId: string): void {
    const users = this.worktreeUsers.get(worktreePath);
    if (users) {
      users.delete(sessionId);
      if (users.size === 0) {
        this.worktreeUsers.delete(worktreePath);
      }
    }
  }

  /**
   * Check if other sessions are using a worktree (besides the given session).
   * Used by cleanupWorktree to determine if safe to delete.
   */
  hasOtherSessionsUsingWorktree(worktreePath: string, excludeSessionId: string): boolean {
    const users = this.worktreeUsers.get(worktreePath);
    if (!users) return false;
    // Check if any session other than excludeSessionId is using this worktree
    return Array.from(users).some(id => id !== excludeSessionId);
  }

  // ---------------------------------------------------------------------------
  // Unified Context Builder
  // ---------------------------------------------------------------------------

  /**
   * Build the unified SessionContext that all modules receive.
   * This replaces the previous 4 separate context builders.
   *
   * Made public to allow direct access from message-handler.ts,
   * enabling elimination of thin wrapper methods.
   */
  getContext(): SessionContext {
    const config: SessionConfig = {
      workingDir: this.workingDir,
      skipPermissions: this.skipPermissions,
      chromeEnabled: this.chromeEnabled,
      debug: this.debug,
      maxSessions: this.limits.maxSessions,
      threadLogsEnabled: this.threadLogsEnabled,
      threadLogsRetentionDays: this.threadLogsRetentionDays,
      permissionTimeoutMs: this.limits.permissionTimeoutSeconds * 1000,
    };

    const state: SessionState = {
      sessions: this.registry.getSessions(),
      postIndex: this.registry.getPostIndex(),
      platforms: this.platforms,
      sessionStore: this.sessionStore,
      isShuttingDown: this.isShuttingDown,
    };

    const ops: SessionOperations = {
      // Session lookup
      getSessionId: (pid, tid) => this.getSessionId(pid, tid),
      findSessionByThreadId: (tid) => this.findSessionByThreadId(tid),

      // Post management
      registerPost: (pid, tid) => this.registerPost(pid, tid),

      // Streaming & content (inlined - no wrapper methods needed)
      flush: async (s) => {
        // Delegate to MessageManager (source of truth for content flushing)
        if (s.messageManager) {
          await s.messageManager.flush();
        }
      },
      startTyping: (s) => this.startTyping(s),
      stopTyping: (s) => this.stopTyping(s),
      buildMessageContent: (t, p, f) => streaming.buildMessageContent(t, p, f, this.debug),
      bumpTasksToBottom: (s) => streaming.bumpTasksToBottom(s),

      // Persistence
      persistSession: (s) => this.persistSession(s),
      unpersistSession: (sid) => this.unpersistSession(sid),

      // UI updates
      updateSessionHeader: (s) => this.updateSessionHeader(s),
      updateStickyMessage: () => this.updateStickyMessage(),

      // Event handling
      handleEvent: (sid, e) => this.handleEvent(sid, e),
      handleExit: (sid, code) => this.handleExit(sid, code),

      // Session lifecycle
      killSession: (tid) => this.killSession(tid),

      // Worktree
      shouldPromptForWorktree: (s) => this.shouldPromptForWorktree(s),
      postWorktreePrompt: (s, r) => this.postWorktreePrompt(s, r),
      registerWorktreeUser: (path, sid) => this.registerWorktreeUser(path, sid),
      unregisterWorktreeUser: (path, sid) => this.unregisterWorktreeUser(path, sid),
      hasOtherSessionsUsingWorktree: (path, sid) => this.hasOtherSessionsUsingWorktree(path, sid),
      switchToWorktree: (tid, path, user) => this.switchToWorktree(tid, path, user),

      // Update operations
      forceUpdate: () => this.autoUpdateManager?.forceUpdate() ?? Promise.resolve(),
      deferUpdate: (min) => this.autoUpdateManager?.deferUpdate(min),

      // Bug report operations
      handleBugReportApproval: (s, approved, user) => commands.handleBugReportApproval(s, approved, user),

      // Context prompt (inlined - no wrapper method needed)
      offerContextPrompt: (s, q, f, e) => contextPrompt.offerContextPrompt(s, q, f, this.getContextPromptHandler(), e),

      // UI event emission
      emitSessionAdd: (s) => this.emitSessionAdd(s),
      emitSessionUpdate: (sid, u) => this.emitSessionUpdate(sid, u),
      emitSessionRemove: (sid) => this.emitSessionRemove(sid),
    };

    return createSessionContext(config, state, ops);
  }

  // ---------------------------------------------------------------------------
  // Session ID and Post Index
  // ---------------------------------------------------------------------------

  private getSessionId(platformId: string, threadId: string): string {
    return `${platformId}:${threadId}`;
  }

  // ---------------------------------------------------------------------------
  // UI Event Emission
  // ---------------------------------------------------------------------------

  /**
   * Convert internal Session to SessionInfo for UI.
   */
  private toSessionInfo(session: Session): SessionInfo {
    return {
      id: session.sessionId,
      threadId: session.threadId,
      startedBy: session.startedBy,
      displayName: session.startedByDisplayName,
      status: getSessionStatus(session),
      workingDir: session.workingDir,
      sessionNumber: session.sessionNumber,
      worktreeBranch: session.worktreeInfo?.branch,
      // Platform information
      platformType: session.platform.platformType as 'mattermost' | 'slack',
      platformDisplayName: session.platform.displayName,
      // Rich metadata
      title: session.sessionTitle,
      description: session.sessionDescription,
      lastActivity: session.lastActivityAt,
      // Typing indicator state
      isTyping: session.timers.typingTimer !== null,
    };
  }

  /**
   * Emit session:add event with session info for UI.
   */
  emitSessionAdd(session: Session): void {
    this.emit('session:add', this.toSessionInfo(session));
  }

  /**
   * Emit session:update event with partial updates for UI.
   */
  emitSessionUpdate(sessionId: string, updates: Partial<SessionInfo>): void {
    this.emit('session:update', sessionId, updates);
  }

  /**
   * Emit session:remove event for UI.
   */
  emitSessionRemove(sessionId: string): void {
    this.emit('session:remove', sessionId);
  }

  private registerPost(postId: string, threadId: string): void {
    this.registry.registerPost(postId, threadId);
  }

  private getSessionByPost(postId: string): Session | undefined {
    return this.registry.findByPost(postId);
  }

  // ---------------------------------------------------------------------------
  // Message Handling
  // ---------------------------------------------------------------------------

  private async handleMessage(_platformId: string, _post: PlatformPost, _user: PlatformUser | null): Promise<void> {
    // Message handling is done by the platform client routing to startSession/sendFollowUp
    // This is just a placeholder for the event subscription
  }

  // ---------------------------------------------------------------------------
  // Reaction Handling
  // ---------------------------------------------------------------------------

  private async handleReaction(
    platformId: string,
    postId: string,
    emojiName: string,
    username: string,
    action: 'added' | 'removed'
  ): Promise<void> {
    // Normalize emoji name to handle platform differences (e.g., Slack's "thumbsup" vs Mattermost's "+1")
    const normalizedEmoji = normalizeEmojiName(emojiName);

    // First, check if this is a resume emoji for a timed-out session (only on add)
    if (action === 'added' && isResumeEmoji(normalizedEmoji)) {
      const resumed = await this.tryResumeFromReaction(platformId, postId, username);
      if (resumed) return;
    }

    const session = this.getSessionByPost(postId);
    if (!session) return;

    // Verify this reaction is from the same platform
    if (session.platformId !== platformId) return;

    // Only process reactions from allowed users
    if (!session.sessionAllowedUsers.has(username) && !session.platform.isUserAllowed(username)) {
      return;
    }

    await this.handleSessionReaction(session, postId, normalizedEmoji, username, action);
  }

  /**
   * Try to resume a timed-out session via emoji reaction on timeout post or session header.
   * Returns true if a session was resumed, false otherwise.
   */
  private async tryResumeFromReaction(platformId: string, postId: string, username: string): Promise<boolean> {
    // Find a persisted session by the post ID (timeout post or session header)
    const persistedSession = this.sessionStore.findByPostId(platformId, postId);
    if (!persistedSession) return false;

    // Check if this session is already active
    const sessionId = `${platformId}:${persistedSession.threadId}`;
    if (this.registry.hasById(sessionId)) return false;

    // Check if user is allowed (defensive: handle missing sessionAllowedUsers)
    const allowedUsers = new Set(persistedSession.sessionAllowedUsers || []);
    const platform = this.platforms.get(platformId);
    if (!allowedUsers.has(username) && !platform?.isUserAllowed(username)) {
      if (platform) {
        await platform.createPost(
          `⚠️ @${username} is not authorized to resume this session`,
          persistedSession.threadId
        );
      }
      return false;
    }

    // Check max sessions limit
    if (this.registry.size >= this.limits.maxSessions) {
      if (platform) {
        const fmt = platform.getFormatter();
        await platform.createPost(
          `⚠️ ${fmt.formatBold('Too busy')} - ${this.registry.size} sessions active. Please try again later.`,
          persistedSession.threadId
        );
      }
      return false;
    }

    const shortId = persistedSession.threadId.substring(0, 8);
    log.info(`🔄 Resuming session ${shortId}... via emoji reaction by @${username}`);

    // Resume the session
    await lifecycle.resumeSession(persistedSession, this.getContext());
    return true;
  }

  private async handleSessionReaction(
    session: Session,
    postId: string,
    emojiName: string,
    username: string,
    action: 'added' | 'removed'
  ): Promise<void> {
    // =========================================================================
    // Session-level reactions (lifecycle, worktrees, updates, bug reports)
    // These are NOT handled by MessageManager and must stay in SessionManager
    // =========================================================================

    if (action === 'added') {
      // Handle cancel/escape reactions on session start post
      if (session.sessionStartPostId === postId) {
        if (isCancelEmoji(emojiName)) {
          await commands.cancelSession(session, username, this.getContext());
          return;
        }
        if (isEscapeEmoji(emojiName)) {
          await commands.interruptSession(session, username);
          return;
        }
      }

      // Handle ❌ on worktree prompt
      if (session.worktreePromptPostId === postId && emojiName === 'x') {
        await worktreeModule.handleWorktreeSkip(
          session,
          username,
          (s) => this.persistSession(s),
          (s, q) => contextPrompt.offerContextPrompt(s, q, undefined, this.getContextPromptHandler())
        );
        return;
      }

      // Handle number emoji on worktree prompt (branch suggestion selection)
      if (session.pendingWorktreeSuggestions?.postId === postId) {
        const emojiIndex = getNumberEmojiIndex(emojiName);
        if (emojiIndex >= 0) {
          const handled = await worktreeModule.handleBranchSuggestionReaction(
            session,
            postId,
            emojiIndex,
            username,
            (tid, branch, user) => this.createAndSwitchToWorktree(tid, branch, user)
          );
          if (handled) return;
        }
      }

      // Handle bug report emoji reaction on error posts
      // (Inlined from reactions.handleBugReportReaction to eliminate dependency)
      if (session.lastError?.postId === postId && isBugReportEmoji(emojiName)) {
        // Only session owner or allowed users can report bugs
        if (session.startedBy === username ||
            session.platform.isUserAllowed(username) ||
            session.sessionAllowedUsers.has(username)) {
          log.info(`🐛 @${username} triggered bug report from error reaction`);
          await commands.reportBug(session, undefined, username, this.getContext(), session.lastError);
          return;
        }
      }
    }

    // =========================================================================
    // MessageManager-delegated reactions (questions, approvals, toggles, etc.)
    // These are routed through MessageManager.handleReaction()
    // =========================================================================

    if (session.messageManager) {
      const handled = await session.messageManager.handleReaction(postId, emojiName, username, action);
      if (handled) return;
    }
  }

  // ---------------------------------------------------------------------------
  // Context Prompt Handling
  // ---------------------------------------------------------------------------

  private getContextPromptHandler(): contextPrompt.ContextPromptHandler {
    return {
      registerPost: (pid, tid) => this.registerPost(pid, tid),
      startTyping: (s) => this.startTyping(s),
      persistSession: (s) => this.persistSession(s),
      injectMetadataReminder: (msg, session) => lifecycle.maybeInjectMetadataReminder(msg, session),
      buildMessageContent: (text, session, files) => streaming.buildMessageContent(text, session.platform, files, this.debug),
    };
  }

  // Note: offerContextPrompt() has been inlined directly in getContext().ops

  /**
   * Check if session has a pending context prompt.
   */
  hasPendingContextPrompt(threadId: string): boolean {
    const session = this.findSessionByThreadId(threadId);
    return session?.messageManager?.hasPendingContextPrompt() ?? false;
  }

  // ---------------------------------------------------------------------------
  // Event Handling (delegates to MessageManager)
  // ---------------------------------------------------------------------------

  private handleEvent(sessionId: string, event: ClaudeEvent): void {
    const session = this.registry.get(sessionId);
    if (!session || !session.messageManager) return;

    // Pre-processing: session-specific side effects
    events.handleEventPreProcessing(session, event, this.getContext());

    // Main event handling via MessageManager
    void session.messageManager.handleEvent(event);

    // Post-processing: session-specific side effects
    events.handleEventPostProcessing(session, event, this.getContext());
  }

  // ---------------------------------------------------------------------------
  // Exit Handling (delegates to lifecycle module)
  // ---------------------------------------------------------------------------

  private async handleExit(sessionId: string, code: number): Promise<void> {
    await lifecycle.handleExit(sessionId, code, this.getContext());
  }

  // ---------------------------------------------------------------------------
  // Streaming utilities
  // ---------------------------------------------------------------------------
  // Note: flush(), buildMessageContent(), and bumpTasksToBottom() have been
  // inlined directly in getContext().ops to eliminate thin wrapper methods.
  // Only startTyping() and stopTyping() remain as they have meaningful UI logic.

  private startTyping(session: Session): void {
    const wasTyping = session.timers.typingTimer !== null;
    streaming.startTyping(session);
    // Emit UI update if typing state changed
    if (!wasTyping && session.timers.typingTimer !== null) {
      this.emitSessionUpdate(session.sessionId, { isTyping: true });
    }
  }

  private stopTyping(session: Session): void {
    const wasTyping = session.timers.typingTimer !== null;
    streaming.stopTyping(session);
    // Emit UI update if typing state changed
    if (wasTyping && session.timers.typingTimer === null) {
      this.emitSessionUpdate(session.sessionId, { isTyping: false });
    }
  }

  // ---------------------------------------------------------------------------
  // Worktree utilities
  // ---------------------------------------------------------------------------

  private async shouldPromptForWorktree(session: Session): Promise<string | null> {
    return worktreeModule.shouldPromptForWorktree(
      session,
      this.worktreeMode,
      (repoRoot, excludeId) => this.hasOtherSessionInRepo(repoRoot, excludeId)
    );
  }

  private hasOtherSessionInRepo(repoRoot: string, excludeThreadId: string): boolean {
    for (const session of this.registry.getAll()) {
      // Skip the session we're checking from (compare raw threadIds)
      if (session.threadId === excludeThreadId) continue;
      if (session.workingDir === repoRoot) return true;
      if (session.worktreeInfo?.repoRoot === repoRoot) return true;
    }
    return false;
  }

  private async postWorktreePrompt(session: Session, reason: string): Promise<void> {
    await worktreeModule.postWorktreePrompt(session, reason, (pid, tid) => this.registerPost(pid, tid));
    this.stopTyping(session);
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private persistSession(session: Session): void {
    // Get context prompt state from MessageManager (source of truth)
    let persistedContextPrompt: PersistedContextPrompt | undefined;
    const contextPromptState = session.messageManager?.getPendingContextPrompt();
    if (contextPromptState) {
      persistedContextPrompt = {
        postId: contextPromptState.postId,
        queuedPrompt: contextPromptState.queuedPrompt,
        queuedFiles: contextPromptState.queuedFiles,
        threadMessageCount: contextPromptState.threadMessageCount,
        createdAt: contextPromptState.createdAt,
        availableOptions: contextPromptState.availableOptions,
      };
    }

    // Get task list state from MessageManager (source of truth)
    const taskState = session.messageManager?.getTaskListState();

    const state: PersistedSession = {
      platformId: session.platformId,
      threadId: session.threadId,
      claudeSessionId: session.claudeSessionId,
      startedBy: session.startedBy,
      startedByDisplayName: session.startedByDisplayName,
      startedAt: session.startedAt.toISOString(),
      lastActivityAt: session.lastActivityAt.toISOString(),
      sessionNumber: session.sessionNumber,
      workingDir: session.workingDir,
      planApproved: session.planApproved,
      sessionAllowedUsers: [...session.sessionAllowedUsers],
      forceInteractivePermissions: session.forceInteractivePermissions,
      sessionStartPostId: session.sessionStartPostId,
      // Task state from MessageManager (single source of truth)
      tasksPostId: taskState?.postId ?? null,
      lastTasksContent: taskState?.content ?? null,
      tasksCompleted: taskState?.isCompleted ?? false,
      tasksMinimized: taskState?.isMinimized ?? false,
      worktreeInfo: session.worktreeInfo,
      isWorktreeOwner: session.isWorktreeOwner,
      pendingWorktreePrompt: session.pendingWorktreePrompt,
      worktreePromptDisabled: session.worktreePromptDisabled,
      queuedPrompt: session.queuedPrompt,
      queuedFiles: session.queuedFiles,
      firstPrompt: session.firstPrompt,
      pendingContextPrompt: persistedContextPrompt,
      needsContextPromptOnNextMessage: session.needsContextPromptOnNextMessage,
      lifecyclePostId: session.lifecyclePostId,
      isPaused: session.lifecycle.state === 'paused' || session.lifecycle.state === 'interrupted',
      sessionTitle: session.sessionTitle,
      sessionDescription: session.sessionDescription,
      sessionTags: session.sessionTags,
      pullRequestUrl: session.pullRequestUrl,
      messageCount: session.messageCount,
      resumeFailCount: session.lifecycle.resumeFailCount,
    };
    this.sessionStore.save(session.sessionId, state);
  }

  private unpersistSession(sessionId: string): void {
    // Soft-delete instead of hard delete - keeps session in history for display
    this.sessionStore.softDelete(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Session Header
  // ---------------------------------------------------------------------------

  private async updateSessionHeader(session: Session): Promise<void> {
    await commands.updateSessionHeader(session, this.getContext());
    // Also emit UI update for fields that may have changed (worktree, directory, etc.)
    this.emitSessionUpdate(session.sessionId, {
      workingDir: session.workingDir,
      worktreeBranch: session.worktreeInfo?.branch,
      title: session.sessionTitle,
      description: session.sessionDescription,
    });
  }

  // ---------------------------------------------------------------------------
  // Sticky Channel Message
  // ---------------------------------------------------------------------------

  private async updateStickyMessage(): Promise<void> {
    await stickyMessage.updateAllStickyMessages(this.platforms, this.registry.getSessions(), {
      maxSessions: this.limits.maxSessions,
      chromeEnabled: this.chromeEnabled,
      skipPermissions: this.skipPermissions,
      worktreeMode: this.worktreeMode,
      workingDir: this.workingDir,
      debug: this.debug,
    });
  }

  /**
   * Public method to trigger sticky message update.
   * Called when runtime settings change via keyboard toggles.
   */
  async updateAllStickyMessages(): Promise<void> {
    await this.updateStickyMessage();
  }

  /**
   * Update runtime settings (called from keyboard toggles).
   * These affect new sessions and sticky message display.
   */
  setSkipPermissions(value: boolean): void {
    this.skipPermissions = value;
  }

  setChromeEnabled(value: boolean): void {
    this.chromeEnabled = value;
  }

  // ---------------------------------------------------------------------------
  // Platform Toggle Support
  // ---------------------------------------------------------------------------

  /**
   * Pause all active sessions for a platform.
   * Called when a platform is disabled via keyboard toggle.
   * Sessions are persisted and can be resumed when platform is re-enabled.
   */
  async pauseSessionsForPlatform(platformId: string): Promise<void> {
    // Mark platform as paused in sticky message module
    stickyMessage.setPlatformPaused(platformId, true);

    const sessionsToKill: Session[] = [];

    for (const session of this.registry.getAll()) {
      if (session.platformId === platformId) {
        sessionsToKill.push(session);
      }
    }

    if (sessionsToKill.length === 0) {
      log.info(`No active sessions to pause for platform ${platformId}`);
      // Still update sticky message to show paused state
      await this.updateStickyMessage();
      return;
    }

    log.info(`⏸️ Pausing ${sessionsToKill.length} session(s) for platform ${platformId}`);

    for (const session of sessionsToKill) {
      try {
        const fmt = session.platform.getFormatter();
        const pauseMessage = `⏸️ ${fmt.formatBold('Platform disabled')} - session paused. Re-enable platform to resume.`;

        // Update or create lifecycle post
        if (session.lifecyclePostId) {
          await session.platform.updatePost(session.lifecyclePostId, pauseMessage);
        } else {
          const post = await session.platform.createPost(pauseMessage, session.threadId);
          session.lifecyclePostId = post.id;
        }

        // Stop typing indicator
        this.stopTyping(session);

        // Persist session state for later resume
        this.persistSession(session);

        // Kill the Claude CLI process
        session.claude.kill();

        // Remove from active sessions (but keep persisted)
        this.registry.unregister(session.sessionId);

        // Emit UI update
        this.emitSessionRemove(session.sessionId);

        log.info(`⏸️ Paused session ${session.threadId.substring(0, 8)}`);
      } catch (err) {
        log.warn(`Failed to pause session ${session.threadId}: ${err}`);
      }
    }

    // Clear post index entries for paused sessions
    for (const session of sessionsToKill) {
      this.registry.clearPostsForThread(session.threadId);
    }

    // Update sticky message to show paused state
    await this.updateStickyMessage();
  }

  /**
   * Resume all paused sessions for a platform.
   * Called when a platform is re-enabled via keyboard toggle.
   */
  async resumePausedSessionsForPlatform(platformId: string): Promise<void> {
    // Mark platform as active (not paused) in sticky message module
    stickyMessage.setPlatformPaused(platformId, false);
    const persisted = this.sessionStore.load();
    const sessionsToResume: PersistedSession[] = [];

    for (const state of persisted.values()) {
      // Only resume sessions for this platform
      if (state.platformId !== platformId) continue;

      // Skip sessions that are already active
      const sessionId = `${state.platformId}:${state.threadId}`;
      if (this.registry.hasById(sessionId)) continue;

      sessionsToResume.push(state);
    }

    if (sessionsToResume.length === 0) {
      log.info(`No paused sessions to resume for platform ${platformId}`);
      // Still update sticky message to clear paused state
      await this.updateStickyMessage();
      return;
    }

    log.info(`▶️ Resuming ${sessionsToResume.length} paused session(s) for platform ${platformId}`);

    for (const state of sessionsToResume) {
      try {
        await lifecycle.resumeSession(state, this.getContext());
        log.info(`▶️ Resumed session ${state.threadId.substring(0, 8)}`);
      } catch (err) {
        log.warn(`Failed to resume session ${state.threadId}: ${err}`);
      }
    }

    // Update sticky message to clear paused state (sessions trigger their own updates)
    await this.updateStickyMessage();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    // Initialize sticky message module with session store for persistence
    stickyMessage.initialize(this.sessionStore);

    // Start background tasks
    this.sessionMonitor?.start();
    this.backgroundCleanup?.start();

    // Clean up old sticky messages from the bot (from failed/crashed runs)
    // Run in background - no need to block startup. forceRun=true bypasses throttle.
    for (const platform of this.platforms.values()) {
      platform.getBotUser().then(botUser => {
        stickyMessage.cleanupOldStickyMessages(platform, botUser.id, true).catch(err => {
          log.warn(`Failed to cleanup old sticky messages for ${platform.platformId}: ${err}`);
        });
      }).catch(err => {
        log.warn(`Failed to get bot user for cleanup on ${platform.platformId}: ${err}`);
      });
    }

    // Clean up stale sessions that timed out while bot was down
    // Use 2x timeout to be generous (bot might have been down for a while)
    const sessionTimeoutMs = this.limits.sessionTimeoutMinutes * 60 * 1000;
    const staleIds = this.sessionStore.cleanStale(sessionTimeoutMs * 2);
    if (staleIds.length > 0) {
      log.info(`🧹 Soft-deleted ${staleIds.length} stale session(s) (kept for history)`);
    }

    // Permanently remove old history entries (older than 3 days by default)
    const removedCount = this.sessionStore.cleanHistory();
    if (removedCount > 0) {
      log.info(`🗑️ Permanently removed ${removedCount} old session(s) from history`);
    }

    const persisted = this.sessionStore.load();
    log.info(`📂 Loaded ${persisted.size} session(s) from persistence`);

    if (persisted.size > 0) {
      // Split sessions into active (to resume) and paused (to skip)
      // Sessions with isPaused=true were already paused (timeout/interrupt) before bot restart
      const activeToResume: PersistedSession[] = [];
      const pausedToSkip: PersistedSession[] = [];

      for (const state of persisted.values()) {
        if (state.isPaused) {
          // Session was paused (timeout or interrupt) - don't auto-resume
          pausedToSkip.push(state);
        } else {
          // Session was active when bot shut down - resume it
          activeToResume.push(state);
        }
      }

      if (pausedToSkip.length > 0) {
        log.info(`⏸️ ${pausedToSkip.length} session(s) remain paused (waiting for user message)`);
      }

      if (activeToResume.length > 0) {
        log.info(`🔄 Attempting to resume ${activeToResume.length} active session(s)...`);
        for (const state of activeToResume) {
          await lifecycle.resumeSession(state, this.getContext());
        }
      }
    }

    // Refresh sticky message to reflect current state (even if no sessions)
    await this.updateStickyMessage();
  }

  async startSession(
    options: { prompt: string; files?: PlatformFile[] },
    username: string,
    replyToPostId?: string,
    platformId: string = 'default',
    displayName?: string
  ): Promise<void> {
    await lifecycle.startSession(options, username, displayName, replyToPostId, platformId, this.getContext());
  }

  // Helper to find session by threadId (sessions are keyed by composite platformId:threadId)
  private findSessionByThreadId(threadId: string): Session | undefined {
    for (const session of this.registry.getAll()) {
      if (session.threadId === threadId) {
        return session;
      }
    }
    return undefined;
  }


  async sendFollowUp(threadId: string, message: string, files?: PlatformFile[], username?: string, displayName?: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session || !session.claude.isRunning()) return;
    await lifecycle.sendFollowUp(session, message, files, this.getContext(), username, displayName);
  }

  isSessionActive(): boolean {
    return this.registry.size > 0;
  }

  /**
   * Check if a thread has an active session.
   * Delegates to registry.findByThreadId() internally.
   */
  isInSessionThread(threadRoot: string): boolean {
    const session = this.registry.findByThreadId(threadRoot);
    return session !== undefined && session.claude.isRunning();
  }

  /**
   * Check if a thread has a paused (persisted but not active) session.
   * Delegates to registry.getPersistedByThreadId() internally.
   */
  hasPausedSession(threadId: string): boolean {
    // If there's an active session, it's not paused
    if (this.registry.findByThreadId(threadId)) return false;
    // Check for persisted session
    return this.registry.getPersistedByThreadId(threadId) !== undefined;
  }

  async resumePausedSession(threadId: string, message: string, files?: PlatformFile[]): Promise<void> {
    await lifecycle.resumePausedSession(threadId, message, files, this.getContext());
  }

  getPersistedSession(threadId: string): PersistedSession | undefined {
    return this.registry.getPersistedByThreadId(threadId);
  }

  async killSession(threadId: string, unpersist = true): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await lifecycle.killSession(session, unpersist, this.getContext());
  }

  async killAllSessions(): Promise<void> {
    await lifecycle.killAllSessions(this.getContext());
  }

  // Commands
  async cancelSession(threadId: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.cancelSession(session, username, this.getContext());
  }

  async interruptSession(threadId: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.interruptSession(session, username);
  }

  async approvePendingPlan(threadId: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.approvePendingPlan(session, username, this.getContext());
  }

  async changeDirectory(threadId: string, newDir: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.changeDirectory(session, newDir, username, this.getContext());
  }

  async inviteUser(threadId: string, invitedUser: string, invitedBy: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.inviteUser(session, invitedUser, invitedBy, this.getContext());
  }

  async kickUser(threadId: string, kickedUser: string, kickedBy: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.kickUser(session, kickedUser, kickedBy, this.getContext());
  }

  async enableInteractivePermissions(threadId: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.enableInteractivePermissions(session, username, this.getContext());
  }

  async reportBug(threadId: string, description: string | undefined, username: string, files?: PlatformFile[]): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.reportBug(session, description, username, this.getContext(), undefined, files);
  }

  async showUpdateStatus(threadId: string, _username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.showUpdateStatus(session, this.autoUpdateManager, this.getContext());
  }

  async forceUpdateNow(threadId: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.forceUpdateNow(session, username, this.autoUpdateManager);
  }

  async deferUpdate(threadId: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.deferUpdate(session, username, this.autoUpdateManager);
  }

  isSessionInteractive(threadId: string): boolean {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return !this.skipPermissions;
    if (!this.skipPermissions) return true;
    return session.forceInteractivePermissions;
  }

  async requestMessageApproval(threadId: string, username: string, message: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.requestMessageApproval(session, username, message, this.getContext());
  }

  // Worktree commands
  async handleWorktreeBranchResponse(threadId: string, branchName: string, username: string, responsePostId: string): Promise<boolean> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return false;
    return worktreeModule.handleWorktreeBranchResponse(
      session,
      branchName,
      username,
      responsePostId,
      (tid, branch, user) => this.createAndSwitchToWorktree(tid, branch, user)
    );
  }

  async handleWorktreeSkip(threadId: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await worktreeModule.handleWorktreeSkip(
      session,
      username,
      (s) => this.persistSession(s),
      (s, q) => contextPrompt.offerContextPrompt(s, q, undefined, this.getContextPromptHandler())
    );
  }

  async createAndSwitchToWorktree(threadId: string, branch: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await worktreeModule.createAndSwitchToWorktree(session, branch, username, {
      skipPermissions: this.skipPermissions,
      chromeEnabled: this.chromeEnabled,
      worktreeMode: this.worktreeMode,
      permissionTimeoutMs: this.limits.permissionTimeoutSeconds * 1000,
      handleEvent: (tid, e) => this.handleEvent(tid, e),
      handleExit: (tid, code) => this.handleExit(tid, code),
      updateSessionHeader: (s) => this.updateSessionHeader(s),
      flush: async (s) => {
        if (s.messageManager) {
          await s.messageManager.flush();
        }
      },
      persistSession: (s) => this.persistSession(s),
      startTyping: (s) => this.startTyping(s),
      stopTyping: (s) => this.stopTyping(s),
      offerContextPrompt: (s, q, f, e) => contextPrompt.offerContextPrompt(s, q, f, this.getContextPromptHandler(), e),
      appendSystemPrompt: CHAT_PLATFORM_PROMPT,
      registerPost: (postId, tid) => this.registerPost(postId, tid),
      updateStickyMessage: () => this.updateStickyMessage(),
      registerWorktreeUser: (path, sid) => this.registerWorktreeUser(path, sid),
    });
  }

  async switchToWorktree(threadId: string, branchOrPath: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await worktreeModule.switchToWorktree(
      session,
      branchOrPath,
      username,
      (tid, dir, user) => this.changeDirectory(tid, dir, user)
    );
  }

  async listWorktreesCommand(threadId: string, _username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await worktreeModule.listWorktreesCommand(session);
  }

  async removeWorktreeCommand(threadId: string, branchOrPath: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await worktreeModule.removeWorktreeCommand(session, branchOrPath, username);
  }

  async disableWorktreePrompt(threadId: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await worktreeModule.disableWorktreePrompt(session, username, (s) => this.persistSession(s));
  }

  async cleanupWorktreeCommand(threadId: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await worktreeModule.cleanupWorktreeCommand(
      session,
      username,
      (path, sid) => this.hasOtherSessionsUsingWorktree(path, sid),
      (tid, path, user) => this.changeDirectory(tid, path, user)
    );
  }

  hasPendingWorktreePrompt(threadId: string): boolean {
    const session = this.findSessionByThreadId(threadId);
    return session?.pendingWorktreePrompt === true;
  }

  // Missing public methods needed by index.ts
  getActiveThreadIds(): string[] {
    // Return raw threadIds (not composite sessionIds) for posting to chat
    return [...this.registry.getAll()].map(s => s.threadId);
  }

  /**
   * Get the session start post ID for a thread.
   *
   * This is the post where:
   * - The bot's initial response was posted (containing the session header)
   * - Reactions are tracked for session control (cancel, interrupt, etc.)
   *
   * Checks both active sessions and persisted sessions.
   *
   * @param threadId - The thread ID to look up
   * @returns The post ID where the session started, or undefined if not found
   */
  getSessionStartPostId(threadId: string): string | undefined {
    // First check active sessions
    const session = this.findSessionByThreadId(threadId);
    if (session?.sessionStartPostId) {
      return session.sessionStartPostId;
    }
    // Then check persisted sessions (for resume scenarios)
    const persisted = this.registry.getPersistedByThreadId(threadId);
    return persisted?.sessionStartPostId ?? undefined;
  }

  /**
   * Post shutdown messages to all active sessions and persist the post IDs.
   * This allows the resume to update the same post instead of creating a new one.
   */
  async postShutdownMessages(): Promise<void> {
    for (const session of this.registry.getAll()) {
      try {
        const fmt = session.platform.getFormatter();
        const shutdownMessage = `⏸️ ${fmt.formatBold('Bot shutting down')} - session will resume on restart`;

        if (session.lifecyclePostId) {
          // Update existing timeout/warning post
          await session.platform.updatePost(session.lifecyclePostId, shutdownMessage);
        } else {
          // Create new shutdown post and store the ID
          const post = await session.platform.createPost(shutdownMessage, session.threadId);
          session.lifecyclePostId = post.id;
        }
        // Persist so resume can find the post ID
        this.persistSession(session);
      } catch {
        // Ignore errors, we're shutting down
      }
    }
  }

  isUserAllowedInSession(threadId: string, username: string): boolean {
    const session = this.findSessionByThreadId(threadId);
    if (!session) {
      // Check persisted session
      const persisted = this.getPersistedSession(threadId);
      if (persisted) {
        // Defensive: handle missing sessionAllowedUsers (old persisted data)
        return (persisted.sessionAllowedUsers || []).includes(username) ||
               this.platforms.get(persisted.platformId)?.isUserAllowed(username) || false;
      }
      return false;
    }
    return session.sessionAllowedUsers.has(username) || session.platform.isUserAllowed(username);
  }

  async startSessionWithWorktree(
    options: { prompt: string; files?: PlatformFile[] },
    branch: string,
    username: string,
    replyToPostId?: string,
    platformId: string = 'default',
    displayName?: string
  ): Promise<void> {
    // Start normal session first
    await this.startSession(options, username, replyToPostId, platformId, displayName);

    // Then switch to worktree
    const threadId = replyToPostId || '';
    const session = this.registry.find(platformId, threadId);
    if (session) {
      await this.createAndSwitchToWorktree(session.threadId, branch, username);
    }
  }

  setShuttingDown(): void {
    this.isShuttingDown = true;
    // Update sticky message module to show shutdown state
    stickyMessage.setShuttingDown(true);
  }

  // ---------------------------------------------------------------------------
  // Auto-update support methods
  // ---------------------------------------------------------------------------

  /**
   * Get session activity info for auto-update scheduling.
   * Returns the number of active sessions, last activity time, and busy state.
   */
  getActivityInfo(): { activeSessionCount: number; lastActivityAt: Date | null; anySessionBusy: boolean } {
    const sessions = [...this.registry.getAll()];

    if (sessions.length === 0) {
      return {
        activeSessionCount: 0,
        lastActivityAt: null,
        anySessionBusy: false,
      };
    }

    // Find the most recent activity across all sessions
    let lastActivity: Date | null = null;
    let anyBusy = false;

    for (const session of sessions) {
      if (!lastActivity || session.lastActivityAt > lastActivity) {
        lastActivity = session.lastActivityAt;
      }
      // A session is "busy" if it's typing (Claude is processing)
      if (session.timers.typingTimer !== null) {
        anyBusy = true;
      }
    }

    return {
      activeSessionCount: sessions.length,
      lastActivityAt: lastActivity,
      anySessionBusy: anyBusy,
    };
  }

  /**
   * Broadcast a message to all active sessions.
   * Used for update notifications.
   * @param messageBuilder - Function that takes a formatter and returns the formatted message
   */
  async broadcastToAll(messageBuilder: (formatter: import('../platform/formatter.js').PlatformFormatter) => string): Promise<void> {
    for (const session of this.registry.getAll()) {
      try {
        const formatter = session.platform.getFormatter();
        const message = messageBuilder(formatter);
        await post(session, 'info', message);
      } catch (err) {
        log.warn(`Failed to broadcast to session ${session.threadId}: ${err}`);
      }
    }
  }

  /**
   * Post update approval request to specific threads (for 'ask' mode).
   * Returns the post IDs for reaction tracking.
   */
  async postUpdateAskMessage(threadIds: string[], version: string): Promise<void> {
    for (const threadId of threadIds) {
      const session = this.findSessionByThreadId(threadId);
      if (!session) continue;

      try {
        const fmt = session.platform.getFormatter();
        const message =
          `🔄 ${fmt.formatBold('Update available:')} v${version}\n\n` +
          `React: 👍 to update now | 👎 to defer for 1 hour\n` +
          fmt.formatItalic('Update will proceed automatically after timeout if no response');

        const post = await session.platform.createInteractivePost(
          message,
          ['👍', '👎'],
          session.threadId
        );

        // Store pending update prompt for reaction handling
        session.messageManager?.setPendingUpdatePrompt({ postId: post.id });
        this.registerPost(post.id, session.threadId);
      } catch (err) {
        log.warn(`Failed to post ask message to ${threadId}: ${err}`);
      }
    }
  }

  // Shutdown
  async shutdown(message?: string): Promise<void> {
    this.isShuttingDown = true;

    // Stop background tasks
    this.sessionMonitor?.stop();
    this.backgroundCleanup?.stop();

    // Post shutdown message to all active sessions
    if (message) {
      for (const session of this.registry.getAll()) {
        try {
          await post(session, 'info', message);
        } catch {
          // Ignore
        }
      }
    }

    // Persist and kill all sessions for later resume
    for (const session of this.registry.getAll()) {
      this.stopTyping(session);
      this.persistSession(session);
      session.claude.kill();
    }
    this.registry.clear();
  }
}
