/**
 * Command Execution Types
 *
 * Types for unified command handling across root messages and in-session messages.
 */

import type { PlatformClient, PlatformFormatter, PlatformFile } from '../platform/index.js';
import type { SessionManager } from '../session/index.js';

// =============================================================================
// Command Context
// =============================================================================

/** Context in which a command is being executed */
export type CommandContext = 'first-message' | 'in-session';

/** Context passed to command handlers */
export interface CommandExecutorContext {
  /** Whether this is a first-message or in-session command */
  commandContext: CommandContext;
  /** Thread ID where the command was issued */
  threadId: string;
  /** Username of the person who issued the command */
  username: string;
  /** Platform client for posting messages */
  client: PlatformClient;
  /** Session manager for session operations */
  sessionManager: SessionManager;
  /** Platform formatter for message formatting */
  formatter: PlatformFormatter;
  /** Whether the user is allowed to execute commands in this session */
  isAllowed?: boolean;
  /** Attached files from the post */
  files?: PlatformFile[];
}

// =============================================================================
// Command Result
// =============================================================================

/** Options that can be passed when starting a new session */
export interface InitialSessionOptions {
  /** Working directory override */
  workingDir?: string;
  /** Force interactive permissions mode */
  forceInteractivePermissions?: boolean;
  /** Switch to existing worktree instead of creating new (from !worktree switch) */
  switchToExisting?: boolean;
}

/** Result of command execution */
export interface CommandResult {
  /** Whether the command was fully handled (stop processing) */
  handled?: boolean;
  /** Whether to continue processing remaining text (for stackable commands) */
  continueProcessing?: boolean;
  /** Options to pass to session start (for first-message commands) */
  sessionOptions?: Partial<InitialSessionOptions>;
  /** Branch name for worktree creation (for first-message) */
  worktreeBranch?: string;
  /** Remaining text after command extraction */
  remainingText?: string;
}

// =============================================================================
// Command Handler
// =============================================================================

/** Command handler function signature */
export type CommandHandler = (
  ctx: CommandExecutorContext,
  args?: string
) => Promise<CommandResult>;

/** Map of command names to handlers */
export type CommandHandlerMap = Map<string, CommandHandler>;
