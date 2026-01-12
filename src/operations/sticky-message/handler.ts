/**
 * Sticky Channel Message module
 *
 * Maintains a "sticky" message at the bottom of the channel that displays
 * an overview of active sessions with links to their threads.
 * The message is updated whenever sessions start or end.
 */

import type { Session } from '../../session/types.js';
import { getSessionStatus } from '../../session/types.js';
import type { PlatformClient, PlatformFormatter } from '../../platform/index.js';
import { getPlatformIcon } from '../../platform/utils.js';
import type { SessionStore, PersistedSession } from '../../persistence/session-store.js';
import type { WorktreeMode } from '../../config.js';
import { formatBatteryStatus } from '../../utils/battery.js';
import { formatUptime } from '../../utils/uptime.js';
import { formatRelativeTimeShort } from '../../utils/format.js';
import { VERSION } from '../../version.js';
import { createLogger } from '../../utils/logger.js';
import { formatPullRequestLink } from '../../utils/pr-detector.js';
import { getClaudeCliVersion } from '../../claude/version-check.js';
import { keepAlive } from '../../utils/keep-alive.js';

const log = createLogger('sticky');

// Bot start time for uptime tracking
const botStartedAt = new Date();

// =============================================================================
// Pending Prompts
// =============================================================================

/**
 * Represents a pending prompt awaiting user response.
 * Used for displaying pending states in the thread list.
 */
export interface PendingPrompt {
  /** Type of prompt */
  type: 'plan' | 'question' | 'message_approval' | 'worktree' | 'existing_worktree' | 'context';
  /** Short label for display (e.g., "Plan approval", "Question 2/5") */
  label: string;
  /** Emoji indicator */
  emoji: string;
}

/**
 * Extract all pending prompts from a session.
 * Returns an array of pending prompts that are awaiting user response.
 *
 * This is a reusable function that can be used anywhere pending state
 * needs to be displayed (sticky message, session header, etc.)
 */
export function getPendingPrompts(session: Session): PendingPrompt[] {
  const prompts: PendingPrompt[] = [];

  // Plan approval from MessageManager
  const pendingApproval = session.messageManager?.getPendingApproval();
  if (pendingApproval?.type === 'plan') {
    prompts.push({
      type: 'plan',
      label: 'Plan approval',
      emoji: '📋',
    });
  }

  // Question set (multi-step questions) from MessageManager
  const pendingQuestionSet = session.messageManager?.getPendingQuestionSet();
  if (pendingQuestionSet) {
    const current = pendingQuestionSet.currentIndex + 1;
    const total = pendingQuestionSet.questions.length;
    prompts.push({
      type: 'question',
      label: `Question ${current}/${total}`,
      emoji: '❓',
    });
  }

  // Message approval (unauthorized user message)
  if (session.messageManager?.getPendingMessageApproval()) {
    prompts.push({
      type: 'message_approval',
      label: 'Message approval',
      emoji: '💬',
    });
  }

  // Worktree prompt (waiting for branch name)
  if (session.pendingWorktreePrompt) {
    prompts.push({
      type: 'worktree',
      label: 'Branch name',
      emoji: '🌿',
    });
  }

  // Existing worktree prompt (join existing?)
  if (session.messageManager?.hasPendingExistingWorktreePrompt() || session.pendingExistingWorktreePrompt) {
    prompts.push({
      type: 'existing_worktree',
      label: 'Join worktree',
      emoji: '🌿',
    });
  }

  // Context prompt (include previous messages?)
  if (session.messageManager?.getPendingContextPrompt()) {
    prompts.push({
      type: 'context',
      label: 'Context selection',
      emoji: '📝',
    });
  }

  return prompts;
}

/**
 * Format pending prompts for display in a single line.
 * Returns a formatted string or null if no pending prompts.
 *
 * Example output: "⏳ 📋 Plan approval"
 * Example output: "⏳ ❓ Question 2/5 · 💬 Message approval"
 */
