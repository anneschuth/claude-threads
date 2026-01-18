/**
 * Git worktree management utilities
 *
 * Handles worktree prompts, creation, switching, and cleanup.
 */

import type { Session } from '../../session/types.js';
import { transitionTo } from '../../session/types.js';
import type { WorktreeMode } from '../../config.js';
import type { PlatformFile } from '../../platform/index.js';
import { suggestBranchNames } from '../suggestions/branch.js';
import {
  isGitRepository,
  getRepositoryRoot,
  hasUncommittedChanges,
  listWorktrees as listGitWorktrees,
  createWorktree as createGitWorktree,
  removeWorktree as removeGitWorktree,
  getWorktreeDir,
  findWorktreeByBranch,
  isValidBranchName,
  writeWorktreeMetadata,
  isValidWorktreePath,
} from '../../git/worktree.js';
import type { ClaudeCliOptions, ClaudeEvent, ContentBlock } from '../../claude/cli.js';
import { ClaudeCli } from '../../claude/cli.js';
import { randomUUID } from 'crypto';
import { logAndNotify } from '../../utils/error-handler/index.js';
import {
  post,
  postError,
  resetSessionActivity,
  postInteractiveAndRegister,
  updatePost,
  updatePostSuccess,
  removeReaction,
} from '../post-helpers/index.js';
import { createLogger } from '../../utils/logger.js';
import { createSessionLog } from '../../utils/session-log.js';
import { shortenPath } from '../index.js';
import type { ThreadMessage } from '../../platform/index.js';

const log = createLogger('worktree');
const sessionLog = createSessionLog(log);

/**
 * Parse git worktree errors and return a user-friendly message.
 * Common errors include:
 * - Branch already checked out in another worktree
 * - Invalid branch name
 * - Permission denied
 * - Disk space issues
 */
function parseWorktreeError(error: unknown): { summary: string; suggestion: string } {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  // Branch already checked out
  if (lowerMessage.includes('already checked out') || lowerMessage.includes('is already checked out')) {
    return {
      summary: 'Branch is already checked out in another worktree',
      suggestion: 'Try a different branch name, or use `!worktree list` to see existing worktrees',
    };
  }

  // Branch already exists as worktree
  if (lowerMessage.includes('already exists')) {
    return {
      summary: 'A worktree or branch with this name already exists',
      suggestion: 'Try a different branch name',
    };
  }

  // Permission denied
  if (lowerMessage.includes('permission denied') || lowerMessage.includes('access denied')) {
    return {
      summary: 'Permission denied when creating worktree directory',
      suggestion: 'Check file system permissions for ~/.claude-threads/worktrees/',
    };
  }

  // Disk space
  if (lowerMessage.includes('no space') || lowerMessage.includes('disk full')) {
    return {
      summary: 'Not enough disk space to create worktree',
      suggestion: 'Free up disk space and try again',
    };
  }

  // Lock file issues
  if (lowerMessage.includes('lock') || lowerMessage.includes('.lock')) {
    return {
      summary: 'Git lock file conflict',
      suggestion: 'Another git operation may be in progress. Wait a moment and try again',
    };
  }

  // Invalid ref / branch not found
  if (lowerMessage.includes('invalid ref') || lowerMessage.includes('not a valid ref')) {
    return {
      summary: 'Invalid branch reference',
      suggestion: 'Make sure the branch name is valid and doesn\'t contain special characters',
    };
  }

  // Generic fallback
  return {
    summary: 'Failed to create worktree',
    suggestion: 'Try a different branch name or check the git repository state',
  };
}

/**
 * Check if we should prompt the user to create a worktree.
 * Returns the reason for prompting, or null if we shouldn't prompt.
 */
export async function shouldPromptForWorktree(
  session: Session,
  worktreeMode: WorktreeMode,
  hasOtherSessionInRepo: (repoRoot: string, excludeThreadId: string) => boolean
): Promise<string | null> {
  // Skip if worktree mode is off
  if (worktreeMode === 'off') return null;

  // Skip if user disabled prompts for this session
  if (session.worktreePromptDisabled) return null;

  // Skip if already in a worktree
  if (session.worktreeInfo) return null;

  // Check if we're in a git repository
  const isRepo = await isGitRepository(session.workingDir);
  if (!isRepo) return null;

  // For 'require' mode, always prompt
  if (worktreeMode === 'require') {
    return 'require';
  }

  // For 'prompt' mode, check conditions
  // Condition 1: uncommitted changes
  const hasChanges = await hasUncommittedChanges(session.workingDir);
  if (hasChanges) return 'uncommitted';

  // Condition 2: another session using the same repo
  const repoRoot = await getRepositoryRoot(session.workingDir);
  const hasConcurrent = hasOtherSessionInRepo(repoRoot, session.threadId);
  if (hasConcurrent) return 'concurrent';

  return null;
}

