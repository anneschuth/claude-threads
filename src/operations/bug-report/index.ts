/**
 * Bug Report Module
 *
 * Re-exports all bug report functionality from the handler.
 */

export {
  // Image upload
  uploadImageToCatbox,
  uploadImages,
  type ImageUploadResult,

  // Types
  type RecentEvent,
  type ErrorContext,
  type PendingBugReport,
  type BugReportContext,

  // Event tracking
  trackEvent,
  getRecentEvents,

  // Sanitization
  sanitizePath,
  sanitizeText,

  // Context collection
  collectBugReportContext,

  // Issue formatting
  generateIssueTitle,
  formatIssueBody,
  formatBugPreview,

  // Issue creation
  checkGitHubCli,
  createGitHubIssue,
} from './handler.js';
