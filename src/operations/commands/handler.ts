/**
 * User commands module
 *
 * Handles user commands like !cd, !invite, !kick, !permissions, !escape, !stop.
 */

import type { Session } from '../../session/types.js';
import { transitionTo } from '../../session/types.js';
import type { SessionContext } from '../session-context/index.js';
import type { ClaudeCliOptions, ClaudeEvent } from '../../claude/cli.js';
import { ClaudeCli } from '../../claude/cli.js';
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { existsSync, statSync } from 'fs';
import { getUpdateInfo } from '../../update-notifier.js';
import { VERSION } from '../../version.js';
import {
  APPROVAL_EMOJIS,
  DENIAL_EMOJIS,
  ALLOW_ALL_EMOJIS,
} from '../../utils/emoji.js';
import {
  collectBugReportContext,
  formatIssueBody,
  generateIssueTitle,
  formatBugPreview,
  checkGitHubCli,
  createGitHubIssue,
  uploadImages,
  type ErrorContext,
} from '../bug-report/index.js';
import type { PlatformFile } from '../../platform/types.js';
import { formatBatteryStatus } from '../../utils/battery.js';
import { formatUptime } from '../../utils/uptime.js';
import { keepAlive } from '../../utils/keep-alive.js';
import { logAndNotify } from '../../utils/error-handler/index.js';
import {
  post,
  postError,
  resetSessionActivity,
  postInteractiveAndRegister,
  updatePost,
  updatePostSuccess,
  updatePostError,
  updatePostCancelled,
} from '../post-helpers/index.js';
import { createLogger } from '../../utils/logger.js';
import { createSessionLog } from '../../utils/session-log.js';
import { formatPullRequestLink } from '../../utils/pr-detector.js';
import { getCurrentBranch, isGitRepository } from '../../git/worktree.js';
import { getClaudeCliVersion } from '../../claude/version-check.js';
import { shortenPath } from '../index.js';
import { getLogFilePath } from '../../persistence/thread-logger.js';
import { quickQuery } from '../../claude/quick-query.js';
import { CHAT_PLATFORM_PROMPT } from '../../session/lifecycle.js';
import { buildSessionContext } from '../../commands/system-prompt-generator.js';

const log = createLogger('commands');
const sessionLog = createSessionLog(log);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Restart Claude CLI with new options.
 * Handles the common pattern of kill -> flush -> create new CLI -> rebind -> start.
 * Returns true on success, false if start failed.
 */
async function restartClaudeSession(
  session: Session,
  cliOptions: ClaudeCliOptions,
  ctx: SessionContext,
  actionName: string
): Promise<boolean> {
  // Stop the current Claude CLI
  ctx.ops.stopTyping(session);
  transitionTo(session, 'restarting');
  session.claude.kill();

  // Flush any pending content
  await ctx.ops.flush(session);

  // Create new Claude CLI
  session.claude = new ClaudeCli(cliOptions);

  // Rebind event handlers (use sessionId which is the composite key)
  session.claude.on('event', (e: ClaudeEvent) => ctx.ops.handleEvent(session.sessionId, e));
  session.claude.on('exit', (code: number) => ctx.ops.handleExit(session.sessionId, code));

  // Start the new Claude CLI
  try {
    session.claude.start();
    return true;
  } catch (err) {
    transitionTo(session, 'active');
    await logAndNotify(err, { action: actionName, session });
    return false;
  }
}

/**
 * Check if user is session owner or globally allowed.
 * Posts warning message if not authorized.
 * Returns true if authorized, false otherwise.
 */