/** Number emoji names for branch suggestions */
const BRANCH_SUGGESTION_EMOJIS = ['one', 'two', 'three'] as const;

/**
 * Post the worktree prompt message to the user.
 * Fetches branch name suggestions from Claude (Haiku) and displays them.
 */
export async function postWorktreePrompt(
  session: Session,
  reason: string,
  registerPost: (postId: string, threadId: string) => void
): Promise<void> {
  const formatter = session.platform.getFormatter();

  // Fetch branch suggestions if we have the user's message
  let suggestions: string[] = [];
  if (session.queuedPrompt) {
    suggestions = await suggestBranchNames(session.workingDir, session.queuedPrompt);
    sessionLog(session).debug(`🌿 Got ${suggestions.length} branch suggestions`);
  }

  // Build the prompt message
  let message: string;
  switch (reason) {
    case 'uncommitted':
      message = `🌿 ${formatter.formatBold('This repo has uncommitted changes.')}`;
      break;
    case 'concurrent':
      message = `⚠️ ${formatter.formatBold('Another session is already using this repo.')}`;
      break;
    case 'require':
      message = `🌿 ${formatter.formatBold('This deployment requires working in a worktree.')}`;
      break;
    default:
      message = `🌿 ${formatter.formatBold('Would you like to work in an isolated worktree?')}`;
  }

  // Add suggestions if available
  if (suggestions.length > 0) {
    message += `\n\n${formatter.formatBold('Suggested branches:')}\n`;
    const numberEmojis = ['1️⃣', '2️⃣', '3️⃣'];
    suggestions.forEach((branch, i) => {
      message += `${numberEmojis[i]} ${formatter.formatCode(branch)}\n`;
    });
    message += `\nReact with a number to select, type your own name`;
  } else {
    message += `\n\nReply with a branch name`;
  }

  // Add skip option (except for 'require' mode)
  if (reason === 'require') {
    message += ` to continue.`;
  } else {
    message += `, or react with ❌ to skip.`;
  }

  // Build reaction options: number emojis for suggestions + ❌ to skip
  const reactionOptions: string[] = [];
  for (let i = 0; i < suggestions.length; i++) {
    reactionOptions.push(BRANCH_SUGGESTION_EMOJIS[i]);
  }
  if (reason !== 'require') {
    reactionOptions.push('x');
  }

  const worktreePost = await postInteractiveAndRegister(session, message, reactionOptions, registerPost);

  // Track the post for reaction handling
  session.worktreePromptPostId = worktreePost.id;

  // Store suggestions for reaction handling
  if (suggestions.length > 0) {
    session.pendingWorktreeSuggestions = {
      postId: worktreePost.id,
      suggestions,
    };
  }
}

/**
 * Handle a number emoji reaction on the worktree prompt (selecting a suggested branch).
 * Returns true if the reaction was handled, false otherwise.
 */
export async function handleBranchSuggestionReaction(
  session: Session,
  postId: string,
  emojiIndex: number,
  username: string,
  createAndSwitch: (threadId: string, branch: string, username: string) => Promise<void>
): Promise<boolean> {
  const pending = session.pendingWorktreeSuggestions;
  if (!pending || pending.postId !== postId) {
    return false;
  }

  // Only session owner or allowed users can select
  if (session.startedBy !== username && !session.platform.isUserAllowed(username)) {
    return false;
  }

  // Check if the index is valid
  if (emojiIndex < 0 || emojiIndex >= pending.suggestions.length) {
    return false;
  }

  const selectedBranch = pending.suggestions[emojiIndex];
  sessionLog(session).info(`🌿 @${username} selected branch suggestion: ${selectedBranch}`);

  // Clear the suggestions state
  session.pendingWorktreeSuggestions = undefined;

  // Create and switch to the selected branch
  await createAndSwitch(session.threadId, selectedBranch, username);

  return true;
}

/**
 * Handle user providing a branch name in response to worktree prompt.
 * This handles both the initial worktree prompt and the failure retry prompt.
 * Returns true if handled (whether successful or not).
 */
export async function handleWorktreeBranchResponse(
  session: Session,
  branchName: string,
  username: string,
  responsePostId: string,
  createAndSwitch: (threadId: string, branch: string, username: string) => Promise<void>
): Promise<boolean> {
  // Check if we're handling a failure retry prompt or the initial worktree prompt
  const isFailurePrompt = !!session.pendingWorktreeFailurePrompt;

  if (!session.pendingWorktreePrompt && !isFailurePrompt) return false;

  // Only session owner can respond
  if (session.startedBy !== username && !session.platform.isUserAllowed(username)) {
    return false;
  }

  // Validate branch name
  if (!isValidBranchName(branchName)) {
    await postError(session, `Invalid branch name: \`${branchName}\`. Please provide a valid git branch name.`);
    sessionLog(session).warn(`🌿 Invalid branch name: ${branchName}`);
    return true; // We handled it, but need another response
  }

  // Clear failure prompt state if this is a retry
  if (isFailurePrompt) {
    session.pendingWorktreeFailurePrompt = undefined;
  }

  // Store the response post ID so we can exclude it from context prompt
  session.worktreeResponsePostId = responsePostId;

  // Clear suggestions since user typed a custom branch name
  session.pendingWorktreeSuggestions = undefined;

  // Create and switch to worktree
  await createAndSwitch(session.threadId, branchName, username);
  return true;
}

