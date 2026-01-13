/**
 * Thread context prompt module
 *
 * Handles offering users the option to include previous thread context
 * when a session restarts (via !cd, worktree creation, or mid-thread @mention).
 */

import type { Session } from '../../session/types.js';
import type { ThreadMessage, PlatformFile } from '../../platform/index.js';
import type { ContentBlock } from '../../claude/cli.js';
import type { PendingContextPrompt as ExecutorPendingContextPrompt, ContextPromptFile } from '../executors/types.js';
import { NUMBER_EMOJIS, DENIAL_EMOJIS, getNumberEmojiIndex, isDenialEmoji } from '../../utils/emoji.js';
import { withErrorHandling } from '../../utils/error-handler/index.js';
import { updateLastMessage } from '../post-helpers/index.js';
import { createLogger } from '../../utils/logger.js';
import { createSessionLog } from '../../utils/session-log.js';

const log = createLogger('context');
const sessionLog = createSessionLog(log);

// Context timeout in milliseconds (30 seconds)
export const CONTEXT_PROMPT_TIMEOUT_MS = 30000;

// Context options: last N messages
export const CONTEXT_OPTIONS = [3, 5, 10] as const;

// ---------------------------------------------------------------------------
// Helper Functions for MessageManager Integration
// ---------------------------------------------------------------------------

/**
 * Module-level map for storing context prompt timeouts.
 * Keyed by sessionId since timeouts are not stored in MessageManager.
 */
const contextPromptTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();

/**
 * Module-level map for storing original PlatformFiles for context prompts.
 * MessageManager only stores simplified ContextPromptFile (id, name), but
 * we need the full PlatformFile for buildMessageContent.
 */
const contextPromptFiles: Map<string, PlatformFile[]> = new Map();

/**
 * Convert PlatformFile[] to ContextPromptFile[] for storage in MessageManager.
 * Only stores the essential fields needed for later retrieval.
 */
function toContextPromptFiles(files: PlatformFile[] | undefined): ContextPromptFile[] | undefined {
  if (!files || files.length === 0) return undefined;
  return files.map(f => ({ id: f.id, name: f.name }));
}

/**
 * Get the pending context prompt from MessageManager.
 * Returns null if not found or MessageManager not available.
 */
function getPendingContextPromptFromManager(session: Session): (ExecutorPendingContextPrompt & { timeoutId?: ReturnType<typeof setTimeout> }) | null {
  const prompt = session.messageManager?.getPendingContextPrompt();
  if (!prompt) return null;
  // Note: timeoutId is managed locally (not stored in MessageManager)
  const timeoutId = contextPromptTimeouts.get(session.sessionId);
  return { ...prompt, timeoutId };
}

/**
 * Set the pending context prompt in MessageManager.
 * The timeoutId and original files are stored locally.
 */
function setPendingContextPromptInManager(session: Session, prompt: PendingContextPrompt): void {
  if (session.messageManager) {
    // Store in MessageManager (without timeoutId - that's handled locally)
    const { timeoutId, queuedFiles, ...rest } = prompt;
    session.messageManager.setPendingContextPrompt({
      ...rest,
      queuedFiles: toContextPromptFiles(queuedFiles),
    });
    // Store timeout locally
    if (timeoutId) {
      contextPromptTimeouts.set(session.sessionId, timeoutId);
    }
    // Store original files locally for later use
    if (queuedFiles && queuedFiles.length > 0) {
      contextPromptFiles.set(session.sessionId, queuedFiles);
    }
  }
}

/**
 * Clear the pending context prompt from MessageManager and local storage.
 */
function clearPendingContextPromptInManager(session: Session): void {
  session.messageManager?.clearPendingContextPrompt();
  const timeoutId = contextPromptTimeouts.get(session.sessionId);
  if (timeoutId) {
    clearTimeout(timeoutId);
    contextPromptTimeouts.delete(session.sessionId);
  }
  contextPromptFiles.delete(session.sessionId);
}

/**
 * Get the original PlatformFiles for a session's context prompt.
 */
function getContextPromptFilesForSession(session: Session): PlatformFile[] | undefined {
  return contextPromptFiles.get(session.sessionId);
}

/**
 * Pending context prompt state
 */
export interface PendingContextPrompt {
  postId: string;
  queuedPrompt: string;       // The prompt to send after decision
  queuedFiles?: PlatformFile[]; // Files attached to the queued prompt (for images)
  threadMessageCount: number; // Total messages in thread before this point
  createdAt: number;          // Timestamp for timeout tracking
  timeoutId?: ReturnType<typeof setTimeout>; // Reference to timeout for cleanup
  availableOptions: number[]; // The actual options shown (e.g., [3, 5, 8] for 8 messages)
}

// ---------------------------------------------------------------------------
// Context prompt functions
// ---------------------------------------------------------------------------

/**
 * Check if we should prompt for context.
 * Returns the number of messages available, or 0 if we shouldn't prompt.
 */
