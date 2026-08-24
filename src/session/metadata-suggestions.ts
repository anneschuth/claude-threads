/**
 * Out-of-band session metadata suggestions (fire-and-forget): haiku-derived
 * titles and tags fetched shortly after session start, retried a couple of
 * times, and re-derived periodically as the conversation evolves. Split
 * from lifecycle.ts — this domain only calls INTO ctx.ops (persist, sticky,
 * header updates); nothing here participates in session lifecycle itself.
 */

import type { Session } from './types.js';
import type { SessionContext } from '../operations/session-context/index.js';
import { suggestSessionMetadata } from '../operations/suggestions/title.js';
import { suggestSessionTags } from '../operations/suggestions/tag.js';
import { createLogger } from '../utils/logger.js';
import { createSessionLog } from '../utils/session-log.js';

const log = createLogger('session');
const sessionLog = createSessionLog(log);

/** Retry configuration for metadata suggestions */
const METADATA_RETRY_DELAY_MS = 2000;
const METADATA_MAX_RETRIES = 2;

/**
 * Suggestion function types for dependency injection in tests.
 */
export type MetadataSuggestFn = typeof suggestSessionMetadata;
export type TagSuggestFn = typeof suggestSessionTags;

/**
 * Options for attemptMetadataFetch, primarily for testing.
 */
export interface AttemptMetadataFetchOptions {
  /** Override the metadata suggestion function (for testing) */
  suggestMetadata?: MetadataSuggestFn;
  /** Override the tag suggestion function (for testing) */
  suggestTags?: TagSuggestFn;
}

/**
 * Attempt to fetch metadata with retry logic.
 * Returns true if both metadata and tags were successfully fetched.
 *
 * @internal Exported for testing only
 */
export async function attemptMetadataFetch(
  session: Session,
  prompt: string,
  ctx: SessionContext,
  attempt: number = 1,
  options: AttemptMetadataFetchOptions = {}
): Promise<{ success: boolean; metadataSet: boolean; tagsSet: boolean }> {
  const sessionId = session.sessionId;

  // Use injected functions or defaults
  const suggestMetadataFn = options.suggestMetadata ?? suggestSessionMetadata;
  const suggestTagsFn = options.suggestTags ?? suggestSessionTags;

  // Run title/description and tags in parallel
  const [metadata, tags] = await Promise.all([
    suggestMetadataFn(prompt),
    suggestTagsFn(prompt),
  ]);

  // Check if session still exists (might have been cleaned up while we awaited)
  const currentSession = (ctx.state.sessions as Map<string, Session>).get(sessionId);
  if (!currentSession) {
    sessionLog(session).debug('Session gone before metadata suggestions completed');
    return { success: false, metadataSet: false, tagsSet: false };
  }

  // Track what we successfully set
  let metadataSet = false;
  let tagsSet = false;
  let updated = false;

  // Only update if we got results and session doesn't already have metadata
  if (metadata && !currentSession.sessionTitle) {
    currentSession.sessionTitle = metadata.title;
    currentSession.sessionDescription = metadata.description;
    sessionLog(currentSession).debug(`Set title: "${metadata.title}" (attempt ${attempt})`);
    metadataSet = true;
    updated = true;
  } else if (currentSession.sessionTitle) {
    // Already has title from a previous attempt
    metadataSet = true;
  }

  if (tags.length > 0 && (!currentSession.sessionTags || currentSession.sessionTags.length === 0)) {
    currentSession.sessionTags = tags;
    sessionLog(currentSession).debug(`Set tags: ${tags.join(', ')} (attempt ${attempt})`);
    tagsSet = true;
    updated = true;
  } else if (currentSession.sessionTags && currentSession.sessionTags.length > 0) {
    // Already has tags from a previous attempt
    tagsSet = true;
  }

  // Update persistence and UI if anything changed
  if (updated) {
    ctx.ops.persistSession(currentSession);
    await ctx.ops.updateStickyMessage();
    await ctx.ops.updateSessionHeader(currentSession);
  }

  return { success: metadataSet && tagsSet, metadataSet, tagsSet };
}

/**
 * Fire metadata suggestions (title, description, tags) in the background.
 * This is fire-and-forget - it never blocks session startup and never throws.
 *
 * Includes retry logic: if metadata or tags fail to fetch, retries up to
 * METADATA_MAX_RETRIES times with METADATA_RETRY_DELAY_MS delay between attempts.
 *
 * @param session - The session to update
 * @param prompt - The user's initial prompt
 * @param ctx - Session context for persistence and UI updates
 */