/**
 * Handle ❌ reaction on worktree prompt - skip worktree and continue in main repo.
 * This handles both the initial worktree prompt and the failure retry prompt.
 */
export async function handleWorktreeSkip(
  session: Session,
  username: string,
  persistSession: (session: Session) => void,
  offerContextPrompt: (session: Session, queuedPrompt: string, queuedFiles?: PlatformFile[], excludePostId?: string) => Promise<boolean>
): Promise<void> {
  // Check if we're handling a failure retry prompt or the initial worktree prompt
  const isFailurePrompt = !!session.pendingWorktreeFailurePrompt;

  if (!session.pendingWorktreePrompt && !isFailurePrompt) return;

  // Only session owner can skip
  if (session.startedBy !== username && !session.platform.isUserAllowed(username)) {
    return;
  }

  // Update the prompt post
  const promptPostId = isFailurePrompt
    ? session.pendingWorktreeFailurePrompt?.postId
    : session.worktreePromptPostId;

  if (promptPostId) {
    const message = isFailurePrompt
      ? `Continuing in main repo after worktree failure (by @${username})`
      : `Continuing in main repo (skipped by @${username})`;

    await updatePostSuccess(session, promptPostId, message);
    // Remove the ❌ reaction option since the action is complete
    await removeReaction(session, promptPostId, 'x');
  }

  // Clear pending state
  session.pendingWorktreePrompt = false;
  session.worktreePromptPostId = undefined;
  session.pendingWorktreeFailurePrompt = undefined;
  session.pendingWorktreeSuggestions = undefined;
  const queuedPrompt = session.queuedPrompt;
  const queuedFiles = session.queuedFiles;
  session.queuedPrompt = undefined;
  session.queuedFiles = undefined;

  // Persist updated state
  persistSession(session);

  // Now send the queued message to Claude (with context prompt if thread has history)
  if (queuedPrompt && session.claude.isRunning()) {
    await offerContextPrompt(session, queuedPrompt, queuedFiles);
  }
}

/**
 * Create a new worktree and switch the session to it.
 */