export function formatPendingPrompts(session: Session): string | null {
  const prompts = getPendingPrompts(session);
  if (prompts.length === 0) return null;

  const formatted = prompts.map(p => `${p.emoji} ${p.label}`).join(' · ');
  return `⏳ ${formatted}`;
}

/**
 * Update status info for sticky message display
 */
export interface UpdateStatusInfo {
  /** Whether an update is available */
  available: boolean;
  /** Latest version (if available) */
  latestVersion?: string;
  /** Current status: idle, available, scheduled, installing, etc. */
  status: string;
  /** Seconds until restart (if countdown active) */
  countdownSeconds?: number;
}

/**
 * Configuration for sticky message status bar
 */
export interface StickyMessageConfig {
  maxSessions: number;
  chromeEnabled: boolean;
  skipPermissions: boolean;
  worktreeMode: WorktreeMode;
  workingDir: string;
  debug: boolean;
  /** Optional update status info */
  updateStatus?: UpdateStatusInfo;
}

// Store sticky post IDs per platform (in-memory cache)
const stickyPostIds: Map<string, string> = new Map();

// Track if there's been a channel post since last sticky update (per platform)
// If false, we can just update in place instead of delete+recreate
const needsBump: Map<string, boolean> = new Map();

// Mutex to prevent concurrent updates per platform (prevents race conditions)
const updateLocks: Map<string, Promise<void>> = new Map();

// Reference to session store for persistence
let sessionStore: SessionStore | null = null;

// Track paused platforms (platform ID -> true if paused)
const pausedPlatforms: Map<string, boolean> = new Map();

// Track bot shutdown state
let isShuttingDown = false;

// Track last cleanup time per platform (for throttling)
const lastCleanupTime: Map<string, number> = new Map();

// Cleanup throttle: only run cleanup once per 5 minutes per platform
const CLEANUP_THROTTLE_MS = 5 * 60 * 1000;

// Only clean up posts from the last hour (older orphans are rare and not worth the API calls)
const CLEANUP_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Initialize the sticky message module with the session store for persistence.
 */
export function initialize(store: SessionStore): void {
  sessionStore = store;

  // Restore sticky post IDs from persistence
  const persistedIds = store.getStickyPostIds();
  for (const [platformId, postId] of persistedIds) {
    stickyPostIds.set(platformId, postId);
  }

  if (persistedIds.size > 0) {
    log.info(`📌 Restored ${persistedIds.size} sticky post ID(s) from persistence`);
  }
}

/**
 * Mark a platform as paused/unpaused.
 * When paused, the sticky message will show a pause indicator.
 */
export function setPlatformPaused(platformId: string, paused: boolean): void {
  if (paused) {
    pausedPlatforms.set(platformId, true);
    log.debug(`Platform ${platformId} marked as paused`);
  } else {
    pausedPlatforms.delete(platformId);
    log.debug(`Platform ${platformId} marked as active`);
  }
}

/**
 * Check if a platform is paused.
 */
export function isPlatformPaused(platformId: string): boolean {
  return pausedPlatforms.get(platformId) ?? false;
}

/**
 * Mark the bot as shutting down.
 * The sticky message will show a shutdown indicator.
 */
export function setShuttingDown(shuttingDown: boolean): void {
  isShuttingDown = shuttingDown;
  log.debug(`Bot shutdown state: ${shuttingDown}`);
}

/**
 * Check if the bot is shutting down.
 */
export function getShuttingDown(): boolean {
  return isShuttingDown;
}



/**
 * Get task content from MessageManager (or fall back to Session for backward compat).
 */
function getTaskContent(session: Session): string | null {
  // Prefer MessageManager state (source of truth)
  const taskState = session.messageManager?.getTaskListState();
  if (taskState?.content) {
    return taskState.content;
  }
  // Fallback to Session for backward compatibility
  return session.lastTasksContent;
}

/**
 * Extract task progress from task content.
 * Returns string like "3/7" or null if no tasks.
 */
