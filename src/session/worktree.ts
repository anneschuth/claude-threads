/**
 * Git worktree management utilities
 *
 * Handles worktree prompts, creation, switching, and cleanup.
 */

import type { Session } from './types.js';
import type { WorktreeMode } from '../config.js';
import type { PlatformFile } from '../platform/index.js';
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
} from '../git/worktree.js';
import type { ClaudeCliOptions, ClaudeEvent } from '../claude/cli.js';
import { ClaudeCli } from '../claude/cli.js';
import { randomUUID } from 'crypto';
import { withErrorHandling, logAndNotify } from './error-handler.js';
import { postWarning, postError, postSuccess, postInfo, resetSessionActivity, updateLastMessage } from './post-helpers.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('worktree');

/** Get session-scoped logger for routing to correct UI panel */
function sessionLog(session: Session) {
  return log.forSession(session.sessionId);
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

/**
 * Post the worktree prompt message to the user.
 */
export async function postWorktreePrompt(
  session: Session,
  reason: string,
  registerPost: (postId: string, threadId: string) => void
): Promise<void> {
  const formatter = session.platform.getFormatter();
  let message: string;
  switch (reason) {
    case 'uncommitted':
      message = `🌿 ${formatter.formatBold('This repo has uncommitted changes.')}\n` +
        `Reply with a branch name to work in an isolated worktree, or react with ❌ to continue in the main repo.`;
      break;
    case 'concurrent':
      message = `⚠️ ${formatter.formatBold('Another session is already using this repo.')}\n` +
        `Reply with a branch name to work in an isolated worktree, or react with ❌ to continue anyway.`;
      break;
    case 'require':
      message = `🌿 ${formatter.formatBold('This deployment requires working in a worktree.')}\n` +
        `Please reply with a branch name to continue.`;
      break;
    default:
      message = `🌿 ${formatter.formatBold('Would you like to work in an isolated worktree?')}\n` +
        `Reply with a branch name, or react with ❌ to continue in the main repo.`;
  }

  // Create post with ❌ reaction option (except for 'require' mode)
  // Use 'x' emoji name, not Unicode ❌ character
  const reactionOptions = reason === 'require' ? [] : ['x'];
  const post = await session.platform.createInteractivePost(
    message,
    reactionOptions,
    session.threadId
  );

  // Track the post for reaction handling
  session.worktreePromptPostId = post.id;
  registerPost(post.id, session.threadId);
  // Track for jump-to-bottom links
  updateLastMessage(session, post);
}

/**
 * Handle user providing a branch name in response to worktree prompt.
 * Returns true if handled (whether successful or not).
 */
export async function handleWorktreeBranchResponse(
  session: Session,
  branchName: string,
  username: string,
  responsePostId: string,
  createAndSwitch: (threadId: string, branch: string, username: string) => Promise<void>
): Promise<boolean> {
  if (!session.pendingWorktreePrompt) return false;

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

  // Store the response post ID so we can exclude it from context prompt
  session.worktreeResponsePostId = responsePostId;

  // Create and switch to worktree
  await createAndSwitch(session.threadId, branchName, username);
  return true;
}

/**
 * Handle ❌ reaction on worktree prompt - skip worktree and continue in main repo.
 */
export async function handleWorktreeSkip(
  session: Session,
  username: string,
  persistSession: (session: Session) => void,
  offerContextPrompt: (session: Session, queuedPrompt: string, queuedFiles?: PlatformFile[], excludePostId?: string) => Promise<boolean>
): Promise<void> {
  if (!session.pendingWorktreePrompt) return;

  // Only session owner can skip
  if (session.startedBy !== username && !session.platform.isUserAllowed(username)) {
    return;
  }

  // Update the prompt post
  const promptPostId = session.worktreePromptPostId;
  if (promptPostId) {
    await withErrorHandling(
      () => session.platform.updatePost(promptPostId,
        `✅ Continuing in main repo (skipped by @${username})`),
      { action: 'Update worktree prompt', session }
    );
    // Remove the ❌ reaction option since the action is complete
    await withErrorHandling(
      () => session.platform.removeReaction(promptPostId, 'x'),
      { action: 'Remove x reaction from worktree prompt', session }
    );
  }

  // Clear pending state
  session.pendingWorktreePrompt = false;
  session.worktreePromptPostId = undefined;
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
    handleEvent: (sessionId: string, event: ClaudeEvent) => void;
    handleExit: (sessionId: string, code: number) => Promise<void>;
    updateSessionHeader: (session: Session) => Promise<void>;
    flush: (session: Session) => Promise<void>;
    persistSession: (session: Session) => void;
    startTyping: (session: Session) => void;
    stopTyping: (session: Session) => void;
    offerContextPrompt: (session: Session, queuedPrompt: string, queuedFiles?: PlatformFile[], excludePostId?: string) => Promise<boolean>;
    appendSystemPrompt?: string;
    registerPost: (postId: string, threadId: string) => void;
    updateStickyMessage: () => Promise<void>;
    registerWorktreeUser?: (worktreePath: string, sessionId: string) => void;
  }
): Promise<void> {
  // Only session owner or admins can manage worktrees
  if (session.startedBy !== username && !session.platform.isUserAllowed(username)) {
    await postWarning(session, `Only @${session.startedBy} or allowed users can manage worktrees`);
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
    const shortPath = existing.path.replace(process.env.HOME || '', '~');
    const fmt = session.platform.getFormatter();

    // If user explicitly specified this branch inline (via "on branch X" or "!worktree X" in initial message),
    // skip the confirmation prompt and directly join the existing worktree
    if (session.pendingWorktreePrompt) {
      sessionLog(session).info(`🌿 Auto-joining existing worktree ${branch} (user specified inline)`);

      // Update the worktree prompt post
      const worktreePromptId = session.worktreePromptPostId;
      if (worktreePromptId) {
        await withErrorHandling(
          () => session.platform.updatePost(worktreePromptId,
            `✅ Joining existing worktree for ${fmt.formatCode(branch)}`),
          { action: 'Update worktree prompt', session }
        );
        // Remove the ❌ reaction option since the action is complete
        await withErrorHandling(
          () => session.platform.removeReaction(worktreePromptId, 'x'),
          { action: 'Remove x reaction from worktree prompt', session }
        );
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
      // Not the owner since we're joining an existing worktree
      session.isWorktreeOwner = false;

      // Restart Claude CLI in the worktree directory if running
      if (session.claude.isRunning()) {
        options.stopTyping(session);
        session.isRestarting = true;
        session.claude.kill();

        // Flush any pending content
        await options.flush(session);
        session.currentPostId = null;
        session.pendingContent = '';

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
      await postSuccess(session, `${fmt.formatBold('Joined existing worktree')} for branch ${fmt.formatCode(branch)}\n📁 Working directory: ${fmt.formatCode(shortPath)}\n${fmt.formatItalic('Claude Code restarted in the worktree')}`);

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
    const post = await session.platform.createInteractivePost(
      `🌿 ${fmt.formatBold(`Worktree for branch ${fmt.formatCode(branch)} already exists`)} at ${fmt.formatCode(shortPath)}.\n` +
      `React with 👍 to join this worktree, or ❌ to continue in the current directory.`,
      ['+1', 'x'],  // thumbsup and x emoji names
      session.threadId
    );

    // Store the pending prompt for reaction handling
    session.pendingExistingWorktreePrompt = {
      postId: post.id,
      branch,
      worktreePath: existing.path,
      username,
    };

    // Register the post for reaction routing
    options.registerPost(post.id, session.threadId);
    // Track for jump-to-bottom links
    updateLastMessage(session, post);

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
      await withErrorHandling(
        () => session.platform.updatePost(worktreePromptId,
          `✅ Created worktree for \`${branch}\``),
        { action: 'Update worktree prompt', session }
      );
      // Remove the ❌ reaction option since the action is complete
      await withErrorHandling(
        () => session.platform.removeReaction(worktreePromptId, 'x'),
        { action: 'Remove x reaction from worktree prompt', session }
      );
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
    // Mark this session as the owner since we CREATED this worktree
    session.isWorktreeOwner = true;

    // Register this session as using the worktree (for reference counting)
    options.registerWorktreeUser?.(worktreePath, session.sessionId);

    // Update working directory
    session.workingDir = worktreePath;

    // If Claude is already running, restart it in the new directory
    if (session.claude.isRunning()) {
      options.stopTyping(session);
      session.isRestarting = true;
      session.claude.kill();

      // Flush any pending content
      await options.flush(session);
      session.currentPostId = null;
      session.pendingContent = '';

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
    const shortWorktreePath = worktreePath.replace(process.env.HOME || '', '~');
    const fmt = session.platform.getFormatter();
    await postSuccess(session, `${fmt.formatBold('Created worktree')} for branch ${fmt.formatCode(branch)}\n📁 Working directory: ${fmt.formatCode(shortWorktreePath)}\n${fmt.formatItalic('Claude Code restarted in the new worktree')}`);

    // Reset activity and clear timeout tracking (prevents updating stale posts in long threads)
    resetSessionActivity(session);
    options.persistSession(session);

    // Send the initial prompt to the new Claude CLI
    // - If wasPending (worktree prompt at session start): use queuedPrompt
    // - Otherwise (mid-session worktree): use firstPrompt
    // Use offerContextPrompt to allow user to include thread history
    // Exclude the worktree response post from context (it's just the branch name)
    if (session.claude.isRunning()) {
      const excludePostId = session.worktreeResponsePostId;
      if (wasPending && queuedPrompt) {
        await options.offerContextPrompt(session, queuedPrompt, queuedFiles, excludePostId);
      } else if (!wasPending && session.firstPrompt) {
        // Note: firstPrompt doesn't have files stored - this is a mid-session worktree creation
        // Files are only stored with queuedPrompt at session start
        await options.offerContextPrompt(session, session.firstPrompt, undefined, excludePostId);
      }
      // Clear the stored response post ID after use
      session.worktreeResponsePostId = undefined;
    }

    sessionLog(session).info(`🌿 Switched to worktree ${branch} at ${shortWorktreePath}`);
  } catch (err) {
    await logAndNotify(err, { action: 'Create worktree', session });

    // On failure, clear pending state and continue without worktree
    const fmt = session.platform.getFormatter();
    const worktreePromptId = session.worktreePromptPostId;
    if (worktreePromptId) {
      await withErrorHandling(
        () => session.platform.updatePost(worktreePromptId,
          `❌ Failed to create worktree for ${fmt.formatCode(branch)} - continuing in main repo`),
        { action: 'Update worktree prompt after failure', session }
      );
      // Remove the ❌ reaction option since the action is resolved
      await withErrorHandling(
        () => session.platform.removeReaction(worktreePromptId, 'x'),
        { action: 'Remove x reaction from worktree prompt', session }
      );
    }

    // Clear pending state
    const wasPending = session.pendingWorktreePrompt;
    session.pendingWorktreePrompt = false;
    session.worktreePromptPostId = undefined;
    const queuedPrompt = session.queuedPrompt;
    const queuedFiles = session.queuedFiles;
    session.queuedPrompt = undefined;
    session.queuedFiles = undefined;

    // Persist updated state
    options.persistSession(session);

    // Send the queued prompt to Claude without worktree
    if (wasPending && queuedPrompt && session.claude.isRunning()) {
      const excludePostId = session.worktreeResponsePostId;
      await options.offerContextPrompt(session, queuedPrompt, queuedFiles, excludePostId);
      session.worktreeResponsePostId = undefined;
    }
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
    await postWarning(session, `Only @${session.startedBy} or allowed users can manage worktrees`);
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
  // Not the owner since we're switching to (joining) an existing worktree
  session.isWorktreeOwner = false;
}

/**
 * List all worktrees for the current repository.
 */
export async function listWorktreesCommand(session: Session): Promise<void> {
  // Check if we're in a git repo
  const isRepo = await isGitRepository(session.workingDir);
  if (!isRepo) {
    await postError(session, `Current directory is not a git repository`);
    sessionLog(session).warn(`🌿 Not a git repository: ${session.workingDir}`);
    return;
  }

  // Get repo root (either from worktree info or current dir)
  const repoRoot = session.worktreeInfo?.repoRoot || await getRepositoryRoot(session.workingDir);
  const worktrees = await listGitWorktrees(repoRoot);

  if (worktrees.length === 0) {
    await postInfo(session, `No worktrees found for this repository`);
    sessionLog(session).debug(`🌿 No worktrees found`);
    return;
  }

  const shortRepoRoot = repoRoot.replace(process.env.HOME || '', '~');
  const fmt = session.platform.getFormatter();
  let message = `📋 ${fmt.formatBold('Worktrees for')} ${fmt.formatCode(shortRepoRoot)}:\n\n`;

  for (const wt of worktrees) {
    const shortPath = wt.path.replace(process.env.HOME || '', '~');
    const isCurrent = session.workingDir === wt.path;
    const marker = isCurrent ? ' ← current' : '';
    const label = wt.isMain ? '(main repository)' : '';
    message += `• ${fmt.formatCode(wt.branch)} → ${fmt.formatCode(shortPath)} ${label}${marker}\n`;
  }

  await postInfo(session, message);
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
    await postWarning(session, `Only @${session.startedBy} or allowed users can manage worktrees`);
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

    const shortPath = target.path.replace(process.env.HOME || '', '~');
    await postSuccess(session, `Removed worktree \`${target.branch}\` at \`${shortPath}\``);

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
    await postWarning(session, `Only @${session.startedBy} or allowed users can manage worktrees`);
    sessionLog(session).warn(`🌿 Unauthorized: @${username} tried to disable worktree prompts`);
    return;
  }

  session.worktreePromptDisabled = true;
  persistSession(session);

  await postSuccess(session, `Worktree prompts disabled for this session`);
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
    await postWarning(session, `Only @${session.startedBy} or allowed users can manage worktrees`);
    sessionLog(session).warn(`🌿 Unauthorized: @${username} tried to cleanup worktree`);
    return;
  }

  // Check if we're in a worktree
  if (!session.worktreeInfo) {
    await postWarning(session, `Not currently in a worktree. Nothing to clean up.`);
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
    await postWarning(session, `Cannot cleanup: other sessions are still using this worktree`);
    sessionLog(session).info(`🌿 Skipping cleanup - other sessions using worktree`);
    return;
  }

  // Switch to original repo root first
  await postInfo(session, `Switching back to \`${repoRoot}\` before cleanup...`);
  await changeDirectory(session.threadId, repoRoot, username);

  // Clear worktree info from session
  session.worktreeInfo = undefined;
  session.isWorktreeOwner = undefined;

  // Attempt cleanup
  try {
    sessionLog(session).info(`🗑️ Cleaning up worktree: ${worktreePath}`);
    await removeGitWorktree(repoRoot, worktreePath);

    const shortPath = worktreePath.replace(process.env.HOME || '', '~');
    await postSuccess(session, `Cleaned up worktree \`${branch}\` at \`${shortPath}\``);
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
 * @param session - The session that's ending
 * @param hasOtherSessionsUsingWorktree - Callback to check if other sessions use this worktree
 * @returns Result indicating success or failure
 */
export async function cleanupWorktree(
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