export async function createAndSwitchToWorktree(
  session: Session,
  branch: string,
  username: string,
  options: {
    skipPermissions: boolean;
    chromeEnabled: boolean;
    worktreeMode: WorktreeMode;
    permissionTimeoutMs?: number;
    handleEvent: (sessionId: string, event: ClaudeEvent) => void;
    handleExit: (sessionId: string, code: number) => Promise<void>;
    updateSessionHeader: (session: Session) => Promise<void>;
    flush: (session: Session) => Promise<void>;
    persistSession: (session: Session) => void;
    startTyping: (session: Session) => void;
    stopTyping: (session: Session) => void;
    offerContextPrompt: (session: Session, queuedPrompt: string, queuedFiles?: PlatformFile[], excludePostId?: string) => Promise<boolean>;
    buildMessageContent: (text: string, session: Session, files?: PlatformFile[]) => Promise<string | ContentBlock[]>;
    // Context preservation for mid-session worktree creation
    generateWorkSummary: (session: Session) => Promise<string | undefined>;
    getThreadMessagesForContext: (session: Session, limit: number, excludePostId?: string) => Promise<ThreadMessage[]>;
    formatContextForClaude: (messages: ThreadMessage[], previousWorkSummary?: string) => string;
    appendSystemPrompt?: string;
    registerPost: (postId: string, threadId: string) => void;
    updateStickyMessage: () => Promise<void>;
    registerWorktreeUser?: (worktreePath: string, sessionId: string) => void;
  }
): Promise<void> {
  // Only session owner or admins can manage worktrees
  if (session.startedBy !== username && !session.platform.isUserAllowed(username)) {
    await post(session, 'warning', `Only @${session.startedBy} or allowed users can manage worktrees`);
    sessionLog(session).warn(`🌿 Unauthorized: @${username} tried to manage worktrees`);
    return;
  }

  // Check if we're in a git repo
  const isRepo = await isGitRepository(session.workingDir);
  if (!isRepo) {
    await postError(session, `Current directory is not a git repository`);
    sessionLog(session).warn(`🌿 Not a git repository: ${session.workingDir}`);
    return;
  }

  // Get repo root
  const repoRoot = await getRepositoryRoot(session.workingDir);

  // Check if worktree already exists for this branch
  const existing = await findWorktreeByBranch(repoRoot, branch);
  if (existing && !existing.isMain) {
    const shortPath = shortenPath(existing.path, undefined, { path: existing.path, branch });
    const fmt = session.platform.getFormatter();

    // If user explicitly specified this branch inline (via "on branch X" or "!worktree X" in initial message),
    // skip the confirmation prompt and directly join the existing worktree
    if (session.pendingWorktreePrompt) {
      sessionLog(session).info(`🌿 Auto-joining existing worktree ${branch} (user specified inline)`);

      // Update the worktree prompt post
      const worktreePromptId = session.worktreePromptPostId;
      if (worktreePromptId) {
        await updatePostSuccess(session, worktreePromptId, `Joining existing worktree for ${fmt.formatCode(branch)}`);
        // Remove the ❌ reaction option since the action is complete
        await removeReaction(session, worktreePromptId, 'x');
      }

      // Clear pending worktree prompt state
      const queuedPrompt = session.queuedPrompt;
      const queuedFiles = session.queuedFiles;
      session.pendingWorktreePrompt = false;
      session.worktreePromptPostId = undefined;
      session.queuedPrompt = undefined;
      session.queuedFiles = undefined;

      // Update working directory and worktree info
      session.workingDir = existing.path;
      session.worktreeInfo = {
        repoRoot,
        worktreePath: existing.path,
        branch: existing.branch,
      };
      // Sync to message manager for tool output path shortening
      session.messageManager?.setWorktreeInfo(existing.path, existing.branch);
      // Not the owner since we're joining an existing worktree
      session.isWorktreeOwner = false;

      // Restart Claude CLI in the worktree directory if running
      if (session.claude.isRunning()) {
        options.stopTyping(session);
        transitionTo(session, 'restarting');
        session.claude.kill();

        // Flush any pending content
        await options.flush(session);

        // Generate new session ID for fresh start in new directory
        const newSessionId = randomUUID();
        session.claudeSessionId = newSessionId;

        // Create new CLI with new working directory
        const needsTitlePrompt = !session.sessionTitle;
        const cliOptions: ClaudeCliOptions = {
          workingDir: existing.path,
          threadId: session.threadId,
          skipPermissions: options.skipPermissions || !session.forceInteractivePermissions,
          sessionId: newSessionId,
          resume: false,
          chrome: options.chromeEnabled,
          platformConfig: session.platform.getMcpConfig(),
          appendSystemPrompt: needsTitlePrompt ? options.appendSystemPrompt : undefined,
          logSessionId: session.sessionId,
          permissionTimeoutMs: options.permissionTimeoutMs,
        };
        session.claude = new ClaudeCli(cliOptions);

        // Rebind event handlers
        session.claude.on('event', (e: ClaudeEvent) => options.handleEvent(session.sessionId, e));
        session.claude.on('exit', (code: number) => options.handleExit(session.sessionId, code));

        // Start the new CLI
        session.claude.start();
      }

      // Update session header
      await options.updateSessionHeader(session);

      // Post confirmation
      await post(session, 'success', `${fmt.formatBold('Joined existing worktree')} for branch ${fmt.formatCode(branch)}\n📁 Working directory: ${fmt.formatCode(shortPath)}\n${fmt.formatItalic('Claude Code restarted in the worktree')}`);

      // Reset activity and persist
      resetSessionActivity(session);
      options.persistSession(session);

      // Send the queued prompt to the new Claude CLI
      if (session.claude.isRunning() && queuedPrompt) {
        const excludePostId = session.worktreeResponsePostId;
        await options.offerContextPrompt(session, queuedPrompt, queuedFiles, excludePostId);
        session.worktreeResponsePostId = undefined;
      }

      return;
    }

    // Otherwise, post interactive prompt asking if user wants to join the existing worktree
    const worktreePost = await postInteractiveAndRegister(
      session,
      `🌿 ${fmt.formatBold(`Worktree for branch ${fmt.formatCode(branch)} already exists`)} at ${fmt.formatCode(shortPath)}.\n` +
      `React with 👍 to join this worktree, or ❌ to continue in the current directory.`,
      ['+1', 'x'],  // thumbsup and x emoji names
      options.registerPost
    );

    // Store the pending prompt for reaction handling
    session.messageManager?.setPendingExistingWorktreePrompt({
      postId: worktreePost.id,
      branch,
      worktreePath: existing.path,
      username,
    });

    // Persist the session state and update sticky message
    options.persistSession(session);
    await options.updateStickyMessage();
    return;
  }

  sessionLog(session).info(`🌿 Creating worktree for branch ${branch}`);

  // Generate worktree path
  const worktreePath = getWorktreeDir(repoRoot, branch);

  try {
    // Create the worktree
    await createGitWorktree(repoRoot, branch, worktreePath);

    // Write metadata file for cleanup tracking
    await writeWorktreeMetadata(worktreePath, {
      repoRoot,
      branch,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      sessionId: session.sessionId,
    });

    // Update the prompt post if it exists
    const worktreePromptId = session.worktreePromptPostId;
    if (worktreePromptId) {
      await updatePostSuccess(session, worktreePromptId, `Created worktree for \`${branch}\``);
      // Remove the ❌ reaction option since the action is complete
      await removeReaction(session, worktreePromptId, 'x');
    }

    // Clear pending state
    const wasPending = session.pendingWorktreePrompt;
    session.pendingWorktreePrompt = false;
    session.worktreePromptPostId = undefined;
    const queuedPrompt = session.queuedPrompt;
    const queuedFiles = session.queuedFiles;
    session.queuedPrompt = undefined;
    session.queuedFiles = undefined;

    // Store worktree info
    session.worktreeInfo = {
      repoRoot,
      worktreePath,
      branch,
    };
    // Sync to message manager for tool output path shortening
    session.messageManager?.setWorktreeInfo(worktreePath, branch);
    // Mark this session as the owner since we CREATED this worktree
    session.isWorktreeOwner = true;

    // Register this session as using the worktree (for reference counting)
    options.registerWorktreeUser?.(worktreePath, session.sessionId);

    // Update working directory
    session.workingDir = worktreePath;

    // For mid-session worktree creation, generate work summary BEFORE killing Claude
    // This preserves context about what the user was working on
    let workSummary: string | undefined;
    if (!wasPending && session.claude.isRunning()) {
      workSummary = await options.generateWorkSummary(session);
      if (workSummary) {
        sessionLog(session).debug(`🌿 Generated work summary for worktree context preservation`);
      }
    }

    // If Claude is already running, restart it in the new directory
    if (session.claude.isRunning()) {
      options.stopTyping(session);
      transitionTo(session, 'restarting');
      session.claude.kill();

      // Flush any pending content
      await options.flush(session);

      // Generate new session ID for fresh start in new directory
      // (Claude CLI sessions are tied to working directory, can't resume across directories)
      const newSessionId = randomUUID();
      session.claudeSessionId = newSessionId;

      // Create new CLI with new working directory
      // Include system prompt if session doesn't have a title yet
      // This ensures Claude will generate a title on its next response
      const needsTitlePrompt = !session.sessionTitle;

      const cliOptions: ClaudeCliOptions = {
        workingDir: worktreePath,
        threadId: session.threadId,
        skipPermissions: options.skipPermissions || !session.forceInteractivePermissions,
        sessionId: newSessionId,
        resume: false,  // Fresh start - can't resume across directories
        chrome: options.chromeEnabled,
        platformConfig: session.platform.getMcpConfig(),
        appendSystemPrompt: needsTitlePrompt ? options.appendSystemPrompt : undefined,
        logSessionId: session.sessionId,  // Route logs to session panel
        permissionTimeoutMs: options.permissionTimeoutMs,
      };
      session.claude = new ClaudeCli(cliOptions);

      // Rebind event handlers (use sessionId which is the composite key)
      session.claude.on('event', (e: ClaudeEvent) => options.handleEvent(session.sessionId, e));
      session.claude.on('exit', (code: number) => options.handleExit(session.sessionId, code));

      // Start the new CLI
      session.claude.start();
    }

    // Update session header
    await options.updateSessionHeader(session);

    // Post confirmation
    const shortWorktreePath = shortenPath(worktreePath, undefined, { path: worktreePath, branch });
    const fmt = session.platform.getFormatter();
    await post(session, 'success', `${fmt.formatBold('Created worktree')} for branch ${fmt.formatCode(branch)}\n📁 Working directory: ${fmt.formatCode(shortWorktreePath)}\n${fmt.formatItalic('Claude Code restarted in the new worktree')}`);

    // Reset activity and clear timeout tracking (prevents updating stale posts in long threads)
    resetSessionActivity(session);
    options.persistSession(session);

    // Send the initial prompt to the new Claude CLI
    // - If wasPending (worktree prompt at session start): use offerContextPrompt (user decides on thread context)
    // - Otherwise (mid-session worktree): auto-include ALL context (work summary + thread messages)
    if (session.claude.isRunning()) {
      const excludePostId = session.worktreeResponsePostId;
      if (wasPending && queuedPrompt) {
        // Session start: let user choose how much thread context to include
        await options.offerContextPrompt(session, queuedPrompt, queuedFiles, excludePostId);
      } else if (!wasPending && session.firstPrompt) {
        // Mid-session worktree creation: auto-include ALL context (continuity expected)
        // Get all thread messages for context
        const threadMessages = await options.getThreadMessagesForContext(session, 50, excludePostId);

        // Build context with work summary + all thread messages
        const contextPrefix = options.formatContextForClaude(threadMessages, workSummary);
        const messageToSend = contextPrefix + session.firstPrompt;

        // Build and send the message
        session.messageCount++;
        const content = await options.buildMessageContent(messageToSend, session, undefined);
        session.claude.sendMessage(content);
        options.startTyping(session);

        sessionLog(session).debug(`🌿 Auto-included ${threadMessages.length} messages + work summary for mid-session worktree`);
      }
      // Clear the stored response post ID after use
      session.worktreeResponsePostId = undefined;
    }

    sessionLog(session).info(`🌿 Switched to worktree ${branch} at ${shortWorktreePath}`);
  } catch (err) {
    await logAndNotify(err, { action: 'Create worktree', session });

    const fmt = session.platform.getFormatter();
    const { summary, suggestion } = parseWorktreeError(err);

    // Update the original worktree prompt post if it exists
    const worktreePromptId = session.worktreePromptPostId;
    if (worktreePromptId) {
      await updatePost(session, worktreePromptId, `❌ ${fmt.formatBold(summary)}: ${fmt.formatCode(branch)}`);
      // Remove the ❌ reaction option since we'll show a new prompt
      await removeReaction(session, worktreePromptId, 'x');
    }

    // If worktreeMode is 'require', we can't fall back to main repo - must retry
    if (options.worktreeMode === 'require') {
      // Show error with retry prompt
      const retryPrompt = await postInteractiveAndRegister(
        session,
        `⚠️ ${fmt.formatBold('Worktree required but creation failed')}\n\n` +
        `${suggestion}\n\n` +
        `Reply with a different branch name to try again.`,
        [],  // No skip option in require mode
        options.registerPost
      );

      // Keep pending state but update the prompt post ID
      session.worktreePromptPostId = retryPrompt.id;
      options.persistSession(session);

      sessionLog(session).info(`🌿 Worktree creation failed (require mode), waiting for retry: ${branch}`);
      return;
    }

    // For 'prompt' mode, offer choices: retry with different branch or continue in main repo
    const failurePrompt = await postInteractiveAndRegister(
      session,
      `⚠️ ${fmt.formatBold('Worktree creation failed')}\n\n` +
      `${suggestion}\n\n` +
      `Reply with a different branch name to try again, or react with ❌ to continue in the main repo.`,
      ['x'],  // Allow skipping in prompt mode
      options.registerPost
    );

    // Store pending state for handling the user's response
    session.pendingWorktreeFailurePrompt = {
      postId: failurePrompt.id,
      failedBranch: branch,
      errorMessage: summary,
      username,
    };

    // Keep the worktree prompt in pending state so the session waits for response
    session.worktreePromptPostId = failurePrompt.id;
    options.persistSession(session);

    sessionLog(session).info(`🌿 Worktree creation failed, waiting for user decision: ${branch}`);
  }
}

