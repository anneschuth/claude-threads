/**
 * Claude event handling module
 *
 * Handles pre/post processing of Claude events, session-specific side effects,
 * and specialized features like compaction handling.
 *
 * NOTE: Main event handling (formatting, tool handling) is done by MessageManager.
 * This module handles session-specific side effects that wrap MessageManager.
 */

import type { Session, SessionUsageStats, ModelTokenUsage } from '../../session/types.js';
import { getSessionStatus, markClaudeResponded } from '../../session/types.js';
import type { ClaudeEvent } from '../../claude/cli.js';
import { shortenPath } from '../index.js';
import { withErrorHandling } from '../../utils/error-handler/index.js';
import { resetSessionActivity, post, postError, updatePost } from '../post-helpers/index.js';
import type { SessionContext } from '../session-context/index.js';
import { createLogger } from '../../utils/logger.js';
import { auditDetailForTool, auditLog, isAuditEnabled } from '../../persistence/audit-log.js';
import { createSessionLog } from '../../utils/session-log.js';
import { extractPullRequestUrl } from '../../utils/pr-detector.js';
import { changeDirectory, reportBug } from '../commands/index.js';
import { buildWorktreeListMessage } from '../worktree/index.js';
import { trackEvent } from '../bug-report/index.js';
import { parseClaudeCommand, removeCommandFromText, isClaudeAllowedCommand } from '../../commands/index.js';

const log = createLogger('events');
const sessionLog = createSessionLog(log);

// ---------------------------------------------------------------------------
// Claude command detection
// ---------------------------------------------------------------------------

/**
 * Detect and execute commands from Claude's assistant output.
 * Uses the shared command parser with Claude's allowlist.
 * Returns the text with the command removed (if executed), or original text.
 */
function detectAndExecuteClaudeCommands(
  text: string,
  session: Session,
  ctx: SessionContext
): string {
  const parsed = parseClaudeCommand(text);

  if (parsed && isClaudeAllowedCommand(parsed.command)) {
    sessionLog(session).info(`🤖 Claude executing !${parsed.command} ${parsed.args || ''}`);

    // Execute the command asynchronously
    executeClaudeCommand(session, parsed.command, parsed.args || '', ctx);

    // Remove the command from the displayed text
    return removeCommandFromText(text, parsed);
  }

  return text;
}

/**
 * Execute a command on behalf of Claude.
 * Posts a visibility message and runs the command.
 * For commands that produce output, sends the result back to Claude.
 *
 * Only commands in CLAUDE_ALLOWED_COMMANDS can be executed.
 */
