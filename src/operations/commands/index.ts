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

  // Permission management
  enableInteractivePermissions,

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

export type { AutoUpdateManagerInterface } from './handler.js';
