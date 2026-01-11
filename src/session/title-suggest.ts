/**
 * Session title and description suggestions using Claude.
 *
 * Provides intelligent session metadata generation based on the user's task.
 * Uses the quick-query utility with Haiku for fast, low-cost suggestions.
 * Runs completely out-of-band (fire-and-forget) to not block session startup.
 */

import { quickQuery } from '../claude/quick-query.js';
import { createLogger } from '../utils/logger.js';
import { truncateAtWord } from '../utils/format.js';

const log = createLogger('title');

/** Default timeout for title suggestions (ms) */
const SUGGESTION_TIMEOUT = 15000;

/** Minimum title length */
const MIN_TITLE_LENGTH = 3;

/** Maximum title length */
const MAX_TITLE_LENGTH = 50;

/** Minimum description length */
const MIN_DESC_LENGTH = 5;

/** Maximum description length */
const MAX_DESC_LENGTH = 200;

/**
 * Session metadata returned by the suggestion function.
 */
export interface SessionMetadata {
  /** Short title (3-7 words, imperative form) */
  title: string;
  /** Brief description (1-2 sentences, truncated to 200 chars max) */
  description: string;
}

/** Maximum length for the original task in the prompt */
const MAX_ORIGINAL_TASK_LENGTH = 1000;

/** Maximum length for recent context in the prompt */
const MAX_RECENT_CONTEXT_LENGTH = 500;

/**
 * Context for title/description generation.
 * Allows for both initial (single message) and reclassification (multi-message) scenarios.
 */
export interface TitleContext {
  /** The original/first task that started the session (most important for stability) */
  originalTask: string;
  /** Optional recent context to capture session evolution */
  recentContext?: string;
  /** Optional current title - if provided, only suggest changes if significantly different */
  currentTitle?: string;
}

/**
 * Build the prompt for session title/description suggestions.
 *
 * For stability, the prompt prioritizes the original task over recent context.
 * This prevents title thrashing when the conversation evolves.
 *
 * Exported for testing.
 */
export function buildTitlePrompt(context: string | TitleContext): string {
  // Handle legacy single-string input
  if (typeof context === 'string') {
    const truncated = context.length > MAX_ORIGINAL_TASK_LENGTH
      ? context.substring(0, MAX_ORIGINAL_TASK_LENGTH) + '...'
      : context;

    return `Generate a session title and description for this task.

Task: "${truncated}"

Rules for title:
- 3-7 words, imperative form (e.g., "Fix login bug", "Add dark mode")
- No quotes or punctuation at end
- Capture the main intent

Rules for description:
- 1-2 sentences, under 100 characters total
- Explain what will be accomplished

Output format (exactly two lines):
TITLE: <title here>
DESC: <description here>`;
  }

  // Structured context with original task and optional recent context
  const { originalTask, recentContext, currentTitle } = context;

  // Truncate original task (most important - keep more of it)
  const truncatedOriginal = originalTask.length > MAX_ORIGINAL_TASK_LENGTH
    ? originalTask.substring(0, MAX_ORIGINAL_TASK_LENGTH) + '...'
    : originalTask;

  // Truncate recent context (supplementary - keep less)
  const truncatedRecent = recentContext && recentContext.length > MAX_RECENT_CONTEXT_LENGTH
    ? recentContext.substring(0, MAX_RECENT_CONTEXT_LENGTH) + '...'
    : recentContext;

  // Build the context section
  let contextSection = `Original task (PRIMARY - base the title on this): "${truncatedOriginal}"`;

  if (truncatedRecent) {
    contextSection += `\n\nRecent activity (SECONDARY - only incorporate if the session focus has fundamentally shifted): "${truncatedRecent}"`;
  }

  // Add stability instruction if there's a current title
  const stabilityInstruction = currentTitle
    ? `\n\nCurrent title: "${currentTitle}"\nIMPORTANT: Only suggest a different title if the session focus has FUNDAMENTALLY changed. Minor variations in activity should NOT change the title. Prefer keeping the current title if it still captures the main goal.`
    : '';

  return `Generate a session title and description based on the following context.
${stabilityInstruction}

${contextSection}

Rules for title:
- 3-7 words, imperative form (e.g., "Fix login bug", "Add dark mode")
- No quotes or punctuation at end
- Capture the MAIN intent from the original task
- Only deviate from original task if recent activity shows a fundamental change in direction

Rules for description:
- 1-2 sentences, under 100 characters total
- Explain what will be accomplished

Output format (exactly two lines):
TITLE: <title here>
DESC: <description here>`;
}

/**
 * Parse and validate metadata from Claude's response.
 * Exported for testing.
 */
export function parseMetadata(response: string): SessionMetadata | null {
  const titleMatch = response.match(/TITLE:\s*(.+)/i);
  const descMatch = response.match(/DESC:\s*(.+)/i);

  if (!titleMatch || !descMatch) {
    log.debug('Failed to parse title/description from response');
    return null;
  }

  let title = titleMatch[1].trim();
  let description = descMatch[1].trim();

  // Validate title - reject if too short, truncate at word boundary if too long
  if (title.length < MIN_TITLE_LENGTH) {
    log.debug(`Title too short: ${title.length} chars`);
    return null;
  }
  if (title.length > MAX_TITLE_LENGTH) {
    log.debug(`Title too long (${title.length} chars), truncating`);
    title = truncateAtWord(title, MAX_TITLE_LENGTH);
  }

  // Validate description - reject if too short, truncate at word boundary if too long
  if (description.length < MIN_DESC_LENGTH) {
    log.debug(`Description too short: ${description.length} chars`);
    return null;
  }
  if (description.length > MAX_DESC_LENGTH) {
    log.debug(`Description too long (${description.length} chars), truncating`);
    description = truncateAtWord(description, MAX_DESC_LENGTH);
  }

  return { title, description };
}

/**
 * Suggest session title and description based on the user's task.
 *
 * Uses Claude Haiku for fast, low-cost suggestions.
 * Returns null on any failure (silent fallback).
 *
 * @param context - The user's task description (string) or structured context (TitleContext)
 * @returns Session metadata or null on failure
 *
 * @example
 * // Simple usage (initial title)
 * const metadata = await suggestSessionMetadata('fix the login button not working');
 * // { title: 'Fix login button bug', description: 'Debugging and fixing the non-functional login button.' }
 *
 * @example
 * // Structured context (reclassification with stability)
 * const metadata = await suggestSessionMetadata({
 *   originalTask: 'fix the login button not working',
 *   recentContext: 'now working on the signup form',
 *   currentTitle: 'Fix login button bug'
 * });
 */
export async function suggestSessionMetadata(
  context: string | TitleContext
): Promise<SessionMetadata | null> {
  const logContext = typeof context === 'string'
    ? context.substring(0, 50)
    : context.originalTask.substring(0, 50);
  log.debug(`Suggesting title for: "${logContext}..."`);

  try {
    const result = await quickQuery({
      prompt: buildTitlePrompt(context),
      model: 'haiku',
      timeout: SUGGESTION_TIMEOUT,
    });

    if (!result.success || !result.response) {
      log.debug(`Title suggestion failed: ${result.error || 'no response'}`);
      return null;
    }

    const metadata = parseMetadata(result.response);
    if (metadata) {
      log.debug(`Got title: "${metadata.title}" (${result.durationMs}ms)`);
    }
    return metadata;
  } catch (err) {
    log.debug(`Title suggestion error: ${err}`);
    return null;
  }
}