async function executeClaudeCommand(
  session: Session,
  command: string,
  args: string,
  ctx: SessionContext
): Promise<void> {
  const formatter = session.platform.getFormatter();

  // Post visibility message so users can see what Claude is doing
  const worktreeContext = session.worktreeInfo
    ? { path: session.worktreeInfo.worktreePath, branch: session.worktreeInfo.branch }
    : undefined;
  const shortArgs = args ? shortenPath(args, undefined, worktreeContext) : '';
  const visibilityMessage = `🤖 ${formatter.formatBold('Claude executed:')} ${formatter.formatCode(`!${command}${shortArgs ? ' ' + shortArgs : ''}`)}`;

  await withErrorHandling(
    () => post(session, 'info', visibilityMessage),
    { action: 'Post Claude command visibility', session }
  );

  // Execute the command based on type
  switch (command) {
    case 'cd':
      // Use session owner's permissions
      // Note: This restarts Claude, so no result can be sent back
      await changeDirectory(session, args, session.startedBy, ctx);
      break;

    case 'worktree list': {
      // Get worktree list and send result back to Claude
      const message = await buildWorktreeListMessage(session);
      if (message === null) {
        await postError(session, `Current directory is not a git repository`);
        // Send error back to Claude too
        if (session.claude?.isRunning()) {
          session.claude.sendMessage(`<command-result command="!worktree list">\nError: Current directory is not a git repository\n</command-result>`);
        }
      } else {
        await post(session, 'info', message);
        // Send the result back to Claude so it can see the worktree list
        if (session.claude?.isRunning()) {
          // Use plain text version for Claude (strip markdown formatting for clarity)
          const plainMessage = message
            .replace(/\*\*([^*]+)\*\*/g, '$1')  // Remove bold
            .replace(/`([^`]+)`/g, '$1');       // Remove code formatting
          session.claude.sendMessage(`<command-result command="!worktree list">\n${plainMessage}\n</command-result>`);
          sessionLog(session).info(`📤 Sent worktree list result back to Claude`);
        }
      }
      break;
    }

    case 'bug':
      // Claude can report bugs it encounters
      await reportBug(session, args, session.startedBy, ctx);
      break;
  }
}

/**
 * Extract and update pull request URL from text.
 * Unlike title/description, PR URLs are detected from the actual content
 * (not from special markers), as Claude outputs them when running gh pr create.
 *
 * Only updates if we don't already have a PR URL (first one wins).
 */
function extractAndUpdatePullRequest(
  text: string,
  session: Session,
  ctx: SessionContext
): void {
  // Skip if we already have a PR URL
  if (session.pullRequestUrl) return;

  const prUrl = extractPullRequestUrl(text);
  if (prUrl) {
    session.pullRequestUrl = prUrl;
    sessionLog(session).info(`🔗 Detected PR URL: ${prUrl}`);

    // Persist and update UI
    ctx.ops.persistSession(session);
    ctx.ops.updateStickyMessage().catch(() => {});
    ctx.ops.updateSessionHeader(session).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Pre/Post Processing for MessageManager integration
// ---------------------------------------------------------------------------

/**
 * True for events forwarded from a subagent's sidechain: some CLI versions
 * relay subagent activity as assistant/user events carrying
 * `parent_tool_use_id`. The transformer skips them entirely; the handlers
 * here exclude them from command execution and bug-report tracking (thread
 * logging and PR-URL extraction intentionally still see them).
 */
function isSidechainEvent(event: ClaudeEvent): boolean {
  return Boolean((event as { parent_tool_use_id?: unknown }).parent_tool_use_id);
}

/**
 * Pre-processing for events when using MessageManager.
 * Handles session-specific side effects that should run BEFORE the main event handling.
 */
export function handleEventPreProcessing(
  session: Session,
  event: ClaudeEvent,
  ctx: SessionContext
): void {
  // Log raw event to thread logger (first thing, before any processing)
  session.threadLogger?.logEvent(event);

  // Audit trail (opt-in per platform): record every tool call, including
  // subagent sidechains — an auditor wants the full execution record even
  // when the thread display skips it. The whole tap is wrapped so a
  // pathological event shape can never throw past it and skip message
  // handling — auditing must never take the message path down.
  try {
    if (isAuditEnabled(session.platformId)) {
      const subagent = isSidechainEvent(event) || undefined;
      const record = (name: string, input: Record<string, unknown> | undefined) =>
        auditLog(session.platformId, {
          threadId: session.threadId,
          sessionId: session.sessionId,
          actor: session.lastActorUsername ?? session.startedBy,
          kind: 'tool_use',
          tool: name,
          detail: auditDetailForTool(name, input),
          subagent,
        });
      if (event.type === 'assistant') {
        const msg = event.message as { content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }> };
        if (Array.isArray(msg?.content)) {
          for (const block of msg.content) {
            if ((block.type === 'tool_use' || block.type === 'server_tool_use') && block.name) {
              record(block.name, block.input);
            }
          }
        }
      } else if (event.type === 'tool_use') {
        const tool = event.tool_use as { name: string; input?: Record<string, unknown> };
        if (tool?.name) record(tool.name, tool.input);
      }
    }
  } catch {
    // Swallowed by design — see the comment above.
  }

  // Reset activity and clear timeout tracking (prevents updating stale posts in long threads)
  resetSessionActivity(session);

  // On first meaningful response from Claude, mark session as safe to resume and persist
  if (!session.lifecycle.hasClaudeResponded && (event.type === 'assistant' || event.type === 'tool_use')) {
    markClaudeResponded(session);
    ctx.ops.persistSession(session);
    ctx.ops.emitSessionUpdate(session.sessionId, { status: getSessionStatus(session) });
  }

  // Handle system events specially
  if (event.type === 'system') {
    const e = event as ClaudeEvent & {
      subtype?: string;
      status?: string;
      compact_metadata?: unknown;
      slash_commands?: string[];
      model?: string;
    };

    // Capture the current model from init events (re-emitted per turn, so a
    // /model switch is reflected on the very next turn — see captures).
    if (e.subtype === 'init' && typeof e.model === 'string') {
      session.currentModel = e.model;
    }

    // Capture available slash commands from init event
    if (e.subtype === 'init' && e.slash_commands && Array.isArray(e.slash_commands)) {
      session.availableSlashCommands = new Set(
        e.slash_commands.map((cmd: string) =>
          cmd.startsWith('/') ? cmd.slice(1) : cmd
        )
      );
      sessionLog(session).info(
        `Captured ${session.availableSlashCommands.size} slash commands from init: ${[...session.availableSlashCommands].join(', ')}`
      );
    }

    // Handle compaction events. Captured sequence (real CLI 2.1.226, see
    // tests/integration/fixtures/real-cli-captures/compact.jsonl):
    //   status "compacting" → status {compact_result: "success"} →
    //   system/compact_boundary {compact_metadata}
    // On failure there is NO boundary — just status {compact_result:
    // "failed", compact_error}, which must resolve the start post too.
    if (e.subtype === 'status' && e.status === 'compacting') {
      handleCompactionStart(session, ctx);
    }
    if (e.subtype === 'status' && (e as { compact_result?: string }).compact_result === 'failed') {
      handleCompactionFailed(session, (e as { compact_error?: string }).compact_error, ctx);
    }
    if (e.subtype === 'compact_boundary') {
      handleCompactionComplete(session, e.compact_metadata, ctx);
    }
  }

  // Auth status (SDKAuthStatusMessage: shape from @anthropic-ai/claude-agent-sdk
  // 0.3.226 — not provocable in a healthy environment, so no capture). An
  // error here means the session's CLI can't authenticate (expired OAuth,
  // revoked key) — surface it in the thread; progress-only updates just log.
  if (event.type === 'auth_status') {
    const e = event as ClaudeEvent & {
      isAuthenticating?: boolean;
      output?: string[];
      error?: string;
    };
    if (e.error) {
      sessionLog(session).warn(`🔐 Claude CLI auth error: ${e.error}`);
      // auth_status is progress-style (output[] accumulates lines), so a
      // persistently-broken credential may emit the same error repeatedly —
      // post each distinct error once.
      if (session.lastAuthErrorPosted !== e.error) {
        session.lastAuthErrorPosted = e.error;
        void withErrorHandling(
          () => post(session, 'warning', `🔐 Claude CLI authentication problem: ${e.error}`),
          { action: 'Post auth status warning', session }
        );
      }
    } else {
      sessionLog(session).info(
        `🔐 Claude CLI auth status: authenticating=${e.isAuthenticating ?? false}${e.output?.length ? ` (${e.output[e.output.length - 1]})` : ''}`
      );
    }
  }

  // Track tool use events for bug reporting context. The real CLI delivers
  // tool uses as blocks inside assistant events; top-level tool_use events
  // are a legacy shape kept for old captures and test fixtures. Sidechain
  // (subagent) events are excluded, matching the transformer: a bug report
  // listing 40 subagent Reads the thread never displayed is misleading.
  if (event.type === 'assistant' && !isSidechainEvent(event)) {
    const msg = event.message as {
      content?: Array<{ type: string; name?: string }>;
    };
    if (Array.isArray(msg?.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.name) {
          trackEvent(session, 'tool_use', block.name);
        }
      }
    }
  }
  if (event.type === 'tool_use') {
    const tool = event.tool_use as { name: string };
    trackEvent(session, 'tool_use', tool.name);
  }
}

/**
 * Post-processing for events when using MessageManager.
 * Handles session-specific side effects that should run AFTER the main event handling.
 */
export function handleEventPostProcessing(
  session: Session,
  event: ClaudeEvent,
  ctx: SessionContext,
  mainHandling?: Promise<void>
): void {
  // Handle assistant events - extract PR URLs, detect commands
  if (event.type === 'assistant') {
    const msg = event.message as {
      content?: Array<{ type: string; text?: string }>;
    };
    for (const block of msg?.content || []) {
      if (block.type === 'text' && block.text) {
        // Detect and store pull request URLs. Sidechain (subagent) text is
        // included on purpose — a PR opened by a subagent is still this
        // session's PR.
        extractAndUpdatePullRequest(block.text, session, ctx);
        // Detect and execute Claude commands (e.g., !cd) — but never from
        // sidechain text: the transformer doesn't display subagent output,
        // and invisible output must not drive visible side effects like a
        // directory change that respawns Claude.
        if (!isSidechainEvent(event)) {
          detectAndExecuteClaudeCommands(block.text, session, ctx);
        }
      }
    }
  }

  // Handle result events - stop typing, update UI, extract usage
  if (event.type === 'result') {
    ctx.ops.stopTyping(session);
    session.isProcessing = false;
    ctx.ops.emitSessionUpdate(session.sessionId, { status: getSessionStatus(session) });
    updateUsageStats(session, event, ctx);
    // Persist at every turn end so the incremental task-tracker snapshot
    // (and usage/cost state) survives a bot restart. The CLI only runs while
    // the bot runs, so turn-end persistence can't go stale. Cost note: each
    // persist is a synchronous read-modify-write of the whole sessions.json
    // (atomic temp+rename) — small in practice, but O(total persisted
    // history) per turn end.
    //
    // The persist MUST wait for the main event handling to settle: the
    // result event's StatusUpdateOp runs taskListExecutor.finalize() inside
    // that promise (deleting an incomplete task post and nulling its state),
    // and persisting before it would snapshot exactly the state finalize is
    // about to invalidate — a tasksPostId pointing at a deleted post.
    if (mainHandling) {
      void mainHandling
        .catch(() => { /* op-chain errors are logged in MessageManager; still persist */ })
        .then(() => {
          // The session may have been torn down while mainHandling settled —
          // the CLI can exit milliseconds after its result event, and
          // handleExit then runs removeFromRegistry + softDelete before this
          // deferred persist lands. Re-saving here would resurrect the
          // soft-deleted record as active, so a later reply in the thread
          // resumes a session the bot just ended. Skip once unregistered.
          if (!ctx.state.sessions.has(session.sessionId)) return;
          ctx.ops.persistSession(session);
        });
    } else {
      ctx.ops.persistSession(session);
    }
  }

  // Track tool errors for bug reporting context. The real CLI delivers tool
  // results as blocks inside user events; top-level tool_result events are a
  // legacy shape kept for old captures and test fixtures. Sidechain events
  // are excluded, matching the tool_use tracking above.
  if (event.type === 'user' && !isSidechainEvent(event)) {
    const msg = event.message as {
      content?: Array<{ type: string; is_error?: boolean }> | string;
    };
    if (Array.isArray(msg?.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result' && block.is_error) {
          trackEvent(session, 'tool_error', 'Tool execution failed');
        }
      }
    }
  }
  if (event.type === 'tool_result') {
    const result = event.tool_result as { is_error?: boolean };
    if (result.is_error) {
      trackEvent(session, 'tool_error', 'Tool execution failed');
    }
  }

  // Handle system errors
  if (event.type === 'system') {
    const e = event as ClaudeEvent & { subtype?: string; error?: string };
    if (e.subtype === 'error') {
      trackEvent(session, 'system_error', String(e.error).substring(0, 80));
    }
  }

}

// ---------------------------------------------------------------------------
// Compaction handling
// ---------------------------------------------------------------------------

/**
 * Handle compaction start - create a dedicated post that we can update later.
 */
function handleCompactionStart(
  session: Session,
  _ctx: SessionContext
): void {
  // The promise is assigned SYNCHRONOUSLY so a failure/boundary event
  // dispatched in the same stdout chunk can await the start post before
  // deciding update-vs-new-post (see compactionPostPromise in types.ts).
  session.compactionPostPromise = (async () => {
    // Close current post (flushes pending content) to avoid mixing with compaction message
    await session.messageManager?.closeCurrentPost();

    const formatter = session.platform.getFormatter();
    const message = `🗜️ ${formatter.formatBold('Compacting context...')} ${formatter.formatItalic('(freeing up memory)')}`;
    const compactionPost = await withErrorHandling(
      () => post(session, 'info', message),
      { action: 'Post compaction start', session }
    );

    if (compactionPost) {
      session.compactionPostId = compactionPost.id;
      // Note: post() already calls updateLastMessage internally
    }
  })();
}

/** Wait for an in-flight start post so resolution targets it, never races it. */
async function awaitCompactionStartPost(session: Session): Promise<void> {
  if (session.compactionPostPromise) {
    await session.compactionPostPromise.catch(() => {});
    session.compactionPostPromise = undefined;
  }
}

/**
 * Handle compaction failure - resolve the compaction post so it doesn't sit
 * at "Compacting context..." forever. A failed compact emits NO
 * compact_boundary (verified against CLI 2.1.226, compact-failed.jsonl):
 * only a status event with
 * compact_result: "failed" and a compact_error.
 */
async function handleCompactionFailed(
  session: Session,
  compactError: string | undefined,
  _ctx: SessionContext
): Promise<void> {
  await awaitCompactionStartPost(session);

  const formatter = session.platform.getFormatter();
  const reason = compactError || 'unknown error';
  const message = `⚠️ ${formatter.formatBold('Compaction failed')} ${formatter.formatItalic(`(${reason})`)}`;

  const startPostId = session.compactionPostId;
  if (startPostId) {
    await withErrorHandling(
      () => updatePost(session, startPostId, message),
      { action: 'Update compaction post (failed)', session }
    );
    session.compactionPostId = undefined;
  } else {
    await withErrorHandling(
      () => post(session, 'info', message),
      { action: 'Post compaction failure', session }
    );
  }
}

/**
 * Handle compaction complete - update the existing compaction post.
 */
async function handleCompactionComplete(
  session: Session,
  compactMetadata: unknown,
  _ctx: SessionContext
): Promise<void> {
  await awaitCompactionStartPost(session);

  // Build the completion message with metadata
  const metadata = compactMetadata as { trigger?: string; pre_tokens?: number; post_tokens?: number } | undefined;
  const trigger = metadata?.trigger || 'auto';
  const preTokens = metadata?.pre_tokens;
  const postTokens = metadata?.post_tokens;
  let info = trigger === 'manual' ? 'manual' : 'auto';
  if (preTokens && preTokens > 0 && postTokens && postTokens > 0) {
    // e.g. "31k → 3k tokens" (real capture: 31103 → 2777)
    info += `, ${Math.round(preTokens / 1000)}k → ${Math.max(1, Math.round(postTokens / 1000))}k tokens`;
  } else if (preTokens && preTokens > 0) {
    info += `, ${Math.round(preTokens / 1000)}k tokens`;
  }
  const formatter = session.platform.getFormatter();
  const completionMessage = `✅ ${formatter.formatBold('Context compacted')} ${formatter.formatItalic(`(${info})`)}`;

  if (session.compactionPostId) {
    // Update the existing compaction post
    await updatePost(session, session.compactionPostId, completionMessage);
    session.compactionPostId = undefined;
  } else {
    // Fallback: create a new post if we don't have the original
    // Note: post() already calls updateLastMessage internally
    await withErrorHandling(
      () => post(session, 'info', completionMessage),
      { action: 'Post compaction complete', session }
    );
  }
}

// ---------------------------------------------------------------------------
// Usage stats extraction
// ---------------------------------------------------------------------------

/**
 * Result event structure from Claude CLI
 */
interface ResultEvent {
  type: 'result';
  subtype?: string;
  total_cost_usd?: number;
  /** Per-request token usage (accurate for context window calculation) */
  usage?: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
  };
  /** Cumulative billing per model across the session */
  modelUsage?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    contextWindow: number;
    costUSD: number;
  }>;
}

/**
 * Convert model ID to display name
 * e.g., "claude-opus-4-5-20251101" -> "Opus 4.5"
 */
function getModelDisplayName(modelId: string): string {
  // Modern ids: claude-<family>-<major>[-<minor>][-<yyyymmdd>]
  // e.g. claude-sonnet-5 → "Sonnet 5", claude-haiku-4-5-20251001 → "Haiku 4.5".
  // Generic parse instead of a hardcoded family list so a new family
  // (fable, ...) renders correctly without a code change.
  // Minor is capped at 2 digits so the optional group can't swallow an
  // 8-digit date suffix (claude-sonnet-4-20250514 must be "Sonnet 4",
  // never "Sonnet 4.20250514").
  const modern = modelId.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/);
  if (modern) {
    const family = modern[1].charAt(0).toUpperCase() + modern[1].slice(1);
    return modern[3] ? `${family} ${modern[2]}.${modern[3]}` : `${family} ${modern[2]}`;
  }
  // Legacy ids (version-first, e.g. claude-3-5-sonnet-20241022)
  if (modelId.includes('sonnet')) return 'Sonnet';
  if (modelId.includes('opus')) return 'Opus';
  if (modelId.includes('haiku')) return 'Haiku';
  const match = modelId.match(/claude-(\w+)/);
  return match ? match[1].charAt(0).toUpperCase() + match[1].slice(1) : modelId;
}

/**
 * Extract usage stats from a result event and update session
 */
function updateUsageStats(
  session: Session,
  event: ClaudeEvent,
  ctx: SessionContext
): void {
  const result = event as ResultEvent;

  if (!result.modelUsage) return;

  // Find the primary model (highest cost, usually the main model)
  let primaryModel = '';
  let highestCost = 0;
  let contextWindowSize = 200000; // Default

  const modelUsage: Record<string, ModelTokenUsage> = {};
  let totalTokensUsed = 0;

  for (const [modelId, usage] of Object.entries(result.modelUsage)) {
    modelUsage[modelId] = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      contextWindow: usage.contextWindow,
      costUSD: usage.costUSD,
    };

    // Sum all tokens (for billing display)
    totalTokensUsed += usage.inputTokens + usage.outputTokens +
      usage.cacheReadInputTokens + usage.cacheCreationInputTokens;

    // Track primary model by highest cost
    if (usage.costUSD > highestCost) {
      highestCost = usage.costUSD;
      primaryModel = modelId;
      contextWindowSize = usage.contextWindow;
    }
  }

  // The current model (from the per-turn init event) beats the cost
  // heuristic: after a /model switch the old model keeps the larger
  // cumulative spend, but the header must show what the session runs NOW.
  if (session.currentModel && result.modelUsage[session.currentModel]) {
    primaryModel = session.currentModel;
    contextWindowSize = result.modelUsage[session.currentModel].contextWindow;
  }

  // Calculate context tokens from per-request usage (accurate)
  // Falls back to primary model's cumulative tokens if usage not available
  let contextTokens = 0;
  if (result.usage) {
    // Per-request usage: actual tokens in current context window
    contextTokens = result.usage.input_tokens +
      result.usage.cache_creation_input_tokens +
      result.usage.cache_read_input_tokens;
  } else if (primaryModel && result.modelUsage[primaryModel]) {
    // Fallback: estimate from primary model's cumulative billing
    const primary = result.modelUsage[primaryModel];
    contextTokens = primary.inputTokens + primary.cacheReadInputTokens;
  }

  // Create or update usage stats
  const usageStats: SessionUsageStats = {
    primaryModel,
    modelDisplayName: getModelDisplayName(primaryModel),
    contextWindowSize,
    contextTokens,
    totalTokensUsed,
    totalCostUSD: result.total_cost_usd || 0,
    modelUsage,
    lastUpdated: new Date(),
  };

  session.usageStats = usageStats;

  const contextPct = contextWindowSize > 0
    ? Math.round((contextTokens / contextWindowSize) * 100)
    : 0;
  sessionLog(session).info(
    `Updated usage stats: ${usageStats.modelDisplayName}, ` +
    `context ${contextTokens}/${contextWindowSize} (${contextPct}%), ` +
    `$${usageStats.totalCostUSD.toFixed(4)}`
  );

  // Start periodic status bar timer if not already running
  if (!session.timers.statusBarTimer) {
    const STATUS_BAR_UPDATE_INTERVAL = 30000; // 30 seconds
    session.timers.statusBarTimer = setInterval(() => {
      // Only update if session is still active
      if (session.claude.isRunning()) {
        // Try to get more accurate context data from status line
        updateUsageFromStatusLine(session);
        ctx.ops.updateSessionHeader(session).catch(() => {});
      }
    }, STATUS_BAR_UPDATE_INTERVAL);
  }

  // Update status bar with new usage info
  ctx.ops.updateSessionHeader(session).catch(() => {});
}

/**
 * Update usage stats from the status line file if available.
 * This provides more accurate context window usage than result events.
 */
function updateUsageFromStatusLine(session: Session): void {
  const statusData = session.claude.getStatusData();
  if (!statusData) return;

  // Only update if we have existing usage stats
  if (!session.usageStats) return;

  // Use total_input_tokens which represents the cumulative context usage
  // (not current_usage which is just the per-request tokens)
  const contextTokens = statusData.total_input_tokens || 0;

  // Update context tokens if the status line data is newer
  if (statusData.timestamp > session.usageStats.lastUpdated.getTime()) {
    session.usageStats.contextTokens = contextTokens;
    session.usageStats.contextWindowSize = statusData.context_window_size;
    session.usageStats.lastUpdated = new Date(statusData.timestamp);

    // Update model info if available
    if (statusData.model) {
      session.usageStats.primaryModel = statusData.model.id;
      session.usageStats.modelDisplayName = statusData.model.display_name;
    }

    // Update cost if available
    if (statusData.cost) {
      session.usageStats.totalCostUSD = statusData.cost.total_cost_usd;
    }

    const contextPct = session.usageStats.contextWindowSize > 0
      ? Math.round((contextTokens / session.usageStats.contextWindowSize) * 100)
      : 0;
    sessionLog(session).debug(
      `Updated from status line: context ${contextTokens}/${session.usageStats.contextWindowSize} (${contextPct}%)`
    );
  }
}

