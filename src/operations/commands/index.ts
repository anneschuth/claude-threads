/**
 * Commands module - User command handling
 *
 * Exports all user command handlers for session management,
 * collaboration, permissions, and utility commands.
 */

export {
  // Session control
  cancelSession,
  interruptSession,
  approvePendingPlan,

  // Directory management
  changeDirectory,
  generateWorkSummary,

  // User collaboration
  inviteUser,
  kickUser,
  setGitHubEmail,
  setRespondOnlyWhenMentioned,

  // Permission management
  setSessionPermissionMode,

  // Message approval
  requestMessageApproval,

  // Session header
  updateSessionHeader,

  // Update commands
  showUpdateStatus,
  forceUpdateNow,
  deferUpdate,

  // Bug reporting
  reportBug,
  handleBugReportApproval,

  // Restart helper (used by plugin handler)
  restartClaudeSession,
} from './handler.js';

// Channel memory commands
export { rememberEntry, showMemory, forgetMemory } from './memory.js';

// Automation commands (routines + watches)
export { createRoutine, manageRoutines, createWatch, manageWatches } from './automation.js';

export type { AutoUpdateManagerInterface } from './handler.js';
