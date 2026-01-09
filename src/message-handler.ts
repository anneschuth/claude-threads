/**
 * Message Handler Module
 *
 * Extracted from index.ts to allow reuse in both the main bot and integration tests.
 * This ensures tests exercise the actual bot logic, not a duplicate.
 */

import type { PlatformClient, PlatformPost, PlatformUser } from './platform/index.js';
import type { SessionManager } from './session/index.js';
import { VERSION } from './version.js';
import { getReleaseNotes, formatReleaseNotes } from './changelog.js';
import { parseCommand } from './commands/index.js';

/**
 * Logger interface for message handler
 */
export interface MessageHandlerLogger {
  error(message: string): void;
  debug?(message: string): void;
}

/**
 * Options for message handler
 */
export interface MessageHandlerOptions {
  platformId: string;
  logger?: MessageHandlerLogger;
  /**
   * Called when !kill command is executed. In production this calls process.exit(1).
   * In tests this can just disconnect without exiting.
   */
  onKill?: (username: string) => void;
}

/**
 * Handle an incoming message from a platform.
 *
 * This is the core message handling logic extracted from index.ts.
 * Both the main bot and integration tests use this same code.
 */
export async function handleMessage(
  client: PlatformClient,
  session: SessionManager,
  post: PlatformPost,
  user: PlatformUser | null,
  options: MessageHandlerOptions
): Promise<void> {
  const { platformId, logger, onKill } = options;
  const username = user?.username || 'unknown';
  const message = post.message;
  const threadRoot = post.rootId || post.id;
  const formatter = client.getFormatter();

  try {
    // Check for !kill command (emergency shutdown)
    const lowerMessage = message.trim().toLowerCase();
    if (
      lowerMessage === '!kill' ||
      (client.isBotMentioned(message) && client.extractPrompt(message).toLowerCase() === '!kill')
    ) {
      if (!client.isUserAllowed(username)) {
        await client.createPost(`⛔ Only authorized users can use ${formatter.formatCode('!kill')}`, threadRoot);
        return;
      }
      // Notify all active sessions before killing
      for (const tid of session.getActiveThreadIds()) {
        try {
          await client.createPost(`🔴 ${formatter.formatBold('EMERGENCY SHUTDOWN')} by ${formatter.formatUserMention(username)}`, tid);
        } catch {
          /* ignore */
        }
      }
      logger?.error(`EMERGENCY SHUTDOWN initiated by @${username}`);
      session.killAllSessionsAndUnpersist();
      client.disconnect();
      // Call the kill callback (production calls process.exit, tests just return)
      onKill?.(username);
      return;
    }

    // Follow-up in active thread
    if (session.isInSessionThread(threadRoot)) {
      // If message starts with @mention to someone else, ignore it (side conversation)
      const mentionMatch = message.trim().match(/^@([\w.-]+)/);
      if (mentionMatch && mentionMatch[1].toLowerCase() !== client.getBotName().toLowerCase()) {
        return; // Side conversation, don't interrupt
      }

      const content = client.isBotMentioned(message)
        ? client.extractPrompt(message)
        : message.trim();

      // Parse command using shared parser
      const parsed = parseCommand(content);
      if (parsed) {
        const isAllowed = session.isUserAllowedInSession(threadRoot, username);

        switch (parsed.command) {
          case 'stop':
            if (isAllowed) await session.cancelSession(threadRoot, username);
            return;

          case 'escape':
            if (isAllowed) await session.interruptSession(threadRoot, username);
            return;

          case 'approve':
            if (isAllowed) await session.approvePendingPlan(threadRoot, username);
            return;

          case 'help': {
            const code = formatter.formatCode.bind(formatter);
            const commandTable = formatter.formatTable(
              ['Command', 'Description'],
              [
                [code('!cd <path>'), 'Change working directory (restarts Claude)'],
                [code('!worktree <branch>'), 'Create and switch to a git worktree'],
                [code('!worktree list'), 'List all worktrees for the repo'],
                [code('!worktree switch <branch>'), 'Switch to an existing worktree'],
                [code('!worktree remove <branch>'), 'Remove a worktree'],
                [code('!worktree cleanup'), 'Delete current worktree and switch back to repo'],
                [code('!worktree off'), 'Disable worktree prompts for this session'],
                [code('!invite @user'), 'Invite a user to this session'],
                [code('!kick @user'), 'Remove an invited user'],
                [code('!permissions interactive'), 'Enable interactive permissions'],
                [code('!approve'), 'Approve pending plan (alternative to 👍 reaction)'],
                [code('!update'), 'Show auto-update status'],
                [code('!update now'), 'Apply pending update immediately'],
                [code('!update defer'), 'Defer pending update for 1 hour'],
                [code('!escape'), 'Interrupt current task (session stays active)'],
                [code('!stop'), 'Stop this session'],
                [code('!kill'), 'Emergency shutdown (kills ALL sessions, exits bot)'],
                [code('!bug <description>'), 'Report a bug (creates GitHub issue)'],
              ]
            );
            await client.createPost(
              `${formatter.formatBold('Commands:')}\n\n` +
                commandTable +
                `\n\n${formatter.formatBold('Reactions:')}\n` +
                `${formatter.formatListItem('👍 Approve action · ✅ Approve all · 👎 Deny')}\n` +
                `${formatter.formatListItem('⏸️ Interrupt current task (session stays active)')}\n` +
                `${formatter.formatListItem('❌ or 🛑 Stop session')}`,
              threadRoot
            );
            return;
          }

          case 'release-notes': {
            const notes = getReleaseNotes(VERSION);
            if (notes) {
              await client.createPost(formatReleaseNotes(notes, formatter), threadRoot);
            } else {
              await client.createPost(
                `📋 ${formatter.formatBold(`claude-threads v${VERSION}`)}\n\nRelease notes not available. See ${formatter.formatLink('GitHub releases', 'https://github.com/anneschuth/claude-threads/releases')}.`,
                threadRoot
              );
            }
            return;
          }

          case 'invite':
            if (parsed.args) await session.inviteUser(threadRoot, parsed.args, username);
            return;

          case 'kick':
            if (parsed.args) await session.kickUser(threadRoot, parsed.args, username);
            return;

          case 'permissions':
            if (parsed.args?.toLowerCase() === 'interactive') {
              await session.enableInteractivePermissions(threadRoot, username);
            } else {
              await client.createPost(
                `⚠️ Cannot upgrade to auto permissions - can only downgrade to interactive`,
                threadRoot
              );
            }
            return;

          case 'cd':
            if (parsed.args) await session.changeDirectory(threadRoot, parsed.args, username);
            return;

          case 'update': {
            const subcommand = parsed.args?.toLowerCase();
            if (subcommand === 'now') {
              await session.forceUpdateNow(threadRoot, username);
            } else if (subcommand === 'defer') {
              await session.deferUpdate(threadRoot, username);
            } else {
              await session.showUpdateStatus(threadRoot, username);
            }
            return;
          }

          case 'worktree': {
            // Parse worktree subcommand from args
            const worktreeArgs = parsed.args?.split(/\s+/) || [];
            const subcommand = worktreeArgs[0]?.toLowerCase();
            const subArgs = worktreeArgs.slice(1).join(' ');

            switch (subcommand) {
              case 'list':
                await session.listWorktreesCommand(threadRoot, username);
                break;
              case 'switch':
                if (!subArgs) {
                  await client.createPost(`❌ Usage: ${formatter.formatCode('!worktree switch <branch>')}`, threadRoot);
                } else {
                  await session.switchToWorktree(threadRoot, subArgs, username);
                }
                break;
              case 'remove':
                if (!subArgs) {
                  await client.createPost(`❌ Usage: ${formatter.formatCode('!worktree remove <branch>')}`, threadRoot);
                } else {
                  await session.removeWorktreeCommand(threadRoot, subArgs, username);
                }
                break;
              case 'off':
                await session.disableWorktreePrompt(threadRoot, username);
                break;
              case 'cleanup':
                await session.cleanupWorktreeCommand(threadRoot, username);
                break;
              default:
                // Treat as branch name: !worktree feature/foo
                if (subcommand) await session.createAndSwitchToWorktree(threadRoot, subcommand, username);
            }
            return;
          }

          case 'context':
          case 'cost':
          case 'compact':
            // Claude Code passthrough commands
            if (isAllowed) {
              const claudeCommand = '/' + parsed.command;
              await session.sendFollowUp(threadRoot, claudeCommand);
            }
            return;

          case 'bug':
            // Bug reporting
            if (isAllowed) {
              await session.reportBug(threadRoot, parsed.args, username);
            }
            return;

          case 'kill':
            // Kill is handled earlier, but include for completeness
            return;
        }
      }

      // Check for pending worktree prompt - treat message as branch name response
      if (session.hasPendingWorktreePrompt(threadRoot)) {
        // Only session owner can respond
        if (session.isUserAllowedInSession(threadRoot, username)) {
          const handled = await session.handleWorktreeBranchResponse(
            threadRoot,
            content,
            username,
            post.id
          );
          if (handled) return;
        }
      }

      // Check if user is allowed in this session
      if (!session.isUserAllowedInSession(threadRoot, username)) {
        // Request approval for their message
        if (content) await session.requestMessageApproval(threadRoot, username, content);
        return;
      }

      // Get any attached files (images)
      const files = post.metadata?.files;

      if (content || files?.length) await session.sendFollowUp(threadRoot, content, files);
      return;
    }

    // Check for paused session that can be resumed
    if (session.hasPausedSession(threadRoot)) {
      // If message starts with @mention to someone else, ignore it (side conversation)
      const mentionMatch = message.trim().match(/^@([\w.-]+)/);
      if (mentionMatch && mentionMatch[1].toLowerCase() !== client.getBotName().toLowerCase()) {
        return; // Side conversation, don't interrupt
      }

      const content = client.isBotMentioned(message)
        ? client.extractPrompt(message)
        : message.trim();

      // Check if user is allowed in the paused session
      const persistedSession = session.getPersistedSession(threadRoot);
      if (persistedSession) {
        // Defensive: handle missing sessionAllowedUsers (old Bristol data)
        const allowedUsers = new Set(persistedSession.sessionAllowedUsers || []);
        if (!allowedUsers.has(username) && !client.isUserAllowed(username)) {
          // Not allowed - could request approval but that would require the session to be active
          await client.createPost(
            `⚠️ ${formatter.formatUserMention(username)} is not authorized to resume this session`,
            threadRoot
          );
          return;
        }
      }

      // Get any attached files (images)
      const files = post.metadata?.files;

      if (content || files?.length) {
        await session.resumePausedSession(threadRoot, content, files);
      }
      return;
    }

    // New session requires @mention
    if (!client.isBotMentioned(message)) return;

    if (!client.isUserAllowed(username)) {
      await client.createPost(`⚠️ ${formatter.formatUserMention(username)} is not authorized`, threadRoot);
      return;
    }

    const prompt = client.extractPrompt(message);
    const files = post.metadata?.files;

    if (!prompt && !files?.length) {
      await client.createPost(`Mention me with your request`, threadRoot);
      return;
    }

    // Check for inline branch syntax: "on branch X" or "!worktree X"
    const branchMatch = prompt.match(/(?:on branch|!worktree)\s+(\S+)/i);
    if (branchMatch) {
      const branch = branchMatch[1];
      // Remove the branch specification from the prompt
      const cleanedPrompt = prompt.replace(/(?:on branch|!worktree)\s+\S+/i, '').trim();
      await session.startSessionWithWorktree(
        { prompt: cleanedPrompt || prompt, files },
        branch,
        username,
        threadRoot,
        platformId,
        user?.displayName
      );
      return;
    }

    await session.startSession(
      { prompt, files },
      username,
      threadRoot,
      platformId,
      user?.displayName
    );
  } catch (err) {
    logger?.error(`Error handling message: ${err}`);
    // Try to notify user if possible
    try {
      await client.createPost(`⚠️ An error occurred. Please try again.`, threadRoot);
    } catch {
      // Ignore if we can't post the error message
    }
  }
}