export function fireMetadataSuggestions(
  session: Session,
  prompt: string,
  ctx: SessionContext
): void {
  // Fire immediately without awaiting
  void (async () => {
    try {
      // First attempt
      let result = await attemptMetadataFetch(session, prompt, ctx, 1);

      // Retry if either metadata or tags failed
      let attempt = 1;
      while (!result.success && attempt < METADATA_MAX_RETRIES + 1) {
        attempt++;

        // Check if session still exists before retrying
        const currentSession = (ctx.state.sessions as Map<string, Session>).get(session.sessionId);
        if (!currentSession) {
          sessionLog(session).debug('Session gone, stopping metadata retries');
          return;
        }

        // Log what we're retrying for
        const missing: string[] = [];
        if (!result.metadataSet) missing.push('title/description');
        if (!result.tagsSet) missing.push('tags');
        sessionLog(session).debug(`Retrying metadata fetch for ${missing.join(', ')} (attempt ${attempt}/${METADATA_MAX_RETRIES + 1})`);

        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, METADATA_RETRY_DELAY_MS));

        // Retry
        result = await attemptMetadataFetch(session, prompt, ctx, attempt);
      }

      if (!result.success) {
        const missing: string[] = [];
        if (!result.metadataSet) missing.push('title/description');
        if (!result.tagsSet) missing.push('tags');
        sessionLog(session).debug(`Metadata fetch incomplete after ${attempt} attempts: missing ${missing.join(', ')}`);
      }
    } catch (err) {
      // Fire-and-forget: log but never throw
      sessionLog(session).debug(`Metadata suggestion error: ${err}`);
    }
  })();
}

/**
 * Fire periodic re-classification if session focus might have shifted.
 * Called periodically (every N messages) to update title/tags.
 * This is fire-and-forget - it never blocks and never throws.
 *
 * Uses structured context with original task as anchor to prevent
 * title thrashing from minor conversation variations.
 *
 * @param session - The session to potentially re-classify
 * @param currentMessage - The latest user message (used for context)
 * @param ctx - Session context for persistence and UI updates
 */
function firePeriodicReclassification(
  session: Session,
  currentMessage: string,
  ctx: SessionContext
): void {
  // Fire immediately without awaiting
  void (async () => {
    try {
      const sessionId = session.sessionId;

      // Use structured context for stability:
      // - Original task is PRIMARY (anchor for title)
      // - Recent message is SECONDARY (only matters if focus fundamentally changed)
      // - Current title helps LLM maintain stability
      const titleContext = session.firstPrompt
        ? {
            originalTask: session.firstPrompt,
            recentContext: currentMessage,
            currentTitle: session.sessionTitle,
          }
        : currentMessage;  // Fallback to simple string if no firstPrompt

      // For tags, still use combined context (tags are less sensitive to thrashing)
      const tagContext = session.firstPrompt
        ? `Original task: ${session.firstPrompt}\n\nRecent activity: ${currentMessage}`
        : currentMessage;

      // Run title/description and tags in parallel
      const [metadata, tags] = await Promise.all([
        suggestSessionMetadata(titleContext),
        suggestSessionTags(tagContext),
      ]);

      // Check if session still exists
      const currentSession = (ctx.state.sessions as Map<string, Session>).get(sessionId);
      if (!currentSession) {
        sessionLog(session).debug('Session gone before reclassification completed');
        return;
      }

      // Update metadata if we got valid results
      // Note: With structured context, the LLM is instructed to prefer keeping
      // the current title unless there's a fundamental focus shift
      let updated = false;

      if (metadata) {
        // Only update if title actually changed (LLM may return same title for stability)
        if (metadata.title !== currentSession.sessionTitle) {
          currentSession.sessionTitle = metadata.title;
          currentSession.sessionDescription = metadata.description;
          sessionLog(currentSession).debug(`Updated title: "${metadata.title}"`);
          updated = true;
        } else {
          sessionLog(currentSession).debug('Title unchanged (stable)');
        }
      }

      if (tags.length > 0) {
        currentSession.sessionTags = tags;
        sessionLog(currentSession).debug(`Updated tags: ${tags.join(', ')}`);
        updated = true;
      }

      // Update persistence and UI if anything changed
      if (updated) {
        ctx.ops.persistSession(currentSession);
        await ctx.ops.updateStickyMessage();
        await ctx.ops.updateSessionHeader(currentSession);
      }
    } catch (err) {
      // Fire-and-forget: log but never throw
      sessionLog(session).debug(`Reclassification error: ${err}`);
    }
  })();
}

// ---------------------------------------------------------------------------
// System prompt for chat platform context
// ---------------------------------------------------------------------------


/**
 * How often to fire periodic reclassification (every N messages).
 */
const RECLASSIFICATION_INTERVAL = 5;

/**
 * Check if periodic reclassification should be triggered for this message.
 * Fires out-of-band re-classification of title/tags at regular intervals.
 * Always returns the original message unchanged (no longer injects reminders
 * since we now handle metadata out-of-band via quickQuery).
 */
export function maybeInjectMetadataReminder(
  message: string,
  session: { messageCount: number },
  ctx?: SessionContext,
  fullSession?: Session
): string {
  // Fire out-of-band re-classification periodically
  if (session.messageCount > 1 && session.messageCount % RECLASSIFICATION_INTERVAL === 0) {
    if (ctx && fullSession) {
      firePeriodicReclassification(fullSession, message, ctx);
    }
  }
  // Always return the message unchanged
  return message;
}
