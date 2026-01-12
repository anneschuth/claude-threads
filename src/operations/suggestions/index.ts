/**
 * Suggestions module - AI-powered suggestions for sessions
 *
 * This module provides Claude-powered suggestions for:
 * - Branch names (based on task description)
 * - Session tags (automatic classification)
 * - Session titles and descriptions
 */

// Branch suggestions
export {
  suggestBranchNames,
  buildSuggestionPrompt,
  parseBranchSuggestions,
} from './branch.js';

// Tag suggestions
export {
  suggestSessionTags,
  buildTagPrompt,
  parseTags,
  isValidTag,
  VALID_TAGS,
} from './tag.js';

export type { SessionTag } from './tag.js';

// Title suggestions
export {
  suggestSessionMetadata,
  buildTitlePrompt,
  parseMetadata,
} from './title.js';

export type { SessionMetadata, TitleContext } from './title.js';
