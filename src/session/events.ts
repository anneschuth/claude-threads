/**
 * Claude event handling module
 *
 * Handles events from Claude CLI: assistant messages, tool use,
 * tool results, tasks, questions, and plan approvals.
 */

import type { Session, SessionUsageStats, ModelTokenUsage, ActiveSubagent } from './types.js';
import { getSessionStatus } from './types.js';
import type { ClaudeEvent } from '../claude/cli.js';
import { formatToolUse as sharedFormatToolUse, shortenPath } from '../utils/tool-formatter.js';
import {
  NUMBER_EMOJIS,
  APPROVAL_EMOJIS,
  DENIAL_EMOJIS,
  MINIMIZE_TOGGLE_EMOJIS,
} from '../utils/emoji.js';
import { formatDuration, truncateAtWord } from '../utils/format.js';
import {
  shouldFlushEarly,
  MIN_BREAK_THRESHOLD,
  acquireTaskListLock,
} from './streaming.js';
import { withErrorHandling } from './error-handler.js';
import { resetSessionActivity, updateLastMessage } from './post-helpers.js';
import type { SessionContext } from './context.js';
import { createLogger } from '../utils/logger.js';
import { extractPullRequestUrl } from '../utils/pr-detector.js';
import { changeDirectory, reportBug } from './commands.js';
import { buildWorktreeListMessage } from './worktree.js';
import { trackEvent } from './bug-report.js';
import { parseClaudeCommand, removeCommandFromText, isClaudeAllowedCommand } from '../commands/index.js';
import { postInfo, postError } from './post-helpers.js';

const log = createLogger('events');

