/**
 * Session title and description suggestions using Claude.
 *
 * Provides intelligent session metadata generation based on the user's task.
 * Uses the quick-query utility with Haiku for fast, low-cost suggestions.
 * Runs completely out-of-band (fire-and-forget) to not block session startup.
 */

import { quickQuery } from '../claude/quick-query.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('title-suggest');

/** Default timeout for title suggestions (ms) */
const SUGGESTION_TIMEOUT = 3000;

/** Minimum title length */
const MIN_TITLE_LENGTH = 3;

/** Maximum title length */
const MAX_TITLE_LENGTH = 50;

/** Minimum description length */
const MIN_DESC_LENGTH = 5;

/** Maximum description length */
const MAX_DESC_LENGTH = 100;

/**
 * Session metadata returned by the suggestion function.
 */
export interface SessionMetadata {
  /** Short title (3-7 words, imperative form) */
  title: string;
  /** Brief description (1-2 sentences, under 100 chars) */
  description: string;
}

/**
 * Build the prompt for session title/description suggestions.
 * Exported for testing.
 */
export function buildTitlePrompt(userMessage: string): string {
  // Truncate very long messages to keep prompt small
  const truncatedMessage =
    userMessage.length > 500 ? userMessage.substring(0, 500) + '...' : userMessage;

  return `Generate a session title and description for this task.

Task: "${truncatedMessage}"

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

  const title = titleMatch[1].trim();
  const description = descMatch[1].trim();

  // Validate title
  if (title.length < MIN_TITLE_LENGTH || title.length > MAX_TITLE_LENGTH) {
    log.debug(`Title length invalid: ${title.length} chars`);
    return null;
  }

  // Validate description
  if (description.length < MIN_DESC_LENGTH || description.length > MAX_DESC_LENGTH) {
    log.debug(`Description length invalid: ${description.length} chars`);
    return null;
  }

  return { title, description };
}

/**
 * Suggest session title and description based on the user's task.
 *
 * Uses Claude Haiku for fast, low-cost suggestions.
 * Returns null on any failure (silent fallback).
 *
 * @param userMessage - The user's task description
 * @returns Session metadata or null on failure
 *
 * @example
 * const metadata = await suggestSessionMetadata('fix the login button not working');
 * // { title: 'Fix login button bug', description: 'Debugging and fixing the non-functional login button.' }
 */
export async function suggestSessionMetadata(
  userMessage: string
): Promise<SessionMetadata | null> {
  log.debug(`Suggesting title for: "${userMessage.substring(0, 50)}..."`);

  try {
    const result = await quickQuery({
      prompt: buildTitlePrompt(userMessage),
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
