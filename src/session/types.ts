/**
 * Session management types and interfaces
 */

import type { ClaudeCli } from '../claude/cli.js';
import type { PlatformClient, PlatformFile } from '../platform/index.js';
import type { WorktreeInfo } from '../persistence/session-store.js';
import type { SessionInfo } from '../ui/types.js';
import type { RecentEvent, ErrorContext } from '../operations/bug-report/index.js';
import type { ThreadLogger } from '../persistence/thread-logger.js';
import type { MessageManager } from '../operations/message-manager.js';
import type { QuestionOption } from '../operations/types.js';
import type { SessionTimers } from './timer-manager.js';

// Re-export timer types
export type { SessionTimers };
export { createSessionTimers, clearAllTimers } from './timer-manager.js';

// =============================================================================
// Initial Session Options (for commands in first message)
// =============================================================================

/**
 * Options that can be set by commands in the first message.
 * These are parsed from the initial @mention message and applied before session creation.
 */
export interface InitialSessionOptions {
  /** Override working directory (from !cd command) */
  workingDir?: string;
  /** Force interactive permissions (from !permissions interactive) */
  forceInteractivePermissions?: boolean;
  /** Switch to existing worktree instead of creating new (from !worktree switch) */
  switchToExisting?: boolean;
}

// =============================================================================
// Model and Usage Types
// =============================================================================

/**
 * Token usage for a single model
 */
export interface ModelTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  contextWindow: number;  // Maximum context window size
  costUSD: number;
}

/**
 * Aggregated usage stats from Claude CLI result events
 */
export interface SessionUsageStats {
  /** Primary model being used (e.g., "claude-opus-4-5-20251101") */
  primaryModel: string;
  /** Display name for the model (e.g., "Opus 4.5") */
  modelDisplayName: string;
  /** Maximum context window size */
  contextWindowSize: number;
  /** Estimated context tokens (primary model input + cache read only) */
  contextTokens: number;
  /** Total tokens used (input + output across all models, for billing display) */
  totalTokensUsed: number;
  /** Total cost in USD */
  totalCostUSD: number;
  /** Per-model usage breakdown */
  modelUsage: Record<string, ModelTokenUsage>;
  /** Last update timestamp */
  lastUpdated: Date;
}

// =============================================================================
// Interactive State Types
// =============================================================================

export interface PendingQuestionSet {
  toolUseId: string;
  currentIndex: number;
  currentPostId: string | null;
  questions: Array<{
    header: string;
    question: string;
    options: QuestionOption[];
    answer: string | null;
  }>;
}

/**
 * Pending prompt after worktree creation failed, asking user what to do
 */
export interface PendingWorktreeFailurePrompt {
  postId: string;
  failedBranch: string;
  errorMessage: string;
  username: string;  // User who triggered the original request
}

/**
 * Pending worktree prompt with branch suggestions
 */
export interface PendingWorktreeSuggestions {
  postId: string;
  suggestions: string[];  // Array of suggested branch names (0-3)
}

// =============================================================================
// Side Conversation Types
// =============================================================================

/**
 * A side conversation message (not directed at the bot).
 * These are messages from approved users that start with @someone-else.
 * They are tracked and included as context with the next message to Claude.
 */
export interface SideConversation {
  /** Username of the person who sent the message */
  fromUser: string;
  /** Username of the person who was @mentioned (not the bot) */
  mentionedUser: string;
  /** The message content */
  message: string;
  /** When the message was sent */
  timestamp: Date;
  /** Post ID for deduplication */
  postId: string;
}

// =============================================================================
// Session Lifecycle State Machine
// =============================================================================

/**
 * Possible states in the session lifecycle.
 *
 * State transitions:
 * - starting -> active (on first Claude response)
 * - active -> processing (when Claude is processing)
 * - processing -> active (when Claude finishes)
 * - active/processing -> paused (on timeout or interrupt)
 * - active/processing -> restarting (on !cd, !permissions, etc.)
 * - active/processing -> cancelling (on !stop or cancel emoji)
 * - any -> ending (cleanup in progress)
 */
export type SessionLifecycleState =
  | 'starting'      // Session is being created
  | 'active'        // Normal operation, idle
  | 'processing'    // Claude is processing a request
  | 'paused'        // Timed out or interrupted, waiting for resume
  | 'interrupted'   // User interrupted (escape), Claude stopped
  | 'restarting'    // Being restarted (e.g., !cd)
  | 'cancelling'    // Being cancelled
  | 'ending';       // Cleanup in progress

/**
 * Session lifecycle state container.
 * Replaces scattered boolean flags with a single state machine.
 */
export interface SessionLifecycle {
  /** Current lifecycle state */
  state: SessionLifecycleState;
  /** Count of consecutive resume failures (only relevant when paused) */
  resumeFailCount: number;
  /** Whether Claude has responded at least once (safe to persist) */
  hasClaudeResponded: boolean;
}

/**
 * Create a new SessionLifecycle with default starting state.
 */
export function createSessionLifecycle(): SessionLifecycle {
  return {
    state: 'starting',
    resumeFailCount: 0,
    hasClaudeResponded: false,
  };
}

/**
 * Create a SessionLifecycle for a resumed session.
 */
export function createResumedLifecycle(resumeFailCount: number = 0): SessionLifecycle {
  return {
    state: 'active',
    resumeFailCount,
    hasClaudeResponded: true, // Resumed sessions have already had responses
  };
}

/**
 * Check if session is being restarted (suppress exit handlers).
 */
export function isSessionRestarting(session: Session): boolean {
  return session.lifecycle.state === 'restarting';
}

/**
 * Check if session has been cancelled.
 */
