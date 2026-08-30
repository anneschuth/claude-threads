/**
 * Message Handler Module
 *
 * Extracted from index.ts to allow reuse in both the main bot and integration tests.
 * This ensures tests exercise the actual bot logic, not a duplicate.
 */

import { sessionAllowedUserSet } from './session/authorization.js';
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
import { dcmThreadId, isDcmThreadId, resolveAckReaction, resolveApprovals, resolveDirectChannelMode, type DirectChannelModeConfig } from './platform/utils.js';
import { auditLog } from './persistence/audit-log.js';
import { createLogger } from './utils/logger.js';
import { shouldPostResumeRefusal } from './session/refusal-limiter.js';

const ackLog = createLogger('ack');

/**
 * Machine-generated status posts from claude-threads itself (any instance,
 * any version). When several bots share a server, one bot's status output
 * must never read as a request to another — a refusal that @-mentioned a
 * fellow bot once produced an unbounded two-bot loop (#491). Matching is
 * anchored to the exact emoji + phrase shapes the bot emits (with either
 * platform's bold markers), so a human message that merely *starts* with one
 * of these emoji still gets through.
 */
const BOLD = String.raw`(?:\*{1,2}|_{1,2})?`;
const STATUS_POST_PATTERNS: RegExp[] = [
  // Authorization refusals — the addressee may render as @name, `name`, or a
  // raw <@U…> token depending on platform and version.
  /^⚠️\s+\S+ is not authorized\b/u,
  new RegExp(`^⚠️\\s+${BOLD}Too busy${BOLD} -`, 'u'),
  new RegExp(`^⏱️\\s+${BOLD}Session (?:timed out|idle)${BOLD}`, 'u'),
  new RegExp(`^🛑\\s+${BOLD}Session cancelled${BOLD}`, 'u'),
  new RegExp(`^🔴\\s+${BOLD}EMERGENCY SHUTDOWN${BOLD}`, 'u'),
  new RegExp(`^🔄\\s+${BOLD}Session resumed${BOLD}`, 'u'),
];

/**
 * Whether a message is one of claude-threads' own status posts (#491).
 * Exported for tests.
 */
export function isClaudeThreadsStatusPost(message: string): boolean {
  const trimmed = message.trim();
  return STATUS_POST_PATTERNS.some((re) => re.test(trimmed));
}

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
  /**
   * Direct channel mode (DCM): the whole channel is one session. All messages
   * route to the synthetic `dcm:<platformId>` session key regardless of which
   * thread they were posted in. Accepts the raw config value (shorthand
   * boolean or options object); defaults are applied here. See
   * `PlatformInstanceConfig.directChannelMode`.
   */
  directChannelMode?: DirectChannelModeConfig;
}

/**
 * Handle an incoming message from a platform.
 *
 * This is the core message handling logic extracted from index.ts.
 * Both the main bot and integration tests use this same code.
 */
/**
 * Read receipt: acknowledge a message the bot has ACCEPTED for processing
 * with an instant reaction. Unlike the typing indicator this is persistent,
 * so users in busy channels see at a glance that their message landed —
 * including messages queued behind an in-flight session start, which
 * otherwise produce no visible signal until Claude responds.
 * Fire-and-forget: a failed reaction must never block message handling.
 */
function ackReceipt(client: PlatformClient, postId: string): void {
  const emoji = resolveAckReaction(client.ackReaction);
  if (!emoji) return;
  void Promise.resolve(client.addReaction(postId, emoji)).catch((err) => {
    // Typically a nonexistent custom emoji name — visible at debug level so a
    // typo in the config is diagnosable, while a flaky reaction stays silent.
    ackLog.debug(`ack reaction '${emoji}' failed on ${postId}: ${err}`);
  });
}

/**
 * The user a message opens by addressing, when that user is NOT the bot —
 * i.e. a human-to-human side conversation the bot must stay out of.
 * Understands both mention syntaxes: plain '@name' (Mattermost, and typed
 * names on Slack) and Slack's raw '<@U0…>' / '<@U0…|label>' forms — the raw
 * form is what Slack actually delivers, so matching only '@name' silently
 * disabled this guard on Slack. Returns the mentioned identifier, or null
 * when the message doesn't open with a mention, opens by addressing the
 * bot, or mentions the bot ANYWHERE — '@bob can you review? @bot summarize'
 * explicitly asks the bot and must reach it (parity with the DCM
 * new-session guard's isBotMentioned exemption).
 */
