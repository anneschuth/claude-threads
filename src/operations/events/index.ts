/**
 * Events module - Pre/post processing of Claude events
 *
 * This module handles session-specific side effects that wrap MessageManager:
 * - Pre-processing: activity tracking, response flags, compaction handling
 * - Post-processing: PR URL extraction, command detection, usage stats
 */

export {
  handleEventPreProcessing,
  handleEventPostProcessing,
} from './handler.js';