export async function getThreadContextCount(
  session: Session,
  excludePostId?: string
): Promise<number> {
  try {
    const messages = await session.platform.getThreadHistory(
      session.threadId,
      { excludeBotMessages: true }
    );

    // Filter out the current post if specified
    const relevantMessages = excludePostId
      ? messages.filter(m => m.id !== excludePostId)
      : messages;

    return relevantMessages.length;
  } catch {
    return 0;
  }
}

/**
 * Get the valid context options based on available message count.
 * Only returns options that are <= messageCount.
 */
export function getValidContextOptions(messageCount: number): number[] {
  return CONTEXT_OPTIONS.filter(opt => opt <= messageCount);
}

/**
 * Post the context prompt to the user.
 * Returns the pending context prompt state.
 */
export async function postContextPrompt(
  session: Session,
  queuedPrompt: string,
  queuedFiles: PlatformFile[] | undefined,
  messageCount: number,
  registerPost: (postId: string, threadId: string) => void,
  onTimeout: () => void
): Promise<PendingContextPrompt> {
  // Filter options to only those <= messageCount
  const validOptions = getValidContextOptions(messageCount);

  // Build message with only valid options
  let optionsText = '';
  const reactionOptions: string[] = [];

  for (let i = 0; i < validOptions.length; i++) {
    const opt = validOptions[i];
    const emoji = ['1️⃣', '2️⃣', '3️⃣'][i];
    optionsText += `${emoji} Last ${opt} messages\n`;
    reactionOptions.push(NUMBER_EMOJIS[i]);
  }

  // Add "All messages" option if messageCount > largest option shown
  // or if no options are valid (messageCount < smallest option)
  if (validOptions.length === 0 || messageCount > validOptions[validOptions.length - 1]) {
    const nextIndex = validOptions.length;
    if (nextIndex < 3) {
      const emoji = ['1️⃣', '2️⃣', '3️⃣'][nextIndex];
      optionsText += `${emoji} All ${messageCount} messages\n`;
      reactionOptions.push(NUMBER_EMOJIS[nextIndex]);
    }
  }

  // Add no context option
  optionsText += `❌ No context (default after 30s)`;
  reactionOptions.push(DENIAL_EMOJIS[0]);

  const formatter = session.platform.getFormatter();
  const message =
    `🧵 ${formatter.formatBold('Include thread context?')}\n` +
    `This thread has ${messageCount} message${messageCount === 1 ? '' : 's'} before this point.\n` +
    `React to include previous messages, or continue without context.\n\n` +
    optionsText;

  const post = await session.platform.createInteractivePost(
    message,
    reactionOptions,
    session.threadId
  );

  // Register for reaction routing
  registerPost(post.id, session.threadId);
  // Track for jump-to-bottom links
  updateLastMessage(session, post);

  // Set up timeout
  const timeoutId = setTimeout(onTimeout, CONTEXT_PROMPT_TIMEOUT_MS);

  // Build the list of available options that were shown
  // This includes the valid CONTEXT_OPTIONS plus potentially "all messages"
  const availableOptions = [...validOptions];
  if (validOptions.length === 0 || messageCount > validOptions[validOptions.length - 1]) {
    if (validOptions.length < 3) {
      availableOptions.push(messageCount); // "All X messages" option
    }
  }

  return {
    postId: post.id,
    queuedPrompt,
    queuedFiles,
    threadMessageCount: messageCount,
    createdAt: Date.now(),
    timeoutId,
    availableOptions,
  };
}

/**
 * Handle a reaction on the context prompt.
 * Returns the number of messages to include, or null if not a valid reaction.
 * Returns 0 for "no context" selection.
 *
 * @param emojiName - The emoji that was reacted with
 * @param availableOptions - The options that were shown in the prompt
 */
export function getContextSelectionFromReaction(
  emojiName: string,
  availableOptions: number[]
): number | null {
  // Check for number emoji (1, 2, 3)
  const numberIndex = getNumberEmojiIndex(emojiName);
  if (numberIndex >= 0 && numberIndex < availableOptions.length) {
    return availableOptions[numberIndex];
  }

  // Check for "no context" / denial emoji
  if (isDenialEmoji(emojiName)) {
    return 0;
  }

  // Also accept 'x' emoji as "no context"
  if (emojiName === 'x') {
    return 0;
  }

  return null; // Not a valid context selection reaction
}

/**
 * Get thread messages for context.
 */
export async function getThreadMessagesForContext(
  session: Session,
  limit: number,
  excludePostId?: string
): Promise<ThreadMessage[]> {
  const messages = await session.platform.getThreadHistory(
    session.threadId,
    { limit, excludeBotMessages: true }
  );

  // Filter out the current post if specified
  return excludePostId
    ? messages.filter(m => m.id !== excludePostId)
    : messages;
}

/**
 * Format thread messages as context for Claude.
 */
export function formatContextForClaude(messages: ThreadMessage[]): string {
  if (messages.length === 0) return '';

  const lines = ['[Previous conversation in this thread:]', ''];

  for (const msg of messages) {
    // Truncate very long messages
    const content = msg.message.length > 500
      ? msg.message.substring(0, 500) + '...'
      : msg.message;
    lines.push(`@${msg.username}: ${content}`);
  }

  lines.push('', '---', '', '[Current request:]');

  return lines.join('\n');
}