export function isSessionCancelled(session: Session): boolean {
  return session.lifecycle.state === 'cancelling';
}

/**
 * Transition session to a new lifecycle state.
 */
export function transitionTo(session: Session, newState: SessionLifecycleState): void {
  session.lifecycle.state = newState;
}

/**
 * Mark that Claude has responded (session is now safe to persist).
 */
export function markClaudeResponded(session: Session): void {
  session.lifecycle.hasClaudeResponded = true;
  // Also transition from starting to active if needed
  if (session.lifecycle.state === 'starting') {
    session.lifecycle.state = 'active';
  }
}

// =============================================================================
// Session Type
// =============================================================================

/**
 * Represents a single Claude Code session tied to a platform thread.
 * Each session has its own Claude CLI process and state.
 */
export interface Session {
  // Identity
  platformId: string;       // Which platform instance (e.g., 'mattermost-main')
  threadId: string;         // Thread ID within that platform
  sessionId: string;        // Composite key "platformId:threadId"
  claudeSessionId: string;  // UUID for --session-id / --resume
  startedBy: string;            // Username (for permissions)
  startedByDisplayName?: string; // Display name (for UI)
  startedAt: Date;
  lastActivityAt: Date;
  sessionNumber: number;  // Session # when created

  // Platform reference
  platform: PlatformClient;  // Reference to platform client

  // Working directory (can be changed per-session)
  workingDir: string;

  // Claude process
  claude: ClaudeCli;

  // Interactive state (collaboration - not Claude events)
  planApproved: boolean;

  // Collaboration - per-session allowlist
  sessionAllowedUsers: Set<string>;

  // Permission override - can only downgrade (skip → interactive), not upgrade
  forceInteractivePermissions: boolean;

  // Display state
  sessionStartPostId: string | null;  // The header post we update with participants

  // Timer management (centralized)
  timers: SessionTimers;

  // Lifecycle state machine (replaces scattered boolean flags)
  lifecycle: SessionLifecycle;

  // Timeout warning state
  timeoutWarningPosted: boolean;

  // Worktree support
  worktreeInfo?: WorktreeInfo;              // Active worktree info
  isWorktreeOwner?: boolean;                // True if this session CREATED the worktree (vs joining existing)
  pendingWorktreePrompt?: boolean;          // Waiting for branch name response
  worktreePromptDisabled?: boolean;         // User opted out with !worktree off
  queuedPrompt?: string;                    // User's original message when waiting for worktree response
  queuedFiles?: PlatformFile[];             // Files attached to the queued prompt (for images)
  worktreePromptPostId?: string;            // Post ID of the worktree prompt (for ❌ reaction)
  worktreeResponsePostId?: string;          // Post ID of user's worktree branch response (to exclude from context)
  firstPrompt?: string;                     // First user message, sent again after mid-session worktree creation
  pendingWorktreeFailurePrompt?: PendingWorktreeFailurePrompt;  // Waiting for user to decide after worktree creation failed
  pendingWorktreeSuggestions?: PendingWorktreeSuggestions; // Branch suggestions for worktree prompt

  // Thread context prompt support
  needsContextPromptOnNextMessage?: boolean;   // Offer context prompt on next follow-up message (after !cd)
  previousWorkSummary?: string;                // Summary of work done before directory change (for context preservation)

  // Resume support
  lifecyclePostId?: string;  // Post ID of timeout message (for resume via reaction)

  // Compaction support
  compactionPostId?: string;  // Post ID of "Compacting..." message (for updating on completion)

  // Session title and description (auto-generated via quickQuery)
  sessionTitle?: string;       // Short title describing the session topic (3-6 words)
  sessionDescription?: string; // Longer description of what's happening (1-2 sentences)
  sessionTags?: string[];      // Auto-generated classification tags (e.g., 'bug-fix', 'feature')

  // Pull request URL (detected from Claude output when PR is created)
  pullRequestUrl?: string;     // Full URL to the PR (GitHub, GitLab, Bitbucket, Azure DevOps, etc.)

  // Message counter for periodic reminders
  messageCount: number;  // Number of user messages sent to Claude in this session

  // Processing state - true when Claude is actively processing a request
  isProcessing: boolean;

  // Usage stats from Claude CLI (updated on each result event)
  usageStats?: SessionUsageStats;

  // Last message posted to the thread (for jump-to-bottom links)
  lastMessageId?: string;
  lastMessageTs?: string;  // For Slack: timestamp of last message (needed for permalink)

  // Bug reporting support
  recentEvents: RecentEvent[];            // Circular buffer of recent events (max 10)
  lastError?: ErrorContext;               // Most recent error for bug reaction

  // Thread logging
  threadLogger?: ThreadLogger;            // Logger for persisting events to disk

  // Side conversation tracking
  // Messages from approved users that are directed at other users (not the bot).
  // These are included as context with the next message sent to Claude.
  pendingSideConversations?: SideConversation[];

  // Dynamic slash commands (populated from Claude CLI init event)
  // Commands like /context, /cost, /compact, /init, /review, etc.
  availableSlashCommands?: Set<string>;

  /**
   * MessageManager for handling operations (content, tasks, questions, subagents).
   * Optional because it's assigned immediately after Session creation.
   * Always present in running sessions.
   */
  messageManager?: MessageManager;
}

// =============================================================================
// Status Helpers
// =============================================================================

/**
 * Compute the UI status for a session based on its state.
 */
export function getSessionStatus(session: Session): SessionInfo['status'] {
  if (session.isProcessing) {
    return session.lifecycle.hasClaudeResponded ? 'active' : 'starting';
  }
  return 'idle';
}