/**
 * Switch to an existing worktree.
 */
export async function switchToWorktree(
  session: Session,
  branchOrPath: string,
  username: string,
  changeDirectory: (threadId: string, newDir: string, username: string) => Promise<void>
): Promise<void> {
  // Only session owner or admins can manage worktrees
  if (session.startedBy !== username && !session.platform.isUserAllowed(username)) {
    await post(session, 'warning', `Only @${session.startedBy} or allowed users can manage worktrees`);
    sessionLog(session).warn(`🌿 Unauthorized: @${username} tried to switch worktree`);
    return;
  }

  // Get current repo root
  const repoRoot = session.worktreeInfo?.repoRoot || await getRepositoryRoot(session.workingDir);

  // Find the worktree
  const worktrees = await listGitWorktrees(repoRoot);
  const target = worktrees.find(wt =>
    wt.branch === branchOrPath ||
    wt.path === branchOrPath ||
    wt.path.endsWith(branchOrPath)
  );

  if (!target) {
    await postError(session, `Worktree not found: \`${branchOrPath}\`. Use \`!worktree list\` to see available worktrees.`);
    sessionLog(session).warn(`🌿 Worktree not found: ${branchOrPath}`);
    return;
  }

  // Use changeDirectory logic to switch
  await changeDirectory(session.threadId, target.path, username);

  // Update worktree info
  session.worktreeInfo = {
    repoRoot,
    worktreePath: target.path,
    branch: target.branch,
  };
  // Sync to message manager for tool output path shortening
  session.messageManager?.setWorktreeInfo(target.path, target.branch);
  // Not the owner since we're switching to (joining) an existing worktree
  session.isWorktreeOwner = false;
}