/** Get session-scoped logger for routing to correct UI panel */
function sessionLog(session: Session) {
  return log.forSession(session.sessionId);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Metadata extraction configuration
 */
interface MetadataConfig {
  marker: string;       // e.g., 'SESSION_TITLE'
  minLength: number;
  maxLength: number;
  placeholder: string;  // e.g., '<short title>'
}

/**
 * Extract and validate session metadata (title or description) from text.
 * Updates session if valid and different from current value.
 * Returns the text with the marker removed.
 */
function extractAndUpdateMetadata(
  text: string,
  session: Session,
  config: MetadataConfig,
  sessionField: 'sessionTitle' | 'sessionDescription',
  ctx: SessionContext
): string {
  const regex = new RegExp(`\\[${config.marker}:\\s*([^\\]]+)\\]`);
  const match = text.match(regex);

  // Debug: Log extraction attempt for title
  if (sessionField === 'sessionTitle') {
    const textPreview = text.substring(0, 200).replace(/\n/g, '\\n');
    log.forSession(session.sessionId).debug(
      `Title extraction: match=${match ? `"${match[1]}"` : 'null'}, text="${textPreview}${text.length > 200 ? '...' : ''}"`
    );
  }

  if (match) {
    const newValue = match[1].trim();
    // Validate: reject placeholders, too short/long, dots-only
    const isValid = newValue.length >= config.minLength &&
      newValue.length <= config.maxLength &&
      !/^\.+$/.test(newValue) &&
      !/^…+$/.test(newValue) &&
      newValue !== config.placeholder &&
      !newValue.startsWith('...');

    // Debug: Log validation result
    if (sessionField === 'sessionTitle') {
      log.forSession(session.sessionId).debug(
        `Title validation: value="${newValue}", len=${newValue.length}, isValid=${isValid}, current="${session[sessionField]}"`
      );
    }

    if (isValid && newValue !== session[sessionField]) {
      session[sessionField] = newValue;
      log.forSession(session.sessionId).debug(`Setting ${sessionField} to "${newValue}"`);
      // Persist and update UI (async, don't wait)
      ctx.ops.persistSession(session);
      ctx.ops.updateStickyMessage().catch((err) => {
        log.forSession(session.sessionId).error(`Failed to update sticky message: ${err}`);
      });
      ctx.ops.updateSessionHeader(session).catch((err) => {
        log.forSession(session.sessionId).error(`Failed to update session header: ${err}`);
      });
      // Update CLI UI with new title/description
      const updates: Record<string, string> = {};
      if (sessionField === 'sessionTitle') updates.title = newValue;
      if (sessionField === 'sessionDescription') updates.description = newValue;
      ctx.ops.emitSessionUpdate(session.sessionId, updates);
    }
  }

  // Always remove the marker from displayed text (even if validation failed)
  const removeRegex = new RegExp(`\\[${config.marker}:\\s*[^\\]]+\\]\\s*`, 'g');
  return text.replace(removeRegex, '').trim();
}

// Metadata configs for title and description
const TITLE_CONFIG: MetadataConfig = {
  marker: 'SESSION_TITLE',
  minLength: 3,
  maxLength: 50,
  placeholder: '<short title>',
};

const DESCRIPTION_CONFIG: MetadataConfig = {
  marker: 'SESSION_DESCRIPTION',
  minLength: 5,
  maxLength: 100,
  placeholder: '<brief description>',
};

// ---------------------------------------------------------------------------
// Claude command detection
// ---------------------------------------------------------------------------

/**
 * Detect and execute commands from Claude's assistant output.
 * Uses the shared command parser with Claude's allowlist.
 * Returns the text with the command removed (if executed), or original text.
 */
function detectAndExecuteClaudeCommands(
  text: string,
  session: Session,
  ctx: SessionContext
): string {
  const parsed = parseClaudeCommand(text);

  if (parsed && isClaudeAllowedCommand(parsed.command)) {
    sessionLog(session).info(`🤖 Claude executing !${parsed.command} ${parsed.args || ''}`);

    // Execute the command asynchronously
    executeClaudeCommand(session, parsed.command, parsed.args || '', ctx);

    // Remove the command from the displayed text
    return removeCommandFromText(text, parsed);
  }

  return text;
}

/**
 * Execute a command on behalf of Claude.
 * Posts a visibility message and runs the command.
 * For commands that produce output, sends the result back to Claude.
 *
 * Only commands in CLAUDE_ALLOWED_COMMANDS can be executed.
 */
async function executeClaudeCommand(
  session: Session,
  command: string,
  args: string,
  ctx: SessionContext
): Promise<void> {
  const formatter = session.platform.getFormatter();

  // Post visibility message so users can see what Claude is doing
  const worktreeContext = session.worktreeInfo
    ? { path: session.worktreeInfo.worktreePath, branch: session.worktreeInfo.branch }
    : undefined;
  const shortArgs = args ? shortenPath(args, undefined, worktreeContext) : '';
  const visibilityMessage = `🤖 ${formatter.formatBold('Claude executed:')} ${formatter.formatCode(`!${command}${shortArgs ? ' ' + shortArgs : ''}`)}`;

  await withErrorHandling(
    () => session.platform.createPost(visibilityMessage, session.threadId),
    { action: 'Post Claude command visibility', session }
  );

  // Execute the command based on type
  switch (command) {
    case 'cd':
      // Use session owner's permissions
      // Note: This restarts Claude, so no result can be sent back
      await changeDirectory(session, args, session.startedBy, ctx);
      break;

    case 'worktree list': {
      // Get worktree list and send result back to Claude
      const message = await buildWorktreeListMessage(session);
      if (message === null) {
        await postError(session, `Current directory is not a git repository`);
        // Send error back to Claude too
        if (session.claude?.isRunning()) {
          session.claude.sendMessage(`<command-result command="!worktree list">\nError: Current directory is not a git repository\n</command-result>`);
        }
      } else {
        await postInfo(session, message);
        // Send the result back to Claude so it can see the worktree list
        if (session.claude?.isRunning()) {
          // Use plain text version for Claude (strip markdown formatting for clarity)
          const plainMessage = message
            .replace(/\*\*([^*]+)\*\*/g, '$1')  // Remove bold
            .replace(/`([^`]+)`/g, '$1');       // Remove code formatting
          session.claude.sendMessage(`<command-result command="!worktree list">\n${plainMessage}\n</command-result>`);
          sessionLog(session).info(`📤 Sent worktree list result back to Claude`);
        }
      }
      break;
    }

    case 'bug':
      // Claude can report bugs it encounters
      await reportBug(session, args, session.startedBy, ctx);
      break;
  }
}

/**
 * Extract and update pull request URL from text.
 * Unlike title/description, PR URLs are detected from the actual content
 * (not from special markers), as Claude outputs them when running gh pr create.
 *
 * Only updates if we don't already have a PR URL (first one wins).
 */
function extractAndUpdatePullRequest(
  text: string,
  session: Session,
  ctx: SessionContext
): void {
  // Skip if we already have a PR URL
  if (session.pullRequestUrl) return;

  const prUrl = extractPullRequestUrl(text);
  if (prUrl) {
    session.pullRequestUrl = prUrl;
    sessionLog(session).info(`🔗 Detected PR URL: ${prUrl}`);

    // Persist and update UI
    ctx.ops.persistSession(session);
    ctx.ops.updateStickyMessage().catch(() => {});
    ctx.ops.updateSessionHeader(session).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Main event handler
// ---------------------------------------------------------------------------

/**
 * Handle a Claude event from the CLI stream.
 * Routes to appropriate handler based on event type.
 */
export function handleEvent(
  session: Session,
  event: ClaudeEvent,
  ctx: SessionContext
): void {
  // Log raw event to thread logger (first thing, before any processing)
  session.threadLogger?.logEvent(event);

  // Reset activity and clear timeout tracking (prevents updating stale posts in long threads)
  // Note: compactionPostId is NOT cleared here because compaction events come in sequence
  // and we need to preserve the ID between start and completion events
  resetSessionActivity(session);

  // On first meaningful response from Claude, mark session as safe to resume and persist
  // This ensures we don't persist sessions where Claude dies before saving its conversation
  if (!session.hasClaudeResponded && (event.type === 'assistant' || event.type === 'tool_use')) {
    session.hasClaudeResponded = true;
    ctx.ops.persistSession(session);
    // Update UI status from 'starting' to 'active'
    ctx.ops.emitSessionUpdate(session.sessionId, { status: getSessionStatus(session) });
  }

  // Check for special tool uses that need custom handling
  if (event.type === 'assistant') {
    const msg = event.message as {
      content?: Array<{
        type: string;
        name?: string;
        id?: string;
        input?: Record<string, unknown>;
      }>;
    };
    let hasSpecialTool = false;
    for (const block of msg?.content || []) {
      if (block.type === 'tool_use') {
        if (block.name === 'ExitPlanMode') {
          handleExitPlanMode(session, block.id as string, ctx);
          hasSpecialTool = true;
        } else if (block.name === 'TodoWrite') {
          handleTodoWrite(session, block.input as Record<string, unknown>, ctx);
        } else if (block.name === 'Task') {
          handleTaskStart(session, block.id as string, block.input as Record<string, unknown>, ctx);
        } else if (block.name === 'AskUserQuestion') {
          handleAskUserQuestion(session, block.id as string, block.input as Record<string, unknown>, ctx);
          hasSpecialTool = true;
        }
      }
    }
    if (hasSpecialTool) return;
  }

  // Check for tool_result to update subagent status
  if (event.type === 'user') {
    const msg = event.message as {
      content?: Array<{ type: string; tool_use_id?: string; content?: string }>;
    };
    for (const block of msg?.content || []) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const subagent = session.activeSubagents.get(block.tool_use_id);
        if (subagent) {
          handleTaskComplete(session, block.tool_use_id, subagent.postId);
        }
      }
    }
  }

  // Handle compaction events specially - repurpose the "Compacting..." post
  if (event.type === 'system') {
    const e = event as ClaudeEvent & { subtype?: string; status?: string; compact_metadata?: unknown };
    if (e.subtype === 'status' && e.status === 'compacting') {
      handleCompactionStart(session, ctx);
      return; // Don't process further - we've handled this event
    }
    if (e.subtype === 'compact_boundary') {
      handleCompactionComplete(session, e.compact_metadata, ctx);
      return; // Don't process further - we've handled this event
    }
  }

  const formatted = formatEvent(session, event, ctx);
  sessionLog(session).debugJson(`handleEvent: ${event.type}`, event);
  if (formatted) ctx.ops.appendContent(session, formatted);

  // After tool_result events, check if we should flush and start a new post
  // This creates natural message breaks after tool completions
  if (event.type === 'tool_result' &&
      session.currentPostId &&
      session.pendingContent.length > MIN_BREAK_THRESHOLD &&
      shouldFlushEarly(session.pendingContent)) {
    // Flush and clear to start a new post for subsequent content
    ctx.ops.flush(session).then(() => {
      session.currentPostId = null;
      session.pendingContent = '';
    });
  }
}

// ---------------------------------------------------------------------------
// Event formatters
// ---------------------------------------------------------------------------

/**
 * Format a Claude event for display in chat platforms.
 */
function formatEvent(
  session: Session,
  e: ClaudeEvent,
  ctx: SessionContext
): string | null {
  switch (e.type) {
    case 'assistant': {
      const msg = e.message as {
        content?: Array<{
          type: string;
          text?: string;
          thinking?: string;
          name?: string;
          input?: Record<string, unknown>;
        }>;
      };
      const parts: string[] = [];
      for (const block of msg?.content || []) {
        if (block.type === 'text' && block.text) {
          // Filter out <thinking> tags that may appear in text content
          let text = block.text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();

          // Extract and update session title if present
          text = extractAndUpdateMetadata(text, session, TITLE_CONFIG, 'sessionTitle', ctx);

          // Extract and update session description if present
          text = extractAndUpdateMetadata(text, session, DESCRIPTION_CONFIG, 'sessionDescription', ctx);

          // Detect and store pull request URLs
          extractAndUpdatePullRequest(text, session, ctx);

          // Detect and execute Claude commands (e.g., !cd)
          // This allows Claude to change directories when needed
          text = detectAndExecuteClaudeCommands(text, session, ctx);

          if (text) parts.push(text);
        } else if (block.type === 'tool_use' && block.name) {
          const worktreeInfo = session.worktreeInfo ? { path: session.worktreeInfo.worktreePath, branch: session.worktreeInfo.branch } : undefined;
          const formatted = sharedFormatToolUse(block.name, block.input || {}, session.platform.getFormatter(), { detailed: true, worktreeInfo });
          if (formatted) parts.push(formatted);
        } else if (block.type === 'thinking' && block.thinking) {
          // Extended thinking - show abbreviated version in blockquote
          const thinking = block.thinking as string;
          const preview = truncateAtWord(thinking, 200);
          // Use blockquote for better formatting
          const formatter = session.platform.getFormatter();
          parts.push(formatter.formatBlockquote(`💭 ${formatter.formatItalic(preview)}`));
        } else if (block.type === 'server_tool_use' && block.name) {
          // Server-managed tools like web search
          const formatter = session.platform.getFormatter();
          parts.push(
            `🌐 ${formatter.formatBold(block.name)} ${block.input ? JSON.stringify(block.input).substring(0, 50) : ''}`
          );
        }
      }
      return parts.length > 0 ? parts.join('\n\n') : null;
    }
    case 'tool_use': {
      const tool = e.tool_use as { id?: string; name: string; input?: Record<string, unknown> };
      // Track tool start time for elapsed display
      if (tool.id) {
        session.activeToolStarts.set(tool.id, Date.now());
      }
      // Track event for bug reporting context
      trackEvent(session, 'tool_use', tool.name);
      const worktreeInfo = session.worktreeInfo ? { path: session.worktreeInfo.worktreePath, branch: session.worktreeInfo.branch } : undefined;
      return sharedFormatToolUse(tool.name, tool.input || {}, session.platform.getFormatter(), { detailed: true, worktreeInfo }) || null;
    }
    case 'tool_result': {
      const result = e.tool_result as { tool_use_id?: string; is_error?: boolean };
      // Calculate elapsed time
      let elapsed = '';
      if (result.tool_use_id) {
        const startTime = session.activeToolStarts.get(result.tool_use_id);
        if (startTime) {
          const secs = Math.round((Date.now() - startTime) / 1000);
          if (secs >= 3) {
            // Only show if >= 3 seconds
            elapsed = ` (${secs}s)`;
          }
          session.activeToolStarts.delete(result.tool_use_id);
        }
      }
      // Track tool errors for bug reporting context
      if (result.is_error) {
        trackEvent(session, 'tool_error', 'Tool execution failed');
        return `  ↳ ❌ Error${elapsed}`;
      }
      if (elapsed) return `  ↳ ✓${elapsed}`;
      return null;
    }
    case 'result': {
      // Response complete - stop typing and start new post for next message
      ctx.ops.stopTyping(session);
      ctx.ops.flush(session);
      session.currentPostId = null;
      session.pendingContent = '';

      // Mark as no longer processing and update UI
      session.isProcessing = false;
      ctx.ops.emitSessionUpdate(session.sessionId, { status: getSessionStatus(session) });

      // Extract usage stats from result event
      updateUsageStats(session, e, ctx);

      return null;
    }
    case 'system': {
      if (e.subtype === 'error') {
        // Track system errors for bug reporting context
        trackEvent(session, 'system_error', String(e.error).substring(0, 80));
        return `❌ ${e.error}`;
      }
      // Note: Compaction events (status: 'compacting' and compact_boundary) are handled
      // specially in handleEvent to support post repurposing - they never reach here.
      return null;
    }
    case 'user': {
      // Handle local command output (e.g., /context, /cost responses)
      const msg = e.message as { content?: string };
      if (typeof msg?.content === 'string') {
        // Extract content from <local-command-stdout> tags
        const match = msg.content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
        if (match) {
          return match[1].trim();
        }
      }
      return null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Plan mode handling
// ---------------------------------------------------------------------------

/**
 * Handle ExitPlanMode tool use - post approval prompt.
 */
async function handleExitPlanMode(
  session: Session,
  toolUseId: string,
  ctx: SessionContext
): Promise<void> {
  // If already approved in this session, do nothing
  // Claude Code CLI handles ExitPlanMode internally (generating its own tool_result),
  // so we can't send another tool_result - just let the CLI handle it
  if (session.planApproved) {
    sessionLog(session).debug('Plan already approved, letting CLI handle it');
    return;
  }

  // If we already have a pending approval, don't post another one
  if (session.pendingApproval && session.pendingApproval.type === 'plan') {
    sessionLog(session).debug('Plan approval already pending, waiting');
    return;
  }

  // Flush any pending content first
  await ctx.ops.flush(session);
  session.currentPostId = null;
  session.pendingContent = '';

  // Post approval message with reactions
  const formatter = session.platform.getFormatter();
  const message =
    `✅ ${formatter.formatBold('Plan ready for approval')}\n\n` +
    `👍 Approve and start building\n` +
    `👎 Request changes\n\n` +
    formatter.formatItalic('React to respond');

  const post = await session.platform.createInteractivePost(
    message,
    [APPROVAL_EMOJIS[0], DENIAL_EMOJIS[0]],
    session.threadId
  );

  // Register post for reaction routing
  ctx.ops.registerPost(post.id, session.threadId);
  // Track for jump-to-bottom links
  updateLastMessage(session, post);

  // Track this for reaction handling
  // Note: toolUseId is stored but not used - Claude Code CLI handles ExitPlanMode internally,
  // so we send a user message instead of a tool_result when the user approves
  session.pendingApproval = { postId: post.id, type: 'plan', toolUseId };

  // Stop typing while waiting
  ctx.ops.stopTyping(session);
}

// ---------------------------------------------------------------------------
// Task/Todo handling
// ---------------------------------------------------------------------------

/**
 * Clean up orphaned task posts in a thread.
 * Task posts are identified by content starting with the task header pattern.
 * Only removes posts that are NOT the current active task post.
 *
 * This handles the case where duplicate task posts exist from:
 * - Previous sessions that weren't properly cleaned up
 * - Race conditions during session resume
 * - Manual deletion and recreation of task posts
 */
async function cleanupOrphanedTaskPosts(
  session: Session,
  currentTaskPostId: string
): Promise<void> {
  try {
    // Get bot user ID to filter messages (only delete bot's own posts)
    const botUser = await session.platform.getBotUser();
    const botUserId = botUser.id;

    // Get recent thread history (limit to avoid scanning entire thread)
    const history = await session.platform.getThreadHistory(session.threadId, { limit: 50 });

    // Pattern to identify task posts: starts with horizontal rule + task emoji
    // Matches: "---\n📋", "___\n📋", "***\n📋", or just "📋" at start
    const taskPostPattern = /^(?:(?:---|___|\*\*\*|—+)\s*\n)?📋/;

    let cleanedCount = 0;
    for (const msg of history) {
      // Skip the current active task post
      if (msg.id === currentTaskPostId) continue;

      // Only delete bot's own posts (never touch user messages)
      if (msg.userId !== botUserId) continue;

      // Skip if not a task post (check content pattern)
      if (!taskPostPattern.test(msg.message)) continue;

      sessionLog(session).info(`Cleaning up orphaned task post ${msg.id.substring(0, 8)}`);

      // Unpin and delete the orphaned post
      await session.platform.unpinPost(msg.id).catch(() => {});
      await session.platform.deletePost(msg.id).catch(() => {});
      cleanedCount++;
    }

    if (cleanedCount > 0) {
      sessionLog(session).info(`Cleaned up ${cleanedCount} orphaned task post(s)`);
    }
  } catch (err) {
    // Don't fail the main operation if cleanup fails
    sessionLog(session).debug(`Task cleanup failed: ${err}`);
  }
}

/**
 * Handle TodoWrite tool use - update task list display.
 *
 * Uses an atomic promise-based lock to prevent race conditions when multiple
 * TodoWrite events are processed concurrently (which happens because
 * handleEvent doesn't await async handlers). The lock ensures that only one
 * call can create/update the task list at a time, preventing duplicate posts.
 */
async function handleTodoWrite(
  session: Session,
  input: Record<string, unknown>,
  ctx: SessionContext
): Promise<void> {
  // Acquire the lock atomically at the start - this prevents race conditions
  // where multiple concurrent calls could both see tasksPostId as null and
  // both proceed to create task posts.
  const releaseLock = await acquireTaskListLock(session);

  try {
    await handleTodoWriteWithLock(session, input, ctx);
  } finally {
    releaseLock();
  }
}

/**
 * Internal implementation of handleTodoWrite, called while holding the lock.
 */
async function handleTodoWriteWithLock(
  session: Session,
  input: Record<string, unknown>,
  ctx: SessionContext
): Promise<void> {
  const todos = input.todos as Array<{
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    activeForm: string;
  }>;

  if (!todos || todos.length === 0) {
    // Clear tasks display if empty
    session.tasksCompleted = true;
    const tasksPostId = session.tasksPostId;
    if (tasksPostId) {
      const formatter = session.platform.getFormatter();
      const completedMsg = `${formatter.formatHorizontalRule()}\n📋 ${formatter.formatStrikethrough('Tasks')} ${formatter.formatItalic('(completed)')}`;
      await withErrorHandling(
        () => session.platform.updatePost(tasksPostId, completedMsg),
        { action: 'Update tasks', session }
      );
      session.lastTasksContent = completedMsg;
      // Unpin completed task post
      await session.platform.unpinPost(tasksPostId).catch(() => {});
    }
    return;
  }

  // Check if all tasks are completed
  const allCompleted = todos.every((t) => t.status === 'completed');
  const wasCompleted = session.tasksCompleted;
  session.tasksCompleted = allCompleted;

  // Unpin task post when all tasks complete
  if (allCompleted && !wasCompleted && session.tasksPostId) {
    await session.platform.unpinPost(session.tasksPostId).catch(() => {});
  }

  // Count progress
  const completed = todos.filter((t) => t.status === 'completed').length;
  const total = todos.length;
  const pct = Math.round((completed / total) * 100);

  // Check if there's an in_progress task and track timing
  const hasInProgress = todos.some((t) => t.status === 'in_progress');
  if (hasInProgress && !session.inProgressTaskStart) {
    session.inProgressTaskStart = Date.now();
  } else if (!hasInProgress) {
    session.inProgressTaskStart = null;
  }

  // Find the current in-progress task for minimized display
  const inProgressTask = todos.find((t) => t.status === 'in_progress');
  let currentTaskText = '';
  if (inProgressTask) {
    let elapsed = '';
    if (session.inProgressTaskStart) {
      const secs = Math.round((Date.now() - session.inProgressTaskStart) / 1000);
      if (secs >= 5) {
        elapsed = ` (${secs}s)`;
      }
    }
    currentTaskText = ` · 🔄 ${inProgressTask.activeForm}${elapsed}`;
  }

  // Build full task list (always computed for lastTasksContent)
  const formatter = session.platform.getFormatter();
  let fullMessage = `${formatter.formatHorizontalRule()}\n📋 ${formatter.formatBold('Tasks')} (${completed}/${total} · ${pct}%)\n\n`;
  for (const todo of todos) {
    let icon: string;
    let text: string;
    switch (todo.status) {
      case 'completed':
        icon = '✅';
        text = formatter.formatStrikethrough(todo.content);
        break;
      case 'in_progress': {
        icon = '🔄';
        // Add elapsed time if we have a start time
        let elapsed = '';
        if (session.inProgressTaskStart) {
          const secs = Math.round((Date.now() - session.inProgressTaskStart) / 1000);
          if (secs >= 5) {
            // Only show if >= 5 seconds
            elapsed = ` (${secs}s)`;
          }
        }
        text = `${formatter.formatBold(todo.activeForm)}${elapsed}`;
        break;
      }
      default:
        // pending
        icon = '○';
        text = todo.content;
    }
    fullMessage += `${icon} ${text}\n`;
  }

  // Save full content for sticky task list feature and expansion
  session.lastTasksContent = fullMessage;

  // Choose display format based on minimized state
  // Minimized: show only progress bar with current task
  // Expanded: show full task list
  const minimizedMessage = `${formatter.formatHorizontalRule()}\n📋 ${formatter.formatBold('Tasks')} (${completed}/${total} · ${pct}%)${currentTaskText} 🔽`;
  const displayMessage = session.tasksMinimized ? minimizedMessage : fullMessage;

  // Update or create tasks post
  // Note: We already hold the lock from handleTodoWrite, so this is safe
  const existingTasksPostId = session.tasksPostId;
  if (existingTasksPostId) {
    // Try to update existing post - if it fails (e.g., post deleted), clear the ID
    const updated = await withErrorHandling(
      () => session.platform.updatePost(existingTasksPostId, displayMessage),
      { action: 'Update tasks', session }
    );
    if (updated === undefined) {
      // Update failed - post may have been deleted. Clear the stale ID.
      sessionLog(session).warn(`Task post ${existingTasksPostId.substring(0, 8)} update failed, will create new one`);
      session.tasksPostId = null;
    }
  }

  // Create new task post if we don't have one (either never had, or cleared above)
  if (!session.tasksPostId) {
    // Create with toggle emoji reaction so users can click to collapse.
    const post = await withErrorHandling(
      () => session.platform.createInteractivePost(
        displayMessage,
        [MINIMIZE_TOGGLE_EMOJIS[0]], // 🔽 arrow_down_small
        session.threadId
      ),
      { action: 'Create tasks post', session }
    );
    if (post) {
      session.tasksPostId = post.id;
      // Register the task post so reaction clicks are routed to this session
      ctx.ops.registerPost(post.id, session.threadId);
      // Track for jump-to-bottom links
      updateLastMessage(session, post);
      // Pin the task post for easy access
      await session.platform.pinPost(post.id).catch(() => {});
      // Clean up any orphaned task posts from previous sessions
      await cleanupOrphanedTaskPosts(session, post.id);
    }
  }
  // Update sticky message with new task progress
  ctx.ops.updateStickyMessage().catch(() => {});
}

// ---------------------------------------------------------------------------
// Subagent display helpers
// ---------------------------------------------------------------------------

/** Update interval for subagent elapsed time (5 seconds) */
const SUBAGENT_UPDATE_INTERVAL_MS = 5000;

/**
 * Format a subagent post with elapsed time and collapsible prompt.
 */
function formatSubagentPost(
  session: Session,
  subagent: ActiveSubagent
): string {
  const formatter = session.platform.getFormatter();
  const elapsed = formatDuration(Date.now() - subagent.startTime);

  // Header with elapsed time
  let header = `🤖 ${formatter.formatBold('Subagent')} ${formatter.formatItalic(`(${subagent.subagentType})`)}`;
  header += subagent.isComplete ? ` ✅ ${elapsed}` : ` ⏳ ${elapsed}`;

  if (subagent.isMinimized) {
    return `${header} 🔽`;
  }

  // Expanded: show prompt
  return `${header}\n📋 ${formatter.formatBold('Prompt:')}\n${formatter.formatBlockquote(subagent.description)}\n🔽`;
}

/**
 * Start the subagent update timer if not already running.
 * Updates all active subagent posts with elapsed time.
 */
function startSubagentUpdateTimer(session: Session): void {
  if (session.subagentUpdateTimer) return;

  session.subagentUpdateTimer = setInterval(() => {
    updateAllSubagentPosts(session);
  }, SUBAGENT_UPDATE_INTERVAL_MS);
}

/**
 * Stop the subagent update timer.
 */
function stopSubagentUpdateTimer(session: Session): void {
  if (session.subagentUpdateTimer) {
    clearInterval(session.subagentUpdateTimer);
    session.subagentUpdateTimer = null;
  }
}

/**
 * Update all active (non-complete) subagent posts with current elapsed time.
 */
async function updateAllSubagentPosts(session: Session): Promise<void> {
  const now = Date.now();

  for (const [_toolUseId, subagent] of session.activeSubagents) {
    // Skip completed subagents and recently updated ones (debounce)
    if (subagent.isComplete) continue;
    if (now - subagent.lastUpdateTime < SUBAGENT_UPDATE_INTERVAL_MS - 500) continue;

    const message = formatSubagentPost(session, subagent);
    await withErrorHandling(
      () => session.platform.updatePost(subagent.postId, message),
      { action: 'Update subagent elapsed time', session }
    );
    subagent.lastUpdateTime = now;
  }
}

/**
 * Handle Task (subagent) start - post status message with toggle emoji.
 */
async function handleTaskStart(
  session: Session,
  toolUseId: string,
  input: Record<string, unknown>,
  ctx: SessionContext
): Promise<void> {
  const description = (input.description as string) || 'Working...';
  const subagentType = (input.subagent_type as string) || 'general';

  // Flush any pending content first to avoid empty continuation messages
  await ctx.ops.flush(session);
  session.currentPostId = null;
  session.pendingContent = '';

  const now = Date.now();

  // Create subagent metadata
  const subagent: ActiveSubagent = {
    postId: '', // Will be set after post creation
    startTime: now,
    description,
    subagentType,
    isMinimized: false, // Start expanded
    isComplete: false,
    lastUpdateTime: now,
  };

  // Format and post initial message with toggle emoji
  const message = formatSubagentPost(session, subagent);
  const post = await withErrorHandling(
    () => session.platform.createInteractivePost(
      message,
      [MINIMIZE_TOGGLE_EMOJIS[0]], // 🔽 toggle (reuses task list emoji)
      session.threadId
    ),
    { action: 'Post subagent status', session }
  );

  if (post) {
    subagent.postId = post.id;
    session.activeSubagents.set(toolUseId, subagent);
    // Track for jump-to-bottom links
    updateLastMessage(session, post);

    // Start update timer if this is the first active subagent
    const hasActiveSubagents = Array.from(session.activeSubagents.values()).some(s => !s.isComplete);
    if (hasActiveSubagents && !session.subagentUpdateTimer) {
      startSubagentUpdateTimer(session);
    }

    // Bump task list to stay below subagent messages
    await ctx.ops.bumpTasksToBottom(session);
  }
}

/**
 * Handle Task (subagent) completion - update status message with final elapsed time.
 */
async function handleTaskComplete(
  session: Session,
  toolUseId: string,
  _postId: string  // Unused - we get postId from the subagent metadata
): Promise<void> {
  const subagent = session.activeSubagents.get(toolUseId);
  if (!subagent) {
    // Fallback for old-style string entries (shouldn't happen after migration)
    return;
  }

  // Mark as complete and update the post with final elapsed time
  subagent.isComplete = true;
  const message = formatSubagentPost(session, subagent);

  await withErrorHandling(
    () => session.platform.updatePost(subagent.postId, message),
    { action: 'Update subagent completion', session }
  );

  // Stop the update timer if no more active subagents
  const hasActiveSubagents = Array.from(session.activeSubagents.values()).some(s => !s.isComplete);
  if (!hasActiveSubagents) {
    stopSubagentUpdateTimer(session);
  }

  // Note: We don't delete from activeSubagents immediately so toggle still works
  // The entry will be cleaned up when the session ends
}

/**
 * Handle a reaction on a subagent post to minimize/expand.
 * State-based: user adds their reaction = minimized, user removes = expanded.
 * Returns true if the toggle was handled, false otherwise.
 */
export async function handleSubagentToggleReaction(
  session: Session,
  postId: string,
  action: 'added' | 'removed'
): Promise<boolean> {
  // Find the subagent by postId
  for (const [_toolUseId, subagent] of session.activeSubagents) {
    if (subagent.postId === postId) {
      // State-based: user adds reaction = minimize, user removes = expand
      const shouldMinimize = action === 'added';

      // Skip if already in desired state
      if (subagent.isMinimized === shouldMinimize) {
        return true;
      }

      subagent.isMinimized = shouldMinimize;
      sessionLog(session).debug(`🔽 Subagent ${subagent.isMinimized ? 'minimized' : 'expanded'} (user ${action} reaction)`);

      // Update the post with new state
      const message = formatSubagentPost(session, subagent);
      await withErrorHandling(
        () => session.platform.updatePost(postId, message),
        { action: 'Update subagent toggle', session }
      );

      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Compaction handling
// ---------------------------------------------------------------------------

/**
 * Handle compaction start - create a dedicated post that we can update later.
 */
async function handleCompactionStart(
  session: Session,
  ctx: SessionContext
): Promise<void> {
  // Flush any pending content first to avoid mixing with compaction message
  await ctx.ops.flush(session);
  session.currentPostId = null;
  session.pendingContent = '';

  // Create the compaction status post
  const formatter = session.platform.getFormatter();
  const message = `🗜️ ${formatter.formatBold('Compacting context...')} ${formatter.formatItalic('(freeing up memory)')}`;
  const post = await withErrorHandling(
    () => session.platform.createPost(message, session.threadId),
    { action: 'Post compaction start', session }
  );

  if (post) {
    session.compactionPostId = post.id;
    // Track for jump-to-bottom links
    updateLastMessage(session, post);
  }
}

/**
 * Handle compaction complete - update the existing compaction post.
 */
async function handleCompactionComplete(
  session: Session,
  compactMetadata: unknown,
  _ctx: SessionContext
): Promise<void> {
  // Build the completion message with metadata
  const metadata = compactMetadata as { trigger?: string; pre_tokens?: number } | undefined;
  const trigger = metadata?.trigger || 'auto';
  const preTokens = metadata?.pre_tokens;
  let info = trigger === 'manual' ? 'manual' : 'auto';
  if (preTokens && preTokens > 0) {
    info += `, ${Math.round(preTokens / 1000)}k tokens`;
  }
  const formatter = session.platform.getFormatter();
  const completionMessage = `✅ ${formatter.formatBold('Context compacted')} ${formatter.formatItalic(`(${info})`)}`;

  if (session.compactionPostId) {
    // Update the existing compaction post
    const postId = session.compactionPostId;
    await withErrorHandling(
      () => session.platform.updatePost(postId, completionMessage),
      { action: 'Update compaction complete', session }
    );
    session.compactionPostId = undefined;
  } else {
    // Fallback: create a new post if we don't have the original
    const post = await withErrorHandling(
      () => session.platform.createPost(completionMessage, session.threadId),
      { action: 'Post compaction complete', session }
    );
    if (post) {
      updateLastMessage(session, post);
    }
  }
}

// ---------------------------------------------------------------------------
// Question handling
// ---------------------------------------------------------------------------

/**
 * Handle AskUserQuestion tool use - start interactive question flow.
 */
async function handleAskUserQuestion(
  session: Session,
  toolUseId: string,
  input: Record<string, unknown>,
  ctx: SessionContext
): Promise<void> {
  // If we already have pending questions, don't start another set
  if (session.pendingQuestionSet) {
    sessionLog(session).debug('Questions already pending, waiting');
    return;
  }

  // Flush any pending content first
  await ctx.ops.flush(session);
  session.currentPostId = null;
  session.pendingContent = '';

  const questions = input.questions as Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;

  if (!questions || questions.length === 0) return;

  // Create a new question set - we'll ask one at a time
  session.pendingQuestionSet = {
    toolUseId,
    currentIndex: 0,
    currentPostId: null,
    questions: questions.map((q) => ({
      header: q.header,
      question: q.question,
      options: q.options,
      answer: null,
    })),
  };

  // Post the first question
  await postCurrentQuestion(session, ctx);

  // Stop typing while waiting for answer
  ctx.ops.stopTyping(session);
}

/**
 * Post the current question in the question set.
 */
export async function postCurrentQuestion(
  session: Session,
  ctx: SessionContext
): Promise<void> {
  if (!session.pendingQuestionSet) return;

  const { currentIndex, questions } = session.pendingQuestionSet;
  if (currentIndex >= questions.length) return;

  const q = questions[currentIndex];
  const total = questions.length;

  // Format the question message
  const formatter = session.platform.getFormatter();
  let message = `❓ ${formatter.formatBold('Question')} ${formatter.formatItalic(`(${currentIndex + 1}/${total})`)}\n`;
  message += `${formatter.formatBold(`${q.header}:`)} ${q.question}\n\n`;
  for (let i = 0; i < q.options.length && i < 4; i++) {
    const emoji = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'][i];
    message += `${emoji} ${formatter.formatBold(q.options[i].label)}`;
    if (q.options[i].description) {
      message += ` - ${q.options[i].description}`;
    }
    message += '\n';
  }

  // Post the question with reaction options
  const reactionOptions = NUMBER_EMOJIS.slice(0, q.options.length);
  const post = await session.platform.createInteractivePost(
    message,
    reactionOptions,
    session.threadId
  );
  session.pendingQuestionSet.currentPostId = post.id;

  // Register post for reaction routing
  ctx.ops.registerPost(post.id, session.threadId);
  // Track for jump-to-bottom links
  updateLastMessage(session, post);
}

// ---------------------------------------------------------------------------
// Usage stats extraction
// ---------------------------------------------------------------------------

/**
 * Result event structure from Claude CLI
 */
interface ResultEvent {
  type: 'result';
  subtype?: string;
  total_cost_usd?: number;
  /** Per-request token usage (accurate for context window calculation) */
  usage?: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
  };
  /** Cumulative billing per model across the session */
  modelUsage?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    contextWindow: number;
    costUSD: number;
  }>;
}

/**
 * Convert model ID to display name
 * e.g., "claude-opus-4-5-20251101" -> "Opus 4.5"
 */
function getModelDisplayName(modelId: string): string {
  // Common model name patterns
  if (modelId.includes('opus-4-5') || modelId.includes('opus-4.5')) return 'Opus 4.5';
  if (modelId.includes('opus-4')) return 'Opus 4';
  if (modelId.includes('opus')) return 'Opus';
  if (modelId.includes('sonnet-4')) return 'Sonnet 4';
  if (modelId.includes('sonnet-3-5') || modelId.includes('sonnet-3.5')) return 'Sonnet 3.5';
  if (modelId.includes('sonnet')) return 'Sonnet';
  if (modelId.includes('haiku-4-5') || modelId.includes('haiku-4.5')) return 'Haiku 4.5';
  if (modelId.includes('haiku')) return 'Haiku';
  // Fallback: extract the model family name
  const match = modelId.match(/claude-(\w+)/);
  return match ? match[1].charAt(0).toUpperCase() + match[1].slice(1) : modelId;
}

/**
 * Extract usage stats from a result event and update session
 */
function updateUsageStats(
  session: Session,
  event: ClaudeEvent,
  ctx: SessionContext
): void {
  const result = event as ResultEvent;

  if (!result.modelUsage) return;

  // Find the primary model (highest cost, usually the main model)
  let primaryModel = '';
  let highestCost = 0;
  let contextWindowSize = 200000; // Default

  const modelUsage: Record<string, ModelTokenUsage> = {};
  let totalTokensUsed = 0;

  for (const [modelId, usage] of Object.entries(result.modelUsage)) {
    modelUsage[modelId] = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      contextWindow: usage.contextWindow,
      costUSD: usage.costUSD,
    };

    // Sum all tokens (for billing display)
    totalTokensUsed += usage.inputTokens + usage.outputTokens +
      usage.cacheReadInputTokens + usage.cacheCreationInputTokens;

    // Track primary model by highest cost
    if (usage.costUSD > highestCost) {
      highestCost = usage.costUSD;
      primaryModel = modelId;
      contextWindowSize = usage.contextWindow;
    }
  }

  // Calculate context tokens from per-request usage (accurate)
  // Falls back to primary model's cumulative tokens if usage not available
  let contextTokens = 0;
  if (result.usage) {
    // Per-request usage: actual tokens in current context window
    contextTokens = result.usage.input_tokens +
      result.usage.cache_creation_input_tokens +
      result.usage.cache_read_input_tokens;
  } else if (primaryModel && result.modelUsage[primaryModel]) {
    // Fallback: estimate from primary model's cumulative billing
    const primary = result.modelUsage[primaryModel];
    contextTokens = primary.inputTokens + primary.cacheReadInputTokens;
  }

  // Create or update usage stats
  const usageStats: SessionUsageStats = {
    primaryModel,
    modelDisplayName: getModelDisplayName(primaryModel),
    contextWindowSize,
    contextTokens,
    totalTokensUsed,
    totalCostUSD: result.total_cost_usd || 0,
    modelUsage,
    lastUpdated: new Date(),
  };

  session.usageStats = usageStats;

  const contextPct = contextWindowSize > 0
    ? Math.round((contextTokens / contextWindowSize) * 100)
    : 0;
  sessionLog(session).info(
    `Updated usage stats: ${usageStats.modelDisplayName}, ` +
    `context ${contextTokens}/${contextWindowSize} (${contextPct}%), ` +
    `$${usageStats.totalCostUSD.toFixed(4)}`
  );

  // Start periodic status bar timer if not already running
  if (!session.statusBarTimer) {
    const STATUS_BAR_UPDATE_INTERVAL = 30000; // 30 seconds
    session.statusBarTimer = setInterval(() => {
      // Only update if session is still active
      if (session.claude.isRunning()) {
        // Try to get more accurate context data from status line
        updateUsageFromStatusLine(session);
        ctx.ops.updateSessionHeader(session).catch(() => {});
      }
    }, STATUS_BAR_UPDATE_INTERVAL);
  }

  // Update status bar with new usage info
  ctx.ops.updateSessionHeader(session).catch(() => {});
}

/**
 * Update usage stats from the status line file if available.
 * This provides more accurate context window usage than result events.
 */
function updateUsageFromStatusLine(session: Session): void {
  const statusData = session.claude.getStatusData();
  if (!statusData) return;

  // Only update if we have existing usage stats
  if (!session.usageStats) return;

  // Use total_input_tokens which represents the cumulative context usage
  // (not current_usage which is just the per-request tokens)
  const contextTokens = statusData.total_input_tokens || 0;

  // Update context tokens if the status line data is newer
  if (statusData.timestamp > session.usageStats.lastUpdated.getTime()) {
    session.usageStats.contextTokens = contextTokens;
    session.usageStats.contextWindowSize = statusData.context_window_size;
    session.usageStats.lastUpdated = new Date(statusData.timestamp);

    // Update model info if available
    if (statusData.model) {
      session.usageStats.primaryModel = statusData.model.id;
      session.usageStats.modelDisplayName = statusData.model.display_name;
    }

    // Update cost if available
    if (statusData.cost) {
      session.usageStats.totalCostUSD = statusData.cost.total_cost_usd;
    }

    const contextPct = session.usageStats.contextWindowSize > 0
      ? Math.round((contextTokens / session.usageStats.contextWindowSize) * 100)
      : 0;
    sessionLog(session).debug(
      `Updated from status line: context ${contextTokens}/${session.usageStats.contextWindowSize} (${contextPct}%)`
    );
  }
}