function leadingOtherUserMention(client: PlatformClient, message: string): string | null {
  if (client.isBotMentioned(message)) return null;
  const trimmed = message.trim();
  const named = trimmed.match(/^@([\w.-]+)/);
  if (named) {
    return named[1].toLowerCase() === client.getBotName().toLowerCase() ? null : named[1];
  }
  // The raw token form exists only on Slack. Mattermost never produces it,
  // so a literal '<@…>' there (pasted Slack output) is ordinary text, not
  // an address — matching it would silently drop real follow-ups.
  if (client.platformType !== 'slack') return null;
  const raw = trimmed.match(/^<@([A-Z0-9]+)(?:\|[^>]*)?>/i);
  if (raw) {
    return raw[1];
  }
  return null;
}

export async function handleMessage(
  client: PlatformClient,
  session: SessionManager,
  post: PlatformPost,
  user: PlatformUser | null,
  options: MessageHandlerOptions
): Promise<void> {
  const { platformId, logger, onKill } = options;
  const dcm = resolveDirectChannelMode(options.directChannelMode);
  const username = user?.username || 'unknown';
  const message = post.message;
  // In DCM every message in the channel — top-level or inside any thread —
  // belongs to the one channel session, so the session key is the synthetic
  // per-platform id instead of the post's own thread root.
  const threadRoot = dcm.enabled ? dcmThreadId(platformId) : (post.rootId || post.id);
  const formatter = client.getFormatter();

  try {
    // Another claude-threads instance's status output is machine output,
    // never a request — dropping it here breaks bot-to-bot loops (#491)
    // regardless of which refusal or notice shape triggered them.
    if (isClaudeThreadsStatusPost(message)) {
      logger?.debug?.(`Ignoring claude-threads status post from @${username}`);
      return;
    }

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
      auditLog(platformId, {
        threadId: threadRoot,
        actor: username,
        kind: 'command',
        tool: 'kill',
      });
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
    const activeSession = session.registry.findByThreadId(threadRoot, platformId);
    if (activeSession) {
      // A message opening by addressing someone else is a side conversation:
      // track it (if from an approved user) and don't interrupt Claude.
      const sideMentionActive = leadingOtherUserMention(client, message);
      if (sideMentionActive) {
        if (session.isUserAllowedInSession(threadRoot, username, platformId)) {
          session.addSideConversation(threadRoot, {
            fromUser: username,
            mentionedUser: sideMentionActive,
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
        const isAllowed = session.isUserAllowedInSession(threadRoot, username, platformId);

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

      // Check for pending worktree prompt - treat message as branch name response.
      // This runs BEFORE the quiet-mode gate below: a pending interactive prompt
      // means the bot just asked the user for a branch name, so their plain reply
      // (typically without an @mention) is clearly directed at the bot and must be
      // consumed even in quiet mode. Mirrors how commands bypass the gate.
      if (session.hasPendingWorktreePrompt(threadRoot)) {
        // Only session owner can respond
        if (session.isUserAllowedInSession(threadRoot, username, platformId)) {
          const handled = await session.handleWorktreeBranchResponse(
            threadRoot,
            content,
            username,
            post.id
          );
          if (handled) return;
        }
      }

      // Quiet mode (#402): when the session opts into "respond only when
      // mentioned", a non-command reply that doesn't @mention the bot is a side
      // conversation between users — ignore it so it doesn't interrupt Claude.
      // Commands and pending worktree-prompt responses are already handled above
      // and so always work, including `!mentions off` to leave quiet mode.
      if (activeSession.respondOnlyWhenMentioned && !client.isBotMentioned(message)) {
        return;
      }

      // Check if user is allowed in this session
      if (!session.isUserAllowedInSession(threadRoot, username, platformId)) {
        // Request approval for their message
        if (content) await session.requestMessageApproval(threadRoot, username, content);
        return;
      }

      // Get any attached files (images)
      const files = post.metadata?.files;

      if (content || files?.length) {
        ackReceipt(client, post.id);
        await session.sendFollowUp(threadRoot, content, files, username, user?.displayName);
      }
      return;
    }

    // Check for paused session that can be resumed
    // Use registry to check for persisted session directly
    const hasPausedSession = session.registry.getPersistedByThreadId(threadRoot, platformId) !== undefined;
    if (hasPausedSession) {
      // A message opening by addressing someone else is a side conversation.
      if (leadingOtherUserMention(client, message)) {
        return; // Side conversation, don't interrupt
      }

      const content = client.isBotMentioned(message)
        ? client.extractPrompt(message)
        : message.trim();

      // Parse commands even for paused sessions - !stop should cancel, not resume
      const pausedParsed = parseCommand(content);
      if (pausedParsed) {
        if (pausedParsed.command === 'stop') {
          // Clean up the paused session instead of resuming it
          const persistedSession = session.getPersistedSession(threadRoot, platformId);
          if (persistedSession) {
            const allowedUsers = sessionAllowedUserSet(persistedSession);
            if (allowedUsers.has(username) || client.isUserAllowed(username)) {
              auditLog(platformId, {
                threadId: threadRoot,
                actor: username,
                kind: 'command',
                tool: 'stop',
                detail: 'paused session cancelled',
              });
              session.cancelPausedSession(threadRoot, platformId);
              await client.createPost(
                `🛑 ${formatter.formatBold('Session cancelled')} by ${formatter.formatUserMention(username)}`,
                threadRoot
              );
            }
          }
        }
        // All commands in paused state are consumed (not passed as prompts)
        return;
      }

      // Check if user is allowed in the paused session. Under effective
      // approvals mode `owner`, message-based resume is scoped to session
      // participants, matching the reaction-based resume gate in
      // reaction-router.ts — the platform allowlist alone is not enough.
      const persistedSession = session.getPersistedSession(threadRoot, platformId);
      if (persistedSession) {
        const allowedUsers = sessionAllowedUserSet(persistedSession);
        const ownerScoped =
          resolveApprovals(client.approvals, isDcmThreadId(threadRoot)) === 'owner';
        if (!allowedUsers.has(username) && (ownerScoped || !client.isUserAllowed(username))) {
          // Not allowed - could request approval but that would require the
          // session to be active. The refusal deliberately does NOT @-mention
          // the refused user (inline code reads the same to a human and
          // notifies nobody) and is rate-limited per (thread, user): a message
          // whose purpose is "stop talking to me" must not be the one shape
          // guaranteed to wake another bot into replying (#491).
          if (shouldPostResumeRefusal(platformId, threadRoot, username)) {
            await client.createPost(
              `⚠️ ${formatter.formatCode(username)} is not authorized to resume this session`,
              threadRoot
            );
          }
          return;
        }
      }

      // Quiet mode (#402, fix #410): a session that opted into "respond only
      // when mentioned" keeps that setting while paused. A plain reply that
      // doesn't @mention the bot must not silently resume the session — the
      // persisted flag survives the idle pause, so honor it here just like the
      // active-session gate above. Commands (incl. !stop) are handled earlier
      // and so still bypass this gate.
      if (persistedSession?.respondOnlyWhenMentioned && !client.isBotMentioned(message)) {
        return;
      }

      // Get any attached files (images)
      const files = post.metadata?.files;

      if (content || files?.length) {
        ackReceipt(client, post.id);
        await session.resumePausedSession(threadRoot, content, files, username, platformId);
      }
      return;
    }

    // New session requires @mention — except in DCM with the default
    // `respondTo: all_messages`, where every channel message is implicitly
    // addressed to the bot (the channel is the session). With
    // `respondTo: mention` the DCM session also starts only on a mention.
    const mentionRequired = !dcm.enabled || dcm.respondTo === 'mention';
    if (mentionRequired && !client.isBotMentioned(message)) {
      // The bot is about to ignore this message — the one moment event
      // triggers (watches) evaluate it. Fire-and-forget: evaluation must
      // never delay or break message handling. Session and paused-session
      // threads returned above, so a fired session's own thread can never
      // re-trigger a watch. Watches are inert in DCM: every message in a DCM
      // channel routes to the synthetic channel-session key (line ~94), so a
      // session fired on the message's REAL thread root would be unreachable
      // — replies and !stop in its thread would never route to it.
      if (!dcm.enabled) {
        session.evaluateWatches(platformId, post, username, message);
      }
      return;
    }

    // DCM: a channel message opening with @someone-else is a human-to-human
    // side conversation. The active- and paused-session paths ignore those
    // (and docs promise it) — the new-session path must too, or the bot
    // injects itself into the exchange the moment no session is running.
    if (dcm.enabled && leadingOtherUserMention(client, message)) {
      return;
    }

    if (!client.isUserAllowed(username)) {
      // Warn only when the user explicitly addressed the bot. In DCM
      // all-messages mode EVERY channel message from a non-allowlisted
      // member reaches this branch — an unconditional warning would be
      // unbounded channel spam, and on Mattermost (which deliberately lets
      // other bots' posts through) two bots could warn at each other in an
      // endless loop.
      if (client.isBotMentioned(message)) {
        // No @-mention and rate-limited, for the same loop-safety reasons as
        // the resume refusal above (#491).
        if (shouldPostResumeRefusal(platformId, threadRoot, username)) {
          await client.createPost(`⚠️ ${formatter.formatCode(username)} is not authorized`, threadRoot);
        }
      }
      return;
    }

    let prompt = client.isBotMentioned(message)
      ? client.extractPrompt(message)
      : message.trim();
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
    ackReceipt(client, post.id);

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