/**
 * Update the context prompt post to show the user's selection.
 */
export async function updateContextPromptPost(
  session: Session,
  postId: string,
  selection: number | 'timeout' | 'skip',
  username?: string
): Promise<void> {
  const formatter = session.platform.getFormatter();
  let message: string;

  if (selection === 'timeout') {
    message = '⏱️ Continuing without context (no response)';
  } else if (selection === 'skip' || selection === 0) {
    message = username
      ? `✅ Continuing without context (skipped by ${formatter.formatUserMention(username)})`
      : '✅ Continuing without context';
  } else {
    message = username
      ? `✅ Including last ${selection} messages (selected by ${formatter.formatUserMention(username)})`
      : `✅ Including last ${selection} messages`;
  }

  await withErrorHandling(
    () => session.platform.updatePost(postId, message),
    { action: 'Update context prompt post', session }
  );
}

// =============================================================================
// High-level Context Prompt Handling
// =============================================================================

/**
 * Context for handling context prompts.
 */
export interface ContextPromptHandler {
  registerPost: (postId: string, threadId: string) => void;
  startTyping: (session: Session) => void;
  persistSession: (session: Session) => void;
  injectMetadataReminder: (message: string, session: Session) => string;
  buildMessageContent: (text: string, session: Session, files?: PlatformFile[]) => Promise<string | ContentBlock[]>;
}

/**
 * Handle context prompt timeout.
 */
export async function handleContextPromptTimeout(
  session: Session,
  ctx: ContextPromptHandler
): Promise<void> {
  // Get pending context prompt from MessageManager
  const pending = getPendingContextPromptFromManager(session);
  if (!pending) return;

  // Update the post to show timeout
  await updateContextPromptPost(session, pending.postId, 'timeout');

  // Get the queued prompt and files
  const queuedPrompt = pending.queuedPrompt;
  // Get original PlatformFiles from local storage (MessageManager only stores simplified refs)
  const queuedFiles = getContextPromptFilesForSession(session);

  // Clear pending context prompt (MessageManager and local storage)
  clearPendingContextPromptInManager(session);

  // Increment message counter
  session.messageCount++;

  // Inject metadata reminder periodically
  const messageToSend = ctx.injectMetadataReminder(queuedPrompt, session);

  // Build content with files (images)
  const content = await ctx.buildMessageContent(messageToSend, session, queuedFiles);

  // Send the message without context
  if (session.claude.isRunning()) {
    session.claude.sendMessage(content);
    ctx.startTyping(session);
  }

  // Persist updated state
  ctx.persistSession(session);

  sessionLog(session).debug(`🧵 Context prompt timed out, continuing without context`);
}

/**
 * Offer context prompt after a session restart or mid-thread start.
 * If there's thread history, posts the context prompt and queues the message.
 * If no history, sends the message immediately.
 * Returns true if context prompt was posted, false if message was sent directly.
 */
export async function offerContextPrompt(
  session: Session,
  queuedPrompt: string,
  queuedFiles: PlatformFile[] | undefined,
  ctx: ContextPromptHandler,
  excludePostId?: string
): Promise<boolean> {
  // Get thread history count (exclude bot messages and the triggering message)
  const messageCount = await getThreadContextCount(session, excludePostId);

  if (messageCount === 0) {
    // No previous messages, send directly with files
    session.messageCount++;
    const messageToSend = ctx.injectMetadataReminder(queuedPrompt, session);
    const content = await ctx.buildMessageContent(messageToSend, session, queuedFiles);
    if (session.claude.isRunning()) {
      session.claude.sendMessage(content);
      ctx.startTyping(session);
    }
    return false;
  }

  if (messageCount === 1) {
    // Only one message (the thread starter) - auto-include without asking
    const messages = await getThreadMessagesForContext(session, 1, excludePostId);
    let messageToSend = queuedPrompt;
    if (messages.length > 0) {
      const contextPrefix = formatContextForClaude(messages);
      messageToSend = contextPrefix + queuedPrompt;
    }

    session.messageCount++;
    messageToSend = ctx.injectMetadataReminder(messageToSend, session);
    const content = await ctx.buildMessageContent(messageToSend, session, queuedFiles);
    if (session.claude.isRunning()) {
      session.claude.sendMessage(content);
      ctx.startTyping(session);
    }

    sessionLog(session).debug(`🧵 Auto-included 1 message as context (thread starter)`);

    return false;
  }

  // Post context prompt - files will be stored with the pending prompt
  const pending = await postContextPrompt(
    session,
    queuedPrompt,
    queuedFiles,
    messageCount,
    ctx.registerPost,
    () => handleContextPromptTimeout(session, ctx)
  );

  // Store in MessageManager (timeoutId and files stored locally)
  setPendingContextPromptInManager(session, pending);
  ctx.persistSession(session);

  sessionLog(session).debug(`🧵 Context prompt posted (${messageCount} messages available)`);

  return true;
}