/**
 * Build worktree list message for a given working directory (without session).
 * Returns the formatted message or null if not in a git repo.
 */
export async function buildWorktreeListMessageFromDir(
  workingDir: string,
  formatter: import('../../platform/index.js').PlatformFormatter,
  currentWorkingDir?: string
): Promise<string | null> {
  // Check if we're in a git repo
  const isRepo = await isGitRepository(workingDir);
  if (!isRepo) {
    return null;
  }

  // Get repo root
  const repoRoot = await getRepositoryRoot(workingDir);
  const worktrees = await listGitWorktrees(repoRoot);

  if (worktrees.length === 0) {
    return 'No worktrees found for this repository';
  }

  const shortRepoRoot = repoRoot.replace(process.env.HOME || '', '~');
  let message = `📋 ${formatter.formatBold('Worktrees for')} ${formatter.formatCode(shortRepoRoot)}:\n\n`;

  for (const wt of worktrees) {
    // For main repo, keep the regular path; for worktrees, use [branch]/ format
    const shortPath = wt.isMain
      ? wt.path.replace(process.env.HOME || '', '~')
      : shortenPath(wt.path, undefined, { path: wt.path, branch: wt.branch });
    const isCurrent = currentWorkingDir === wt.path;
    const marker = isCurrent ? ' ← current' : '';
    const label = wt.isMain ? '(main repository)' : '';
    message += `• ${formatter.formatCode(wt.branch)} → ${formatter.formatCode(shortPath)} ${label}${marker}\n`;
  }

  return message;
}

