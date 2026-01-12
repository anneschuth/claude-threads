/**
 * Message streaming utilities
 *
 * Handles typing indicators and image attachments.
 * Content flushing is now handled by MessageManager/ContentExecutor.
 */

import type { PlatformClient, PlatformFile } from '../../platform/index.js';
import type { Session } from '../../session/types.js';
import type { ContentBlock } from '../../claude/cli.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('streaming');

// ---------------------------------------------------------------------------
// Message content building
// ---------------------------------------------------------------------------

/**
 * Build message content for Claude, including images if present.
 * Returns either a string or an array of content blocks.
 */
export async function buildMessageContent(
  text: string,
  platform: PlatformClient,
  files?: PlatformFile[],
  debug: boolean = false
): Promise<string | ContentBlock[]> {
  // Filter to only image files
  const imageFiles = files?.filter(f =>
    f.mimeType.startsWith('image/') &&
    ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(f.mimeType)
  ) || [];

  if (imageFiles.length === 0) {
    return text;
  }

  // Build content blocks with images
  const blocks: ContentBlock[] = [];

  for (const file of imageFiles) {
    try {
      if (!platform.downloadFile) {
        log.warn(`Platform does not support file downloads, skipping ${file.name}`);
        continue;
      }
      const buffer = await platform.downloadFile(file.id);
      const base64 = buffer.toString('base64');

      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: file.mimeType,
          data: base64,
        },
      });

      if (debug) {
        log.debug(`Attached image: ${file.name} (${file.mimeType}, ${Math.round(buffer.length / 1024)}KB)`);
      }
    } catch (err) {
      log.error(`Failed to download image ${file.name}: ${err}`);
    }
  }

  if (text) {
    blocks.push({
      type: 'text',
      text,
    });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Typing indicators
// ---------------------------------------------------------------------------

/**
 * Start sending typing indicators to the platform.
 * Sends immediately, then every 3 seconds until stopped.
 */
export function startTyping(session: Session): void {
  if (session.timers.typingTimer) return;
  session.platform.sendTyping(session.threadId);
  session.timers.typingTimer = setInterval(() => {
    session.platform.sendTyping(session.threadId);
  }, 3000);
}

/**
 * Stop sending typing indicators.
 */
export function stopTyping(session: Session): void {
  if (session.timers.typingTimer) {
    clearInterval(session.timers.typingTimer);
    session.timers.typingTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Task list bumping (delegates to MessageManager)
// ---------------------------------------------------------------------------

/**
 * Bump the task list to the bottom of the thread.
 *
 * Call this when a user sends a follow-up message to keep the task list
 * below user messages. Requires MessageManager to be available.
 */
export async function bumpTasksToBottom(session: Session): Promise<void> {
  if (session.messageManager) {
    await session.messageManager.bumpTaskList();
  }
  // If no messageManager, nothing to do - task list is managed by MessageManager
}