async function requireSessionOwner(
  session: Session,
  username: string,
  action: string
): Promise<boolean> {
  if (session.startedBy !== username && !session.platform.isUserAllowed(username)) {
    const formatter = session.platform.getFormatter();
    await post(session, 'warning', `Only ${formatter.formatUserMention(session.startedBy)} or allowed users can ${action}`);
    sessionLog(session).warn(`Unauthorized: @${username} tried to ${action}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a visual progress bar for context usage
 * @param percent - Percentage of context used (0-100)
 * @returns A visual bar like "▓▓▓▓░░░░░░" with color indication
 */
function formatContextBar(percent: number): string {
  const totalBlocks = 10;
  // Clamp filledBlocks to [0, totalBlocks] to handle >100% usage
  const filledBlocks = Math.min(totalBlocks, Math.max(0, Math.round((percent / 100) * totalBlocks)));
  const emptyBlocks = totalBlocks - filledBlocks;

  // Use different indicators based on usage level
  let indicator: string;
  if (percent < 50) {
    indicator = '🟢';  // Green - plenty of context
  } else if (percent < 75) {
    indicator = '🟡';  // Yellow - moderate usage
  } else if (percent < 90) {
    indicator = '🟠';  // Orange - getting full
  } else {
    indicator = '🔴';  // Red - almost full
  }

  const filled = '▓'.repeat(filledBlocks);
  const empty = '░'.repeat(emptyBlocks);

  return `${indicator}${filled}${empty}`;
}

// ---------------------------------------------------------------------------
// Session control commands
// ---------------------------------------------------------------------------

/**
 * Cancel a session completely (like !stop or ❌ reaction).
 */
export async function cancelSession(
  session: Session,
  username: string,
  ctx: SessionContext
): Promise<void> {
  sessionLog(session).info(`🛑 Cancelled by @${username}`);
  session.threadLogger?.logCommand('stop', undefined, username);

  // Mark as cancelling BEFORE killing to prevent re-persistence in handleExit
  transitionTo(session, 'cancelling');

  const formatter = session.platform.getFormatter();
  await post(session, 'cancelled', `${formatter.formatBold('Session cancelled')} by ${formatter.formatUserMention(username)}`);

  await ctx.ops.killSession(session.threadId);
}

/**
 * Interrupt current processing but keep session alive (like !escape or ⏸️).
 */
export async function interruptSession(
  session: Session,
  username: string
): Promise<void> {
  if (!session.claude.isRunning()) {
    await post(session, 'info', `Session is idle, nothing to interrupt`);
    sessionLog(session).debug(`Interrupt requested but session is idle`);
    return;
  }

  // Set interrupted state BEFORE interrupt - if Claude exits due to SIGINT, we won't unpersist
  transitionTo(session, 'interrupted');
  const interrupted = session.claude.interrupt();

  if (interrupted) {
    sessionLog(session).info(`⏸️ Interrupted by @${username}`);
    session.threadLogger?.logCommand('escape', undefined, username);
    const formatter = session.platform.getFormatter();
    await post(session, 'interrupt', `${formatter.formatBold('Interrupted')} by ${formatter.formatUserMention(username)}`);
  }
}

/**
 * Approve a pending plan via text command (alternative to 👍 reaction).
 * This is useful when the emoji reaction doesn't work reliably.
 */
export async function approvePendingPlan(
  session: Session,
  username: string,
  ctx: SessionContext
): Promise<void> {
  // Check if there's a pending plan approval
  const pendingApproval = session.messageManager?.getPendingApproval();
  if (!pendingApproval || pendingApproval.type !== 'plan') {
    await post(session, 'info', `No pending plan to approve`);
    sessionLog(session).debug(`Approve requested but no pending plan`);
    return;
  }

  const { postId } = pendingApproval;
  sessionLog(session).info(`✅ Plan approved by @${username} via command`);

  // Update the post to show the decision
  const formatter = session.platform.getFormatter();
  const statusMessage = `${formatter.formatBold('Plan approved')} by ${formatter.formatUserMention(username)} - starting implementation...`;
  await updatePostSuccess(session, postId, statusMessage);

  // Clear pending approval and mark as approved
  session.messageManager?.clearPendingApproval();
  // Also clear any stale questions from plan mode - they're no longer relevant
  session.messageManager?.clearPendingQuestionSet();
  session.planApproved = true;

  // Send user message to Claude - NOT a tool_result
  // Claude Code CLI handles ExitPlanMode internally (generating its own tool_result),
  // so we can't send another tool_result. Instead, send a user message to continue.
  if (session.claude.isRunning()) {
    session.claude.sendMessage('Plan approved! Please proceed with the implementation.');
    ctx.ops.startTyping(session);
  }
}

// ---------------------------------------------------------------------------
// Directory management
// ---------------------------------------------------------------------------

/**
 * Generate a summary of the work done in the current session.
 * Used to preserve context when changing directories or creating worktrees.
 */
export async function generateWorkSummary(session: Session): Promise<string | undefined> {
  // Get recent thread history to summarize
  try {
    const messages = await session.platform.getThreadHistory(
      session.threadId,
      { limit: 20, excludeBotMessages: false }
    );

    if (messages.length === 0) {
      return undefined;
    }

    // Format messages for the summary prompt
    const conversationText = messages
      .map(m => `${m.username}: ${m.message.substring(0, 500)}`)
      .join('\n');

    const summaryPrompt = `Summarize the following conversation in 2-3 sentences. Focus on what work was done, what was accomplished, and any important context that would be useful when continuing in a different directory:

${conversationText}

Summary:`;

    const result = await quickQuery({
      prompt: summaryPrompt,
      model: 'haiku',
      timeout: 10000,
      workingDir: session.workingDir,
    });

    if (result.success && result.response) {
      sessionLog(session).debug(`Generated work summary: ${result.response.substring(0, 100)}...`);
      return result.response;
    }

    return undefined;
  } catch (err) {
    sessionLog(session).debug(`Failed to generate work summary: ${err}`);
    return undefined;
  }
}

/**
 * Change working directory for a session (restarts Claude CLI).
 */
export async function changeDirectory(
  session: Session,
  newDir: string,
  username: string,
  ctx: SessionContext
): Promise<void> {
  // Only session owner or globally allowed users can change directory
  if (!await requireSessionOwner(session, username, 'change the working directory')) {
    return;
  }

  // Expand ~ to home directory
  const expandedDir = newDir.startsWith('~')
    ? newDir.replace('~', process.env.HOME || '')
    : newDir;

  // Resolve to absolute path
  const absoluteDir = resolve(expandedDir);

  const formatter = session.platform.getFormatter();

  // Check if directory exists
  if (!existsSync(absoluteDir)) {
    await postError(session, `Directory does not exist: ${formatter.formatCode(newDir)}`);
    sessionLog(session).warn(`📂 Directory does not exist: ${newDir}`);
    return;
  }

  if (!statSync(absoluteDir).isDirectory()) {
    await postError(session, `Not a directory: ${formatter.formatCode(newDir)}`);
    sessionLog(session).warn(`📂 Not a directory: ${newDir}`);
    return;
  }

  // Use worktree-aware path shortening if in a worktree
  const worktreeContext = session.worktreeInfo
    ? { path: session.worktreeInfo.worktreePath, branch: session.worktreeInfo.branch }
    : undefined;
  const shortDir = shortenPath(absoluteDir, undefined, worktreeContext);
  sessionLog(session).info(`📂 Changing directory to ${shortDir}`);
  session.threadLogger?.logCommand('cd', absoluteDir, username);

  // Generate summary of previous work before switching directories
  // This runs in parallel with directory validation (which is already done)
  const previousDir = session.workingDir;
  const workSummary = await generateWorkSummary(session);
  if (workSummary) {
    session.previousWorkSummary = workSummary;
    sessionLog(session).debug(`Stored work summary for context preservation`);
  }

  // Update session working directory
  session.workingDir = absoluteDir;

  // Generate new session ID for fresh start in new directory
  const newSessionId = randomUUID();
  session.claudeSessionId = newSessionId;

  // Build system prompt with platform context for the new directory
  const sessionContext = buildSessionContext(session.platform, absoluteDir);
  const appendSystemPrompt = `${sessionContext}\n\n${CHAT_PLATFORM_PROMPT}`;

  const cliOptions: ClaudeCliOptions = {
    workingDir: absoluteDir,
    threadId: session.threadId,
    skipPermissions: ctx.config.skipPermissions || !session.forceInteractivePermissions,
    sessionId: newSessionId,
    resume: false, // Fresh start - can't resume across directories
    chrome: ctx.config.chromeEnabled,
    platformConfig: session.platform.getMcpConfig(),
    appendSystemPrompt,  // Include platform context and commands
    logSessionId: session.sessionId,  // Route logs to session panel
    permissionTimeoutMs: ctx.config.permissionTimeoutMs,
  };

  // Restart Claude with new options
  const success = await restartClaudeSession(session, cliOptions, ctx, 'Restart Claude for directory change');
  if (!success) return;

  // Update session header with new directory
  await updateSessionHeader(session, ctx);

  // Build confirmation message with context info
  let confirmationMsg = `${formatter.formatBold('Working directory changed')} to ${formatter.formatCode(shortDir)}\n`;
  confirmationMsg += `${formatter.formatItalic(`Claude Code restarted in new directory (from ${shortenPath(previousDir)})`)}`;
  if (workSummary) {
    confirmationMsg += `\n\n${formatter.formatBold('Previous context preserved:')} ${workSummary.substring(0, 150)}${workSummary.length > 150 ? '...' : ''}`;
  }

  // Post confirmation
  await post(session, 'command', confirmationMsg);

  // Reset activity and clear timeout tracking (prevents updating stale posts in long threads)
  resetSessionActivity(session);

  // Mark session to offer context prompt on next message
  // This allows the user to include thread history after directory change
  session.needsContextPromptOnNextMessage = true;

  // Persist the updated session state
  ctx.ops.persistSession(session);
}

// ---------------------------------------------------------------------------
// User collaboration commands
// ---------------------------------------------------------------------------

/**
 * Invite a user to participate in a session.
 */
export async function inviteUser(
  session: Session,
  invitedUser: string,
  invitedBy: string,
  ctx: SessionContext
): Promise<void> {
  // Only session owner or globally allowed users can invite
  if (!await requireSessionOwner(session, invitedBy, 'invite others')) {
    return;
  }

  // Validate that the user exists on the platform
  const user = await session.platform.getUserByUsername(invitedUser);
  const formatter = session.platform.getFormatter();
  if (!user) {
    await post(session, 'warning', `User ${formatter.formatUserMention(invitedUser)} does not exist on this platform`);
    sessionLog(session).warn(`👋 User @${invitedUser} not found`);
    return;
  }

  session.sessionAllowedUsers.add(invitedUser);
  await post(session, 'success', `${formatter.formatUserMention(invitedUser)} can now participate in this session (invited by ${formatter.formatUserMention(invitedBy)})`);
  sessionLog(session).info(`👋 @${invitedUser} invited by @${invitedBy}`);
  session.threadLogger?.logCommand('invite', invitedUser, invitedBy);
  await updateSessionHeader(session, ctx);
  ctx.ops.persistSession(session);
}

/**
 * Kick a user from a session.
 */
export async function kickUser(
  session: Session,
  kickedUser: string,
  kickedBy: string,
  ctx: SessionContext
): Promise<void> {
  // Only session owner or globally allowed users can kick
  if (!await requireSessionOwner(session, kickedBy, 'kick others')) {
    return;
  }

  // Validate that the user exists on the platform
  const user = await session.platform.getUserByUsername(kickedUser);
  const formatter = session.platform.getFormatter();
  if (!user) {
    await post(session, 'warning', `User ${formatter.formatUserMention(kickedUser)} does not exist on this platform`);
    sessionLog(session).warn(`🚫 User @${kickedUser} not found`);
    return;
  }

  // Can't kick session owner
  if (kickedUser === session.startedBy) {
    await post(session, 'warning', `Cannot kick session owner ${formatter.formatUserMention(session.startedBy)}`);
    sessionLog(session).warn(`🚫 Cannot kick session owner @${session.startedBy}`);
    return;
  }

  // Can't kick globally allowed users
  if (session.platform.isUserAllowed(kickedUser)) {
    await post(session, 'warning', `${formatter.formatUserMention(kickedUser)} is globally allowed and cannot be kicked from individual sessions`);
    sessionLog(session).warn(`🚫 Cannot kick globally allowed user @${kickedUser}`);
    return;
  }

  if (session.sessionAllowedUsers.delete(kickedUser)) {
    await post(session, 'user', `${formatter.formatUserMention(kickedUser)} removed from this session by ${formatter.formatUserMention(kickedBy)}`);
    sessionLog(session).info(`🚫 @${kickedUser} kicked by @${kickedBy}`);
    session.threadLogger?.logCommand('kick', kickedUser, kickedBy);
    await updateSessionHeader(session, ctx);
    ctx.ops.persistSession(session);
  } else {
    await post(session, 'warning', `${formatter.formatUserMention(kickedUser)} was not in this session`);
    sessionLog(session).warn(`🚫 @${kickedUser} was not in session`);
  }
}

// ---------------------------------------------------------------------------
// Permission management
// ---------------------------------------------------------------------------

/**
 * Enable interactive permissions for a session.
 */
export async function enableInteractivePermissions(
  session: Session,
  username: string,
  ctx: SessionContext
): Promise<void> {
  // Only session owner or globally allowed users can change permissions
  if (!await requireSessionOwner(session, username, 'change permissions')) {
    return;
  }

  // Can only downgrade, not upgrade
  if (!ctx.config.skipPermissions) {
    await post(session, 'info', `Permissions are already interactive for this session`);
    sessionLog(session).debug(`🔐 Permissions already interactive (global setting)`);
    return;
  }

  // Already enabled for this session
  if (session.forceInteractivePermissions) {
    await post(session, 'info', `Interactive permissions already enabled for this session`);
    sessionLog(session).debug(`🔐 Permissions already interactive (session override)`);
    return;
  }

  // Set the flag
  session.forceInteractivePermissions = true;

  sessionLog(session).info(`🔐 Enabling interactive permissions`);
  session.threadLogger?.logCommand('permissions', 'interactive', username);

  // Create new CLI options with interactive permissions
  const cliOptions: ClaudeCliOptions = {
    workingDir: session.workingDir,
    threadId: session.threadId,
    skipPermissions: false, // Force interactive permissions
    sessionId: session.claudeSessionId,
    resume: true, // Resume to keep conversation context
    chrome: ctx.config.chromeEnabled,
    platformConfig: session.platform.getMcpConfig(),
    logSessionId: session.sessionId,  // Route logs to session panel
    permissionTimeoutMs: ctx.config.permissionTimeoutMs,
  };

  // Restart Claude with new options
  const success = await restartClaudeSession(session, cliOptions, ctx, 'Enable interactive permissions');
  if (!success) return;

  // Update session header with new permission status
  await updateSessionHeader(session, ctx);

  // Post confirmation
  const formatter = session.platform.getFormatter();
  await post(session, 'secure', `${formatter.formatBold('Interactive permissions enabled')} for this session by ${formatter.formatUserMention(username)}\n${formatter.formatItalic('Claude Code restarted with permission prompts')}`);
  sessionLog(session).info(`🔐 Interactive permissions enabled by @${username}`);

  // Reset activity and clear timeout tracking (prevents updating stale posts in long threads)
  resetSessionActivity(session);
  ctx.ops.persistSession(session);
}

// ---------------------------------------------------------------------------
// Message approval
// ---------------------------------------------------------------------------

/**
 * Request approval for a message from an unauthorized user.
 */
export async function requestMessageApproval(
  session: Session,
  username: string,
  message: string,
  ctx: SessionContext
): Promise<void> {
  // If there's already a pending message approval, ignore
  if (session.messageManager?.getPendingMessageApproval()) {
    return;
  }

  // Truncate long messages for display
  const displayMessage = message.length > 200 ? message.substring(0, 200) + '...' : message;

  const formatter = session.platform.getFormatter();
  const approvalMessage =
    `🔒 ${formatter.formatBold(`Message from ${formatter.formatUserMention(username)}`)} needs approval:\n\n` +
    `${formatter.formatBlockquote(displayMessage)}\n\n` +
    `React: 👍 Allow once | ✅ Invite to session | 👎 Deny`;

  const approvalPost = await postInteractiveAndRegister(
    session,
    approvalMessage,
    [APPROVAL_EMOJIS[0], ALLOW_ALL_EMOJIS[0], DENIAL_EMOJIS[0]],
    ctx.ops.registerPost
  );

  session.messageManager?.setPendingMessageApproval({
    postId: approvalPost.id,
    originalMessage: message,
    fromUser: username,
  });
}

// ---------------------------------------------------------------------------
// Session header
// ---------------------------------------------------------------------------

/**
 * Update the session header post with current participants and status.
 */
export async function updateSessionHeader(
  session: Session,
  ctx: SessionContext
): Promise<void> {
  if (!session.sessionStartPostId) return;

  const formatter = session.platform.getFormatter();

  // Use session's working directory (with worktree-aware shortening)
  const worktreeContext = session.worktreeInfo
    ? { path: session.worktreeInfo.worktreePath, branch: session.worktreeInfo.branch }
    : undefined;
  const shortDir = shortenPath(session.workingDir, undefined, worktreeContext);
  // Check session-level permission override
  const isInteractive = !ctx.config.skipPermissions || session.forceInteractivePermissions;
  const permMode = isInteractive ? '🔐 Interactive' : '⚡ Auto';

  // Build participants list (excluding owner)
  const otherParticipants = [...session.sessionAllowedUsers]
    .filter((u) => u !== session.startedBy)
    .map((u) => formatter.formatUserMention(u))
    .join(', ');

  // Build status bar items
  const statusItems: string[] = [];

  // Version info at the start (like sticky message)
  const claudeVersion = getClaudeCliVersion().version;
  const versionStr = claudeVersion ? `v${VERSION} · CLI ${claudeVersion}` : `v${VERSION}`;
  statusItems.push(formatter.formatCode(versionStr));

  // Model and context usage (if available)
  if (session.usageStats) {
    const stats = session.usageStats;
    statusItems.push(formatter.formatCode(`🤖 ${stats.modelDisplayName}`));
    // Calculate context usage percentage (using primary model's context tokens)
    const contextPercent = Math.round((stats.contextTokens / stats.contextWindowSize) * 100);
    const contextBar = formatContextBar(contextPercent);
    statusItems.push(formatter.formatCode(`${contextBar} ${contextPercent}%`));
    // Show cost
    statusItems.push(formatter.formatCode(`💰 $${stats.totalCostUSD.toFixed(2)}`));
  }

  statusItems.push(formatter.formatCode(permMode));

  // Show plan mode status
  if (session.messageManager?.getPendingApproval()?.type === 'plan') {
    statusItems.push(formatter.formatCode('📋 Plan pending'));
  } else if (session.planApproved) {
    statusItems.push(formatter.formatCode('🔨 Implementing'));
  }

  if (ctx.config.chromeEnabled) {
    statusItems.push(formatter.formatCode('🌐 Chrome'));
  }
  if (keepAlive.isActive()) {
    statusItems.push(formatter.formatCode('💓 Keep-alive'));
  }
  const battery = await formatBatteryStatus();
  if (battery) {
    statusItems.push(formatter.formatCode(battery));
  }
  const uptime = formatUptime(session.startedAt);
  statusItems.push(formatter.formatCode(`⏱️ ${uptime}`));

  const statusBar = statusItems.join(' · ');

  // Build key-value items as tuples: [icon, label, value]
  const items: [string, string, string][] = [];

  // Add title and description if available
  if (session.sessionTitle) {
    items.push(['📝', 'Topic', session.sessionTitle]);
  }
  if (session.sessionDescription) {
    items.push(['📄', 'Summary', formatter.formatItalic(session.sessionDescription)]);
  }
  if (session.sessionTags?.length) {
    items.push(['🏷️', 'Tags', session.sessionTags.map(t => formatter.formatCode(t)).join(' ')]);
  }

  items.push(['📂', 'Directory', formatter.formatCode(shortDir)]);
  items.push(['👤', 'Started by', formatter.formatUserMention(session.startedBy)]);

  // Platform indicator (useful when running multi-platform)
  const platformIcon = session.platform.platformType === 'slack' ? '💬' : '📢';
  items.push([platformIcon, 'Platform', session.platform.displayName]);

  // Show worktree info if active, otherwise show git branch if in a git repo
  if (session.worktreeInfo) {
    const shortRepoRoot = session.worktreeInfo.repoRoot.replace(process.env.HOME || '', '~');
    items.push([
      '🌿',
      'Worktree',
      `${formatter.formatCode(session.worktreeInfo.branch)} (from ${formatter.formatCode(shortRepoRoot)})`
    ]);
  } else {
    // Check if we're in a git repository and get the current branch
    const isRepo = await isGitRepository(session.workingDir);
    if (isRepo) {
      const branch = await getCurrentBranch(session.workingDir);
      if (branch) {
        items.push(['🌿', 'Branch', formatter.formatCode(branch)]);
      }
    }
  }

  // Show pull request link if available
  if (session.pullRequestUrl) {
    items.push(['🔗', 'Pull Request', formatPullRequestLink(session.pullRequestUrl, formatter)]);
  }

  if (otherParticipants) {
    items.push(['👥', 'Participants', otherParticipants]);
  }

  items.push(['🆔', 'Session ID', formatter.formatCode(session.claudeSessionId.substring(0, 8))]);

  // Show log file path (sanitized) - use sessionId for the filename
  const logPath = getLogFilePath(session.platform.platformId, session.claudeSessionId);
  const shortLogPath = logPath.replace(process.env.HOME || '', '~');
  items.push(['📋', 'Log File', formatter.formatCode(shortLogPath)]);

  // Check for available updates
  const updateInfo = getUpdateInfo();
  const updateNotice = updateInfo
    ? `> ⚠️ ${formatter.formatBold('Update available:')} v${updateInfo.current} → v${updateInfo.latest} - Run ${formatter.formatCode('bun install -g claude-threads')}\n\n`
    : undefined;

  const msg = [
    updateNotice,
    statusBar,
    '',  // Blank line needed before table for markdown rendering
    formatter.formatKeyValueList(items),
  ].filter(item => item !== null && item !== undefined).join('\n');

  const postId = session.sessionStartPostId;
  await updatePost(session, postId, msg);
}

// ---------------------------------------------------------------------------
// Update commands
// ---------------------------------------------------------------------------

/** Interface for auto-update manager access from commands */
export interface AutoUpdateManagerInterface {
  isEnabled(): boolean;
  hasUpdate(): boolean;
  getUpdateInfo(): { available: boolean; currentVersion: string; latestVersion: string; detectedAt: Date } | undefined;
  getScheduledRestartAt(): Date | null;
  checkNow(): Promise<{ available: boolean; currentVersion: string; latestVersion: string; detectedAt: Date } | null>;
  forceUpdate(): Promise<void>;
  deferUpdate(minutes?: number): void;
  getConfig(): { autoRestartMode: string };
}

/**
 * Check for updates and show status (!update)
 */
export async function showUpdateStatus(
  session: Session,
  updateManager: AutoUpdateManagerInterface | null,
  ctx: SessionContext
): Promise<void> {
  const formatter = session.platform.getFormatter();

  if (!updateManager) {
    await post(session, 'info', `Auto-update is not available`);
    return;
  }

  if (!updateManager.isEnabled()) {
    await post(session, 'info', `Auto-update is disabled in configuration`);
    return;
  }

  // Check for new updates
  const updateInfo = await updateManager.checkNow();

  if (!updateInfo || !updateInfo.available) {
    await post(session, 'success', `${formatter.formatBold('Up to date')} - no updates available`);
    return;
  }

  const scheduledAt = updateManager.getScheduledRestartAt();
  const config = updateManager.getConfig();

  let statusLine: string;
  if (scheduledAt) {
    const secondsRemaining = Math.max(0, Math.round((scheduledAt.getTime() - Date.now()) / 1000));
    statusLine = `Restarting in ${secondsRemaining} seconds`;
  } else {
    statusLine = `Mode: ${config.autoRestartMode}`;
  }

  const message =
    `🔄 ${formatter.formatBold('Update available')}\n\n` +
    `Current: v${updateInfo.currentVersion}\n` +
    `Latest: v${updateInfo.latestVersion}\n` +
    `${statusLine}\n\n` +
    `React: 👍 Update now | 👎 Defer for 1 hour`;

  // Create interactive post with reaction options
  const updatePromptPost = await postInteractiveAndRegister(
    session,
    message,
    [APPROVAL_EMOJIS[0], DENIAL_EMOJIS[0]],
    ctx.ops.registerPost
  );

  // Store pending update prompt for reaction handling
  session.messageManager?.setPendingUpdatePrompt({ postId: updatePromptPost.id });
}

/**
 * Force an immediate update (!update now)
 */
export async function forceUpdateNow(
  session: Session,
  username: string,
  updateManager: AutoUpdateManagerInterface | null
): Promise<void> {
  // Only session owner or globally allowed users can force update
  if (!await requireSessionOwner(session, username, 'force updates')) {
    return;
  }

  const formatter = session.platform.getFormatter();

  if (!updateManager) {
    await post(session, 'warning', `Auto-update is not available`);
    return;
  }

  // Check for updates first (same as !update does) to ensure we have fresh data
  // This fixes the inconsistency where !update finds updates but !update now doesn't
  const updateInfo = await updateManager.checkNow();

  if (!updateInfo || !updateInfo.available) {
    await post(session, 'info', `No update available to install`);
    return;
  }

  await post(session, 'info',
    `🔄 ${formatter.formatBold('Forcing update')} to v${updateInfo.latestVersion} - restarting shortly...\n` +
    formatter.formatItalic('Sessions will resume automatically')
  );

  // This will trigger the update process
  await updateManager.forceUpdate();
}

/**
 * Defer the pending update (!update defer)
 */
export async function deferUpdate(
  session: Session,
  username: string,
  updateManager: AutoUpdateManagerInterface | null
): Promise<void> {
  // Only session owner or globally allowed users can defer updates
  if (!await requireSessionOwner(session, username, 'defer updates')) {
    return;
  }

  const formatter = session.platform.getFormatter();

  if (!updateManager) {
    await post(session, 'warning', `Auto-update is not available`);
    return;
  }

  if (!updateManager.hasUpdate()) {
    await post(session, 'info', `No pending update to defer`);
    return;
  }

  updateManager.deferUpdate(60); // Defer for 1 hour

  await post(session, 'success',
    `⏸️ ${formatter.formatBold('Update deferred')} for 1 hour\n` +
    formatter.formatItalic('Use !update now to apply earlier')
  );
}

// ---------------------------------------------------------------------------
// Bug reporting
// ---------------------------------------------------------------------------

/**
 * Report a bug and create a GitHub issue.
 * Can be triggered by !bug command or by reacting to an error message.
 */
export async function reportBug(
  session: Session,
  description: string | undefined,
  username: string,
  ctx: SessionContext,
  errorContext?: ErrorContext,
  attachedFiles?: PlatformFile[]
): Promise<void> {
  const formatter = session.platform.getFormatter();

  // If no description and no error context, show usage
  if (!description && !errorContext) {
    await post(session, 'info',
      `Usage: ${formatter.formatCode('!bug <description>')}\n` +
      `Example: ${formatter.formatCode('!bug Session crashed when uploading large image')}\n\n` +
      `You can also attach screenshots to the !bug message.\n` +
      `Or react with 🐛 on any error message to report it.`
    );
    return;
  }

  // Check if gh CLI is available first
  const ghStatus = checkGitHubCli();
  if (!ghStatus.installed || !ghStatus.authenticated) {
    await postError(session, ghStatus.error || 'GitHub CLI not configured');
    return;
  }

  // Use error message as description if triggered by reaction
  // At this point either description or errorContext must exist (checked above)
  const bugDescription = description || (errorContext ? `Error: ${errorContext.message.substring(0, 200)}` : 'Unknown error');

  // Collect context
  const context = await collectBugReportContext(session, errorContext);

  // Upload any attached images to Catbox.moe
  let imageUrls: string[] = [];
  let imageErrors: string[] = [];

  const downloadFile = session.platform.downloadFile?.bind(session.platform);
  if (attachedFiles && attachedFiles.length > 0 && downloadFile) {
    // Show upload progress
    await post(session, 'info', `📤 Uploading ${attachedFiles.length} image(s)...`);

    const uploadResults = await uploadImages(
      attachedFiles,
      downloadFile
    );

    imageUrls = uploadResults
      .filter((r): r is typeof r & { url: string } => r.success && typeof r.url === 'string')
      .map(r => r.url);

    imageErrors = uploadResults
      .filter(r => !r.success)
      .map(r => `${r.originalFile.name}: ${r.error}`);
  }

  // Generate issue content (include uploaded images)
  const title = generateIssueTitle(bugDescription);
  const body = formatIssueBody(context, bugDescription, imageUrls);

  // Create preview message
  const preview = formatBugPreview(title, bugDescription, context, imageUrls, imageErrors, formatter);
  const previewMessage = `🐛 ${preview}`;

  // Post preview with approval reactions
  const bugReportPost = await postInteractiveAndRegister(
    session,
    previewMessage,
    [APPROVAL_EMOJIS[0], DENIAL_EMOJIS[0]],
    ctx.ops.registerPost
  );

  // Store pending bug report
  session.messageManager?.setPendingBugReport({
    postId: bugReportPost.id,
    title,
    body,
    userDescription: bugDescription,
    imageUrls,
    imageErrors,
    errorContext,
  });

  sessionLog(session).info(`🐛 Bug report preview created by @${username}: ${title}`);
}

/**
 * Handle approval/denial of a pending bug report.
 * Called via MessageManager callback when user reacts to the preview.
 */
export async function handleBugReportApproval(
  session: Session,
  isApproved: boolean,
  username: string
): Promise<void> {
  // Read from MessageManager (sole source of truth)
  const pending = session.messageManager?.getPendingBugReport();
  if (!pending) return;

  const formatter = session.platform.getFormatter();

  if (isApproved) {
    try {
      // Create the GitHub issue (images are already embedded in the body as URLs)
      const issueUrl = await createGitHubIssue(
        pending.title,
        pending.body,
        session.workingDir
      );

      // Update the approval post to show success
      await updatePostSuccess(session, pending.postId,
        `${formatter.formatBold('Bug report submitted')}: ${issueUrl}`
      );

      sessionLog(session).info(`🐛 Bug report created by @${username}: ${issueUrl}`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await updatePostError(session, pending.postId,
        `${formatter.formatBold('Failed to create bug report')}: ${errorMessage}`
      );
      sessionLog(session).error(`Failed to create bug report: ${errorMessage}`);
    }
  } else {
    // Cancelled
    await updatePostCancelled(session, pending.postId,
      `${formatter.formatBold('Bug report cancelled')} by ${formatter.formatUserMention(username)}`
    );
    sessionLog(session).info(`🐛 Bug report cancelled by @${username}`);
  }

  // Clear pending bug report
  session.messageManager?.clearPendingBugReport();
}