/**
 * Build worktree list message (without posting).
 * Returns the formatted message or null if not in a git repo.
 */
export async function buildWorktreeListMessage(session: Session): Promise<string | null> {
  // Use the session-less version with session's data
  const repoRoot = session.worktreeInfo?.repoRoot;

  // Check if we're in a git repo
  const isRepo = await isGitRepository(session.workingDir);
  if (!isRepo) {
    sessionLog(session).warn(`🌿 Not a git repository: ${session.workingDir}`);
    return null;
  }

  // If we have worktreeInfo, use its repoRoot, otherwise use workingDir
  const workingDirForList = repoRoot || session.workingDir;
  return buildWorktreeListMessageFromDir(
    workingDirForList,
    session.platform.getFormatter(),
    session.workingDir
  );
}

/**
 * List all worktrees for the current repository.
 */
export async function listWorktreesCommand(session: Session): Promise<void> {
  const message = await buildWorktreeListMessage(session);

  if (message === null) {
    await postError(session, `Current directory is not a git repository`);
    return;
  }

  await post(session, 'info', message);
}

/**
 * Remove a worktree.
 */
export async function removeWorktreeCommand(
  session: Session,
  branchOrPath: string,
  username: string
): Promise<void> {
  // Only session owner or admins can manage worktrees
  if (session.startedBy !== username && !session.platform.isUserAllowed(username)) {
    await post(session, 'warning', `Only @${session.startedBy} or allowed users can manage worktrees`);
    sessionLog(session).warn(`🌿 Unauthorized: @${username} tried to remove worktree`);
    return;
  }

  // Get current repo root
  const repoRoot = session.worktreeInfo?.repoRoot || await getRepositoryRoot(session.workingDir);

  // Find the worktree
  const worktrees = await listGitWorktrees(repoRoot);
  const target = worktrees.find(wt =>
    wt.branch === branchOrPath ||
    wt.path === branchOrPath ||
    wt.path.endsWith(branchOrPath)
  );

  if (!target) {
    await postError(session, `Worktree not found: \`${branchOrPath}\`. Use \`!worktree list\` to see available worktrees.`);
    sessionLog(session).warn(`🌿 Worktree not found: ${branchOrPath}`);
    return;
  }

  // Can't remove the main repository
  if (target.isMain) {
    await postError(session, `Cannot remove the main repository. Use \`!worktree remove\` only for worktrees.`);
    sessionLog(session).warn(`🌿 Cannot remove main repository`);
    return;
  }

  // Can't remove the current working directory
  if (session.workingDir === target.path) {
    await postError(session, `Cannot remove the current working directory. Switch to another worktree first.`);
    sessionLog(session).warn(`🌿 Cannot remove current directory`);
    return;
  }

  try {
    await removeGitWorktree(repoRoot, target.path);

    const shortPath = shortenPath(target.path, undefined, { path: target.path, branch: target.branch });
    await post(session, 'success', `Removed worktree \`${target.branch}\` at \`${shortPath}\``);

    sessionLog(session).info(`🗑️ Removed worktree ${target.branch} at ${shortPath}`);
  } catch (err) {
    await logAndNotify(err, { action: 'Remove worktree', session });
  }
}

/**
 * Disable worktree prompts for a session.
 */
export async function disableWorktreePrompt(
  session: Session,
  username: string,
  persistSession: (session: Session) => void
): Promise<void> {
  // Only session owner or admins can manage worktrees
  if (session.startedBy !== username && !session.platform.isUserAllowed(username)) {
    await post(session, 'warning', `Only @${session.startedBy} or allowed users can manage worktrees`);
    sessionLog(session).warn(`🌿 Unauthorized: @${username} tried to disable worktree prompts`);
    return;
  }

  session.worktreePromptDisabled = true;
  persistSession(session);

  await post(session, 'success', `Worktree prompts disabled for this session`);
  sessionLog(session).info(`🌿 Worktree prompts disabled`);
}

// ---------------------------------------------------------------------------
// Worktree Cleanup
// ---------------------------------------------------------------------------

