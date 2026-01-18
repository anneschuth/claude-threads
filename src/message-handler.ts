/**
 * Message Handler Module
 *
 * Extracted from index.ts to allow reuse in both the main bot and integration tests.
 * This ensures tests exercise the actual bot logic, not a duplicate.
 */

import type { PlatformClient, PlatformPost, PlatformUser } from './platform/index.js';
import type { SessionManager } from './session/index.js';
import {
  parseCommand,
  parseCommandWithRemainder,
  executeCommand,
  isDynamicSlashCommand,
  handleDynamicSlashCommand,
  COMMAND_REGISTRY,
  type CommandExecutorContext,
} from './commands/index.js';
import type { InitialSessionOptions } from './session/types.js';
import { logSilentError } from './utils/error-handler/index.js';

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
   * Called when !kill command is executed. In production this calls process.exit(0).
   * In tests this can just disconnect without exiting.
   */
  onKill?: (username: string) => void | Promise<void>;
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
      // Post confirmation to the channel where !kill was issued
      const activeCount = session.registry.getActiveThreadIds().length;
      try {
        await client.createPost(
          `🔴 ${formatter.formatBold('EMERGENCY SHUTDOWN')} initiated by ${formatter.formatUserMention(username)} - killing ${activeCount} active session${activeCount !== 1 ? 's' : ''}`,
          threadRoot
        );
      } catch (err) {
        logSilentError('kill-confirmation-post', err);
      }

      // Notify all other active sessions before killing
      for (const tid of session.registry.getActiveThreadIds()) {
        if (tid === threadRoot) continue; // Skip the thread where we already posted
        try {
          await client.createPost(`🔴 ${formatter.formatBold('EMERGENCY SHUTDOWN')} by ${formatter.formatUserMention(username)}`, tid);
        } catch (err) {
          logSilentError('kill-notify-session', err);
        }
      }
      logger?.error(`EMERGENCY SHUTDOWN initiated by @${username}`);
      await session.killAllSessions();
      client.disconnect();
      // Call the kill callback (production calls process.exit, tests just return)
      await onKill?.(username);
      return;
    }

    // Follow-up in active thread
    // Use registry to check for active session directly
    const activeSession = session.registry.findByThreadId(threadRoot);
    if (activeSession) {
      // If message starts with @mention to someone else, track it as side conversation (if from approved user)
      const mentionMatch = message.trim().match(/^@([\w.-]+)/);
      if (mentionMatch && mentionMatch[1].toLowerCase() !== client.getBotName().toLowerCase()) {
        // Track side conversation if from approved user
        if (session.isUserAllowedInSession(threadRoot, username)) {
          session.addSideConversation(threadRoot, {
            fromUser: username,
            mentionedUser: mentionMatch[1],
            message: message,
            timestamp: new Date(),
            postId: post.id,
          });
        }
        return; // Side conversation, don't interrupt
      }

      const content = client.isBotMentioned(message)
        ? client.extractPrompt(message)
        : message.trim();

      // Parse command using shared parser
      const parsed = parseCommand(content);
      if (parsed) {
        const isAllowed = session.isUserAllowedInSession(threadRoot, username);

        // Build executor context
        const ctx: CommandExecutorContext = {
          commandContext: 'in-session',
          threadId: threadRoot,
          username,
          client,
          sessionManager: session,
          formatter,
          isAllowed,
          files: post.metadata?.files,
        };

        // Try unified command executor
        const result = await executeCommand(parsed.command, parsed.args, ctx);
        if (result.handled) {
          return;
        }

        // Handle dynamic slash commands (from Claude CLI's init event)
        const defaultPassthroughCommands = new Set(['context', 'cost', 'compact']);
        const availableCommands = activeSession.availableSlashCommands ?? defaultPassthroughCommands;

        if (isDynamicSlashCommand(parsed.command, availableCommands)) {
          const dynamicResult = await handleDynamicSlashCommand(parsed.command, parsed.args, ctx);
          if (dynamicResult.handled) {
            return;
          }
        }

        // Kill is handled earlier in the code, so we just return
        if (parsed.command === 'kill') {
          return;
        }

        // Unknown command - don't treat as regular message
        return;
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

      if (content || files?.length) await session.sendFollowUp(threadRoot, content, files, username, user?.displayName);
      return;
    }

    // Check for paused session that can be resumed
    // Use registry to check for persisted session directly
    const hasPausedSession = session.registry.getPersistedByThreadId(threadRoot) !== undefined;
    if (hasPausedSession) {
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
        const allowedUsers = new Set(persistedSession.sessionAllowedUsers);
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

    let prompt = client.extractPrompt(message);
    const files = post.metadata?.files;

    if (!prompt && !files?.length) {
      await client.createPost(`Mention me with your request`, threadRoot);
      return;
    }

    // ---------------------------------------------------------------------------
    // Parse and handle commands that work in the first message
    // Uses unified command executor with stacking support
    // ---------------------------------------------------------------------------
    const initialOptions: InitialSessionOptions = {};
    let worktreeBranch: string | undefined;

    // Build executor context for first-message commands
    const ctx: CommandExecutorContext = {
      commandContext: 'first-message',
      threadId: threadRoot,
      username,
      client,
      sessionManager: session,
      formatter,
      isAllowed: true, // Already verified authorization above
      files,
    };

    // Process commands that can appear at the start of the first message
    let continueProcessing = true;
    while (continueProcessing) {
      continueProcessing = false;

      // Try to parse a first-message command
      const parsed = parseCommandWithRemainder(prompt);
      if (!parsed) break;

      // Check if this command works in first message
      const cmdDef = COMMAND_REGISTRY.find(c => c.command === parsed.command);
      if (!cmdDef?.worksInFirstMessage) break;

      // Execute the command
      const result = await executeCommand(parsed.command, parsed.args, ctx);

      // If command fully handled (immediate commands like !help), we're done
      if (result.handled) {
        return;
      }

      // Apply any session options from the command
      if (result.sessionOptions) {
        Object.assign(initialOptions, result.sessionOptions);
      }

      // Set worktree branch if returned
      if (result.worktreeBranch) {
        worktreeBranch = result.worktreeBranch;
      }

      // Use remainder text for next iteration or as final prompt
      // For worktree branch creation, use remainingText if provided
      if (result.remainingText !== undefined) {
        prompt = result.remainingText;
      } else if (parsed.remainder !== undefined) {
        prompt = parsed.remainder;
      } else {
        prompt = '';
      }

      // Continue if this is a stackable command with more text to process
      continueProcessing = !!prompt && (cmdDef.isStackable || result.continueProcessing === true);
    }

    // Check for inline branch syntax: "on branch X" (legacy support)
    if (!worktreeBranch) {
      const branchMatch = prompt.match(/on branch\s+(\S+)/i);
      if (branchMatch) {
        worktreeBranch = branchMatch[1];
        prompt = prompt.replace(/on branch\s+\S+/i, '').trim();
      }
    }

    // If no prompt remains and no files and no worktree, don't start session
    // But if we have a worktree branch, we can start session with empty prompt
    if (!prompt.trim() && !files?.length && !worktreeBranch) {
      // Options were set but no actual prompt - could optionally start session anyway
      // For now, require a prompt or files (unless worktree specified)
      await client.createPost(`Mention me with your request`, threadRoot);
      return;
    }

    // Start session with worktree if branch specified
    if (worktreeBranch) {
      await session.startSessionWithWorktree(
        { prompt, files },
        worktreeBranch,
        username,
        threadRoot,
        platformId,
        user?.displayName,
        post.id,  // triggeringPostId
        initialOptions
      );
      return;
    }

    await session.startSession(
      { prompt, files },
      username,
      threadRoot,
      platformId,
      user?.displayName,
      post.id,  // triggeringPostId - the actual message that started the session
      initialOptions
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger?.error(`Error handling message: ${errorMessage}`);
    // Try to notify user if possible
    try {
      await client.createPost(`⚠️ An error occurred: ${errorMessage}`, threadRoot);
    } catch (postErr) {
      logSilentError('error-notification-post', postErr);
    }
  }
}