function getTaskProgress(session: Session): string | null {
  const content = getTaskContent(session);
  if (!content) return null;

  // Parse progress from format: "📋 **Tasks** (3/7 · 43%)"
  const match = content.match(/\((\d+)\/(\d+)/);
  if (match) {
    return `${match[1]}/${match[2]}`;
  }
  return null;
}

/**
 * Extract the active (in-progress) task name from task content.
 * Returns the task activeForm or null if no task is in progress.
 *
 * Task format in lastTasksContent:
 * 🔄 **Task name** (12s)
 */
function getActiveTask(session: Session): string | null {
  const content = getTaskContent(session);
  if (!content) return null;

  // Parse in-progress task from format: "🔄 **Task name** (12s)" or "🔄 *Task name*"
  // The activeForm is wrapped in ** (Mattermost) or * (Slack) and may have elapsed time
  // Regex matches both: \*{1,2} matches 1 or 2 asterisks
  const match = content.match(/🔄 \*{1,2}([^*]+)\*{1,2}/);
  if (match) {
    return match[1].trim();
  }
  return null;
}

/**
 * Get status indicator for a session.
 * Uses small, subtle text symbols at end of line.
 */
function getStatusIndicator(session: Session): string {
  const status = getSessionStatus(session);
  switch (status) {
    case 'starting':
    case 'active':
      return '●'; // Filled circle - working
    case 'idle':
      return '○'; // Empty circle - idle/waiting
    case 'stopping':
      return '◌'; // Dotted circle - stopping
    case 'paused':
      return '⏸'; // Paused
    default:
      return '○';
  }
}

/**
 * Get the display topic for a session.
 * Prefers the dynamic sessionTitle (generated by Claude), falls back to firstPrompt.
 */
function getSessionTopic(session: Session, formatter: PlatformFormatter): string {
  // Use Claude-generated title if available
  if (session.sessionTitle) {
    return session.sessionTitle;
  }

  // Fall back to first prompt
  return formatTopicFromPrompt(session.firstPrompt, formatter);
}

/**
 * Get the display topic for a persisted session (history).
 */
function getHistorySessionTopic(session: PersistedSession, formatter: PlatformFormatter): string {
  if (session.sessionTitle) {
    return session.sessionTitle;
  }
  return formatTopicFromPrompt(session.firstPrompt, formatter);
}

/**
 * Format a history session entry for display.
 * @param session - The inactive session from history (completed or timed out)
 * @param formatter - Platform formatter
 * @returns Formatted line for the sticky message
 */
function formatHistoryEntry(
  session: PersistedSession,
  formatter: PlatformFormatter,
  getThreadLink: (threadId: string) => string
): string[] {
  const topic = getHistorySessionTopic(session, formatter);
  const threadLink = formatter.formatLink(topic, getThreadLink(session.threadId));
  const displayName = session.startedByDisplayName || session.startedBy;
  // Determine if this is a timed-out (resumable) session or a completed session
  // Check both new and legacy field names for backward compatibility
  const legacySession = session as PersistedSession & { timeoutPostId?: string };
  const isTimedOut = !session.cleanedAt && (session.lifecyclePostId || legacySession.timeoutPostId);
  // Show when the user last worked on it, not when it was cleaned up
  // Defensive: handle missing lastActivityAt (old persisted data)
  const lastActivity = session.lastActivityAt ? new Date(session.lastActivityAt) : new Date();
  const time = formatRelativeTimeShort(lastActivity);

  // Build PR link if available
  const prStr = session.pullRequestUrl ? ` · ${formatPullRequestLink(session.pullRequestUrl, formatter)}` : '';

  // Use different indicators: ⏸️ for timed out (resumable), ✓ for completed
  const indicator = isTimedOut ? '⏸️' : '✓';
  const resumeHint = isTimedOut ? ` · ${formatter.formatItalic('react 🔄 to resume')}` : '';

  const lines: string[] = [];
  lines.push(`  ${indicator} ${threadLink} · ${formatter.formatBold(displayName)}${prStr} · ${time}${resumeHint}`);

  // Add description on next line if available
  if (session.sessionDescription) {
    // Add tag badges inline with description if available
    const tagBadges = session.sessionTags?.length
      ? ' ' + session.sessionTags.map(t => formatter.formatCode(t)).join(' ')
      : '';
    lines.push(`     ${formatter.formatItalic(session.sessionDescription)}${tagBadges}`);
  } else if (session.sessionTags?.length) {
    // Show tags alone if no description
    const tagBadges = session.sessionTags.map(t => formatter.formatCode(t)).join(' ');
    lines.push(`     ${tagBadges}`);
  }

  return lines;
}

/**
 * Build the status bar for the sticky message.
 * Shows system-level info: version, sessions, settings, battery, uptime, hostname
 */
async function buildStatusBar(
  sessionCount: number,
  config: StickyMessageConfig,
  formatter: PlatformFormatter,
  platformId: string
): Promise<string> {
  const items: string[] = [];

  // Show shutdown indicator prominently at the start
  if (isShuttingDown) {
    items.push(formatter.formatCode('🛑 Shutting down...'));
  }

  // Show paused indicator for this platform
  if (pausedPlatforms.get(platformId)) {
    items.push(formatter.formatCode('⏸️ Platform paused'));
  }

  // Show update status if available
  if (config.updateStatus?.available) {
    const status = config.updateStatus;
    if (status.countdownSeconds !== undefined && status.countdownSeconds > 0) {
      items.push(formatter.formatCode(`🔄 Restarting in ${status.countdownSeconds}s`));
    } else if (status.status === 'installing') {
      items.push(formatter.formatCode(`📦 Installing v${status.latestVersion}...`));
    } else if (status.status === 'available') {
      items.push(formatter.formatCode(`🆕 Update: v${status.latestVersion}`));
    } else if (status.status === 'deferred') {
      items.push(formatter.formatCode(`⏸️ Update deferred`));
    }
  }

  // Version (claude-threads + Claude CLI)
  const claudeVersion = getClaudeCliVersion();
  const versionStr = claudeVersion ? `v${VERSION} · CLI ${claudeVersion}` : `v${VERSION}`;
  items.push(formatter.formatCode(versionStr));

  // Session count
  items.push(formatter.formatCode(`${sessionCount}/${config.maxSessions} sessions`));

  // Permission mode
  const permMode = config.skipPermissions ? '⚡ Auto' : '🔐 Interactive';
  items.push(formatter.formatCode(permMode));

  // Worktree mode (only show if not default 'prompt')
  if (config.worktreeMode === 'require') {
    items.push(formatter.formatCode('🌿 Worktree: require'));
  } else if (config.worktreeMode === 'off') {
    items.push(formatter.formatCode('🌿 Worktree: off'));
  }

  // Chrome status
  if (config.chromeEnabled) {
    items.push(formatter.formatCode('🌐 Chrome'));
  }

  // Debug mode
  if (config.debug) {
    items.push(formatter.formatCode('🐛 Debug'));
  }

  // Keep-alive status (show enabled state, not just active state)
  if (keepAlive.isEnabled()) {
    items.push(formatter.formatCode('💓 Keep-alive'));
  }

  // Battery status (if available)
  const battery = await formatBatteryStatus();
  if (battery) {
    items.push(formatter.formatCode(battery));
  }

  // Bot uptime
  const uptime = formatUptime(botStartedAt);
  items.push(formatter.formatCode(`⏱️ ${uptime}`));

  // Working directory (shortened)
  const shortDir = config.workingDir.replace(process.env.HOME || '', '~');
  items.push(formatter.formatCode(`📂 ${shortDir}`));

  return items.join(' · ');
}

/**
 * Truncate and clean a prompt for display as a thread topic
 */
function formatTopicFromPrompt(prompt: string | undefined, formatter: PlatformFormatter): string {
  if (!prompt) return formatter.formatItalic('No topic');

  // Remove @mentions at the start
  let cleaned = prompt.replace(/^@[\w-]+\s*/g, '').trim();

  // Skip bot commands (e.g., !worktree switch, !cd) - these aren't meaningful topics
  if (cleaned.startsWith('!')) {
    return formatter.formatItalic('No topic');
  }

  // Remove newlines and collapse whitespace
  cleaned = cleaned.replace(/\s+/g, ' ');

  // Truncate to ~50 chars with ellipsis
  if (cleaned.length > 50) {
    cleaned = cleaned.substring(0, 47) + '…';
  }

  return cleaned || formatter.formatItalic('No topic');
}


/**
 * Build the sticky message content showing all active sessions
 */
export async function buildStickyMessage(
  sessions: Map<string, Session>,
  platformId: string,
  config: StickyMessageConfig,
  formatter: PlatformFormatter,
  getThreadLink: (threadId: string) => string
): Promise<string> {
  // If shutting down, show a minimal message
  if (isShuttingDown) {
    const lines = [
      formatter.formatHorizontalRule(),
      formatter.formatCode('🛑 Shutting down...'),
      '',
      formatter.formatBold('Bot Offline'),
      '',
      formatter.formatItalic('Sessions will resume on restart'),
    ];
    return lines.join('\n');
  }

  // If this platform is paused, show a minimal message
  if (pausedPlatforms.get(platformId)) {
    const lines = [
      formatter.formatHorizontalRule(),
      formatter.formatCode('⏸️ Platform paused'),
      '',
      formatter.formatBold('Platform Paused'),
      '',
      formatter.formatItalic('Sessions will resume when platform is re-enabled'),
    ];
    return lines.join('\n');
  }

  // Get all sessions and separate by platform
  const allSessions = [...sessions.values()];
  const thisPlatformSessions = allSessions.filter(s => s.platformId === platformId);
  const otherPlatformSessions = allSessions.filter(s => s.platformId !== platformId);
  const totalCount = allSessions.length;

  // Build status bar (shown even when no sessions) - show total count
  const statusBar = await buildStatusBar(totalCount, config, formatter, platformId);

  // Get recent history (completed + timed-out sessions)
  // Pass active session IDs to exclude them from history
  const activeSessionIds = new Set(sessions.keys());
  const historySessions = sessionStore ? sessionStore.getHistory(platformId, activeSessionIds).slice(0, 5) : [];

  if (totalCount === 0) {
    const lines = [
      formatter.formatHorizontalRule(),
      statusBar,
      '',
      formatter.formatBold('Active Claude Threads'),
      '',
      formatter.formatItalic('No active sessions'),
    ];

    // Add history section if there are recent completed sessions
    if (historySessions.length > 0) {
      lines.push('');
      lines.push(formatter.formatBold(`Recent (${historySessions.length})`));
      lines.push('');
      for (const historySession of historySessions) {
        lines.push(...formatHistoryEntry(historySession, formatter, getThreadLink));
      }
    }

    lines.push('');
    lines.push(`${formatter.formatItalic('Mention me to start a session')} · ${formatter.formatCode('bun install -g claude-threads')} · ${formatter.formatLink('claude-threads.run', 'https://claude-threads.run/')}`);

    return lines.join('\n');
  }

  // Sort all sessions by start time (newest first)
  thisPlatformSessions.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  otherPlatformSessions.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

  const lines: string[] = [
    formatter.formatHorizontalRule(),
    statusBar,
    '',
    formatter.formatBold(`Active Claude Threads (${totalCount})`),
    '',
  ];

  // Helper to format a session entry
  const formatSessionEntry = (session: Session, isThisPlatform: boolean) => {
    const platformIcon = getPlatformIcon(session.platform.platformType);
    const topic = getSessionTopic(session, formatter);

    // Only create clickable link for sessions on this platform
    // Use lastMessageId/lastMessageTs to jump to bottom of thread if available
    const topicDisplay = isThisPlatform
      ? formatter.formatLink(topic, session.platform.getThreadLink(session.threadId, session.lastMessageId, session.lastMessageTs))
      : topic;

    const displayName = session.startedByDisplayName || session.startedBy;
    const time = formatRelativeTimeShort(session.startedAt);

    // Build task progress if available (e.g., "3/7")
    const taskProgress = getTaskProgress(session);
    const progressStr = taskProgress ? ` · ${taskProgress}` : '';

    // Build PR link if available (compact format on same line)
    const prStr = session.pullRequestUrl ? ` · ${formatPullRequestLink(session.pullRequestUrl, formatter)}` : '';

    // Status indicator at end (● active, ○ idle)
    const statusIcon = getStatusIndicator(session);

    // Add platform name for other platforms
    const platformSuffix = isThisPlatform ? '' : ` · ${formatter.formatItalic(session.platform.displayName)}`;

    lines.push(`${platformIcon} ▸ ${topicDisplay} · ${formatter.formatBold(displayName)}${progressStr}${prStr} · ${time}${platformSuffix} ${statusIcon}`);

    // Add description on next line if available
    if (session.sessionDescription) {
      // Add tag badges inline with description if available
      const tagBadges = session.sessionTags?.length
        ? ' ' + session.sessionTags.map(t => formatter.formatCode(t)).join(' ')
        : '';
      lines.push(`   ${formatter.formatItalic(session.sessionDescription)}${tagBadges}`);
    } else if (session.sessionTags?.length) {
      // Show tags alone if no description
      const tagBadges = session.sessionTags.map(t => formatter.formatCode(t)).join(' ');
      lines.push(`   ${tagBadges}`);
    }

    // Add pending prompts if any (awaiting user input)
    const pendingPromptsStr = formatPendingPrompts(session);
    if (pendingPromptsStr) {
      lines.push(`   ${pendingPromptsStr}`);
    }

    // Add active task below description if available (only if no pending prompts)
    const activeTask = getActiveTask(session);
    if (activeTask && !pendingPromptsStr) {
      lines.push(`   🔄 ${formatter.formatItalic(activeTask)}`);
    }
  };

  // First show sessions from this platform
  for (const session of thisPlatformSessions) {
    formatSessionEntry(session, true);
  }

  // Then show sessions from other platforms
  for (const session of otherPlatformSessions) {
    formatSessionEntry(session, false);
  }

  // Add history section if there are recent completed sessions
  if (historySessions.length > 0) {
    lines.push('');
    lines.push(formatter.formatBold(`Recent (${historySessions.length})`));
    lines.push('');
    for (const historySession of historySessions) {
      lines.push(...formatHistoryEntry(historySession, formatter, getThreadLink));
    }
  }

  lines.push('');
  lines.push(`${formatter.formatItalic('Mention me to start a session')} · ${formatter.formatCode('bun install -g claude-threads')} · ${formatter.formatLink('claude-threads.run', 'https://claude-threads.run/')}`);

  return lines.join('\n');
}

/**
 * Update the sticky channel message for a platform.
 * If someone posted in the channel since last update, deletes and recreates at bottom.
 * Otherwise, just updates in place to avoid noise.
 *
 * Uses a mutex to prevent concurrent updates which can cause duplicate sticky posts.
 */
export async function updateStickyMessage(
  platform: PlatformClient,
  sessions: Map<string, Session>,
  config: StickyMessageConfig
): Promise<void> {
  const platformId = platform.platformId;

  // Wait for any pending update to complete (mutex)
  const pendingUpdate = updateLocks.get(platformId);
  if (pendingUpdate) {
    await pendingUpdate;
  }

  // Create a new lock for this update
  let releaseLock: (() => void) | undefined;
  const lock = new Promise<void>(resolve => { releaseLock = resolve; });
  updateLocks.set(platformId, lock);

  try {
    await updateStickyMessageImpl(platform, sessions, config);
  } finally {
    if (releaseLock) releaseLock();
    updateLocks.delete(platformId);
  }
}

/**
 * Internal implementation of sticky message update.
 */
async function updateStickyMessageImpl(
  platform: PlatformClient,
  sessions: Map<string, Session>,
  config: StickyMessageConfig
): Promise<void> {
  const platformSessions = [...sessions.values()].filter(s => s.platformId === platform.platformId);
  log.debug(`updateStickyMessage for ${platform.platformId}, ${platformSessions.length} sessions`);
  for (const s of platformSessions) {
    log.debug(`  - ${s.sessionId}: title="${s.sessionTitle}" firstPrompt="${s.firstPrompt?.substring(0, 30)}..."`);
  }

  const formatter = platform.getFormatter();
  const content = await buildStickyMessage(
    sessions,
    platform.platformId,
    config,
    formatter,
    (threadId) => platform.getThreadLink(threadId)
  );
  const existingPostId = stickyPostIds.get(platform.platformId);
  const shouldBump = needsBump.get(platform.platformId) ?? false;

  log.debug(`existingPostId: ${existingPostId || '(none)'}, needsBump: ${shouldBump}`);

  try {
    // If we have an existing post and no bump is needed, just update in place
    if (existingPostId && !shouldBump) {
      log.debug(`Updating existing post in place...`);
      try {
        await platform.updatePost(existingPostId, content);
        // Re-pin to ensure it stays pinned (defensive - pin status can be lost)
        try {
          await platform.pinPost(existingPostId);
          log.debug(`Re-pinned post`);
        } catch (pinErr) {
          log.debug(`Re-pin failed (might already be pinned): ${pinErr}`);
        }
        log.debug(`Updated successfully`);
        return;
      } catch (err) {
        // Post might have been deleted, fall through to create new one
        log.debug(`Update failed, will create new: ${err}`);
      }
    }

    // Reset bump flag
    needsBump.set(platform.platformId, false);

    // Delete existing sticky post if it exists
    if (existingPostId) {
      log.debug(`Unpinning and deleting existing post ${existingPostId.substring(0, 8)}...`);
      try {
        // Unpin first, then delete
        await platform.unpinPost(existingPostId);
        log.debug(`Unpinned successfully`);
      } catch (err) {
        // Post might already be unpinned or deleted, that's fine
        log.debug(`Unpin failed (probably already unpinned): ${err}`);
      }
      try {
        await platform.deletePost(existingPostId);
        log.debug(`Deleted successfully`);
      } catch (err) {
        // Post might already be deleted, that's fine
        log.debug(`Delete failed (probably already deleted): ${err}`);
      }
      stickyPostIds.delete(platform.platformId);
    }

    // Create new sticky post at the bottom (no threadId = channel post)
    log.debug(`Creating new post...`);
    const post = await platform.createPost(content);
    stickyPostIds.set(platform.platformId, post.id);

    // Pin the post to keep it visible
    try {
      await platform.pinPost(post.id);
      log.debug(`Pinned post successfully`);
    } catch (err) {
      log.debug(`Failed to pin post: ${err}`);
    }

    // Persist the new sticky post ID
    if (sessionStore) {
      sessionStore.saveStickyPostId(platform.platformId, post.id);
    }

    log.info(`📌 Created sticky message for ${platform.platformId}: ${post.id.substring(0, 8)}...`);

    // Clean up any orphaned pinned posts from the bot (in case previous delete failed)
    // This is throttled (max once per 5 min) and only checks recent posts (last hour)
    const botUser = await platform.getBotUser();
    cleanupOldStickyMessages(platform, botUser.id).catch(err => {
      log.debug(`Background cleanup failed: ${err}`);
    });
  } catch (err) {
    log.error(`Failed to update sticky message for ${platform.platformId}`, err instanceof Error ? err : undefined);
  }
}

/**
 * Update sticky messages for all platforms.
 * Called whenever sessions change.
 */
export async function updateAllStickyMessages(
  platforms: Map<string, PlatformClient>,
  sessions: Map<string, Session>,
  config: StickyMessageConfig
): Promise<void> {
  const updates = [...platforms.values()].map(platform =>
    updateStickyMessage(platform, sessions, config)
  );
  await Promise.all(updates);
}

/**
 * Get the sticky post ID for a platform (for persistence).
 */
export function getStickyPostId(platformId: string): string | undefined {
  return stickyPostIds.get(platformId);
}

/**
 * Set the sticky post ID for a platform (for restoration after restart).
 */
export function setStickyPostId(platformId: string, postId: string): void {
  stickyPostIds.set(platformId, postId);
}

/**
 * Get all sticky post IDs (for persistence).
 */
export function getAllStickyPostIds(): Map<string, string> {
  return new Map(stickyPostIds);
}

/**
 * Restore sticky post IDs from persistence.
 */
export function restoreStickyPostIds(postIds: Map<string, string>): void {
  for (const [platformId, postId] of postIds) {
    stickyPostIds.set(platformId, postId);
  }
}

/**
 * Mark that a platform needs to bump its sticky message to the bottom.
 * Called when someone posts in the channel (not in a thread).
 */
export function markNeedsBump(platformId: string): void {
  needsBump.set(platformId, true);
}

/**
 * Check if a post ID represents a recent post (within CLEANUP_MAX_AGE_MS).
 * Works for both Slack (timestamp like "1767720773.723249") and Mattermost (alphanumeric IDs).
 * For Mattermost, we can't determine age from ID, so we always return true to check it.
 */
function isRecentPost(postId: string): boolean {
  // Try to parse as Slack timestamp (seconds.microseconds)
  const match = postId.match(/^(\d+)\.\d+$/);
  if (match) {
    const postTimestamp = parseInt(match[1], 10) * 1000; // Convert to milliseconds
    const age = Date.now() - postTimestamp;
    return age < CLEANUP_MAX_AGE_MS;
  }
  // For non-Slack IDs, we can't determine age, so assume recent
  return true;
}

/**
 * Clean up old pinned sticky messages from the bot.
 * Unpins and deletes any pinned posts from the bot except the current sticky.
 *
 * Optimizations:
 * - Throttled: only runs once per CLEANUP_THROTTLE_MS per platform
 * - Filters by age: only checks posts from the last CLEANUP_MAX_AGE_MS
 * - Skips known current sticky
 *
 * @param forceRun - If true, bypasses throttle (used at startup)
 */
export async function cleanupOldStickyMessages(
  platform: PlatformClient,
  botUserId: string,
  forceRun = false
): Promise<void> {
  const platformId = platform.platformId;
  const now = Date.now();

  // Check throttle (unless forced)
  if (!forceRun) {
    const lastRun = lastCleanupTime.get(platformId) || 0;
    if (now - lastRun < CLEANUP_THROTTLE_MS) {
      log.debug(`Cleanup throttled for ${platformId} (last run ${Math.round((now - lastRun) / 1000)}s ago)`);
      return;
    }
  }

  // Update last cleanup time
  lastCleanupTime.set(platformId, now);

  const currentStickyId = stickyPostIds.get(platformId);

  try {
    // Get all pinned posts in the channel
    const pinnedPostIds = await platform.getPinnedPosts();

    // Filter to only recent posts (reduces API calls significantly)
    const recentPinnedIds = pinnedPostIds.filter(id => id !== currentStickyId && isRecentPost(id));

    if (recentPinnedIds.length === 0) {
      log.debug(`No recent pinned posts to check (${pinnedPostIds.length} total, current: ${currentStickyId?.substring(0, 8) || '(none)'})`);
      return;
    }

    log.debug(`Checking ${recentPinnedIds.length} recent pinned posts (of ${pinnedPostIds.length} total)`);

    for (const postId of recentPinnedIds) {
      // Get post details to check if it's from the bot
      try {
        const post = await platform.getPost(postId);
        if (!post) continue;

        // Check if this post is from our bot (match user ID)
        if (post.userId === botUserId) {
          log.debug(`Cleaning up old sticky: ${postId.substring(0, 8)}...`);
          try {
            await platform.unpinPost(postId);
            await platform.deletePost(postId);
            log.info(`🧹 Cleaned up old sticky message: ${postId.substring(0, 8)}...`);
          } catch (err) {
            log.debug(`Failed to cleanup ${postId}: ${err}`);
          }
        }
      } catch (err) {
        // Post might be deleted or inaccessible, skip it
        log.debug(`Could not check post ${postId}: ${err}`);
      }
    }
  } catch (err) {
    log.error(`Failed to cleanup old sticky messages`, err instanceof Error ? err : undefined);
  }
}