/**
 * Result of worktree cleanup attempt
 */
export interface CleanupResult {
  success: boolean;
  error?: string;
}

/**
 * Manually clean up the current session's worktree.
 * Called via !worktree cleanup command.
 *
 * This allows users to explicitly delete their worktree when they're done.
 * The session will be switched back to the original repo root.
 */
export async function cleanupWorktreeCommand(
  session: Session,
  username: string,
  hasOtherSessionsUsingWorktree: (worktreePath: string, excludeSessionId: string) => boolean,
  changeDirectory: (threadId: string, path: string, username: string) => Promise<void>
): Promise<void> {
  // Only session owner or admins can manage worktrees
  if (session.startedBy !== username && !session.platform.isUserAllowed(username)) {
    await post(session, 'warning', `Only @${session.startedBy} or allowed users can manage worktrees`);
    sessionLog(session).warn(`🌿 Unauthorized: @${username} tried to cleanup worktree`);
    return;
  }

  // Check if we're in a worktree
  if (!session.worktreeInfo) {
    await post(session, 'warning', `Not currently in a worktree. Nothing to clean up.`);
    return;
  }

  const { worktreePath, repoRoot, branch } = session.worktreeInfo;

  // Path safety check - must be in ~/.claude-threads/worktrees/
  if (!isValidWorktreePath(worktreePath)) {
    await postError(session, `Cannot cleanup: worktree is not in the centralized location (~/.claude-threads/worktrees/)`);
    sessionLog(session).warn(`🌿 Invalid worktree path for cleanup: ${worktreePath}`);
    return;
  }

  // Check for other sessions using this worktree
  if (hasOtherSessionsUsingWorktree(worktreePath, session.sessionId)) {
    await post(session, 'warning', `Cannot cleanup: other sessions are still using this worktree`);
    sessionLog(session).info(`🌿 Skipping cleanup - other sessions using worktree`);
    return;
  }

  // Switch to original repo root first
  await post(session, 'info', `Switching back to \`${repoRoot}\` before cleanup...`);
  await changeDirectory(session.threadId, repoRoot, username);

  // Clear worktree info from session and message manager
  session.worktreeInfo = undefined;
  session.isWorktreeOwner = undefined;
  session.messageManager?.clearWorktreeInfo();

  // Attempt cleanup
  try {
    sessionLog(session).info(`🗑️ Cleaning up worktree: ${worktreePath}`);
    await removeGitWorktree(repoRoot, worktreePath);

    const shortPath = shortenPath(worktreePath, undefined, { path: worktreePath, branch });
    await post(session, 'success', `Cleaned up worktree \`${branch}\` at \`${shortPath}\``);
    sessionLog(session).info(`✅ Worktree cleaned up successfully`);
  } catch (err) {
    await logAndNotify(err, { action: 'Cleanup worktree', session });
  }
}

/**
 * Clean up a worktree when a session ends.
 *
 * Cleanup only happens when:
 * - Session has a worktree
 * - Session is the worktree owner (created it, not joined)
 * - No other sessions are using the worktree
 * - Worktree path is in the centralized location
 *
 * Note: This is an internal helper called via cleanupWorktreeCommand.
 * Not exported from the module index.
 *
 * @param session - The session that's ending
 * @param hasOtherSessionsUsingWorktree - Callback to check if other sessions use this worktree
 * @returns Result indicating success or failure
 */
async function cleanupWorktree(
  session: Session,
  hasOtherSessionsUsingWorktree: (worktreePath: string, excludeSessionId: string) => boolean
): Promise<CleanupResult> {
  // Check preconditions
  if (!session.worktreeInfo) {
    return { success: true };
  }

  if (!session.isWorktreeOwner) {
    sessionLog(session).debug('Skipping cleanup - session is not worktree owner');
    return { success: true };
  }

  const { worktreePath, repoRoot } = session.worktreeInfo;

  // Path safety check - must be in ~/.claude-threads/worktrees/
  if (!isValidWorktreePath(worktreePath)) {
    sessionLog(session).warn(`Invalid worktree path, skipping cleanup: ${worktreePath}`);
    return { success: false, error: 'Invalid path pattern - not in centralized worktrees directory' };
  }

  // Check for other sessions using this worktree
  if (hasOtherSessionsUsingWorktree(worktreePath, session.sessionId)) {
    sessionLog(session).info('Skipping cleanup - other sessions using worktree');
    return { success: true };
  }

  // Attempt cleanup
  try {
    sessionLog(session).info(`🗑️ Cleaning up worktree: ${worktreePath}`);
    await removeGitWorktree(repoRoot, worktreePath);
    sessionLog(session).info(`✅ Worktree cleaned up successfully`);
    return { success: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    sessionLog(session).warn(`Worktree cleanup failed: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }
}

// Export for testing only (not re-exported from worktree/index.ts)
export { cleanupWorktree };
