/**
 * Session tag suggestions using Claude.
 *
 * Automatically classifies sessions with predefined tags for organization.
 * Uses the quick-query utility with Haiku for fast, low-cost classification.
 * Runs completely out-of-band (fire-and-forget) to not block session startup.
 */

import { quickQuery } from '../claude/quick-query.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('tags');

/** Default timeout for tag suggestions (ms) */
const SUGGESTION_TIMEOUT = 15000;

/** Maximum number of tags per session */
const MAX_TAGS = 3;

/**
 * Valid session tags for classification.
 */
export const VALID_TAGS = [
  'bug-fix',
  'feature',
  'refactor',
  'docs',
  'test',
  'config',
  'security',
  'performance',
  'exploration',
  'cleanup',
] as const;

/**
 * Session tag type (one of the valid tags).
 */
export type SessionTag = (typeof VALID_TAGS)[number];

/**
 * Check if a string is a valid session tag.
 */
export function isValidTag(tag: string): tag is SessionTag {
  return VALID_TAGS.includes(tag as SessionTag);
}

/**
 * Build the prompt for session tag classification.
 * Exported for testing.
 */
export function buildTagPrompt(userMessage: string): string {
  // Truncate very long messages to keep prompt small
  const truncatedMessage =
    userMessage.length > 500 ? userMessage.substring(0, 500) + '...' : userMessage;

  return `Classify this task with 1-3 tags from this list ONLY:
${VALID_TAGS.join(', ')}

Task: "${truncatedMessage}"

Output ONLY the tags, comma-separated, nothing else.`;
}

/**
 * Parse and validate tags from Claude's response.
 * Exported for testing.
 */
export function parseTags(response: string): SessionTag[] {
  const tags = response
    .toLowerCase()
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(isValidTag);

  // Deduplicate and limit to max tags
  return [...new Set(tags)].slice(0, MAX_TAGS);
}

/**
 * Suggest session tags based on the user's task.
 *
 * Uses Claude Haiku for fast, low-cost classification.
 * Returns empty array on any failure (silent fallback).
 *
 * @param userMessage - The user's task description
 * @returns Array of session tags (0-3 items)
 *
 * @example
 * const tags = await suggestSessionTags('fix the login button not working');
 * // ['bug-fix']
 */
export async function suggestSessionTags(userMessage: string): Promise<SessionTag[]> {
  log.debug(`Suggesting tags for: "${userMessage.substring(0, 50)}..."`);

  try {
    const result = await quickQuery({
      prompt: buildTagPrompt(userMessage),
      model: 'haiku',
      timeout: SUGGESTION_TIMEOUT,
    });

    if (!result.success || !result.response) {
      log.debug(`Tag suggestion failed: ${result.error || 'no response'}`);
      return [];
    }

    const tags = parseTags(result.response);
    log.debug(`Got tags: ${tags.join(', ')} (${result.durationMs}ms)`);
    return tags;
  } catch (err) {
    log.debug(`Tag suggestion error: ${err}`);
    return [];
  }
}
