/**
 * Bug Report Module
 *
 * Re-exports all bug report functionality from the handler.
 */

export {
  // Screenshots
  selectScreenshots,
  saveScreenshots,
  withOmittedScreenshots,
  type SavedScreenshots,

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
  inspectBugReportTarget,
  createGitHubIssue,
  type BugReportTarget,
  type CreatedIssue,
  type GhExec,
} from './handler.js';
