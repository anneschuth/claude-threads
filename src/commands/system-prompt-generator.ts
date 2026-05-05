/**
 * System Prompt Generator
 *
 * Generates the chat platform system prompt from the unified command registry.
 * This ensures Claude's knowledge of commands stays in sync with actual behavior.
 */

import { VERSION } from '../version.js';
import {
  COMMAND_REGISTRY,
  getClaudeExecutableCommands,
  getClaudeAvoidCommands,
  type CommandDefinition,
} from './registry.js';
import type { PlatformClient } from '../platform/client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('system-prompt');

/**
 * Format a command for the user commands section of the system prompt.
 */
function formatUserCommand(cmd: CommandDefinition): string {
  const cmdStr = cmd.args ? `\`!${cmd.command} ${cmd.args}\`` : `\`!${cmd.command}\``;

  // For commands with simple descriptions, use inline format
  // For special cases (like !approve with alternative), add that info
  const description = cmd.description;
  if (cmd.command === 'approve') {
    return `- ${cmdStr} or 👍 reaction: Approve pending plan`;
  }
  if (cmd.command === 'stop') {
    return `- ${cmdStr} or ❌ reaction: End the current operation`;
  }
  if (cmd.command === 'escape') {
    return `- ${cmdStr} or ⏸️ reaction: Interrupt without ending the session`;
  }

  return `- ${cmdStr}: ${description}`;
}

/**
 * Format a command for Claude's executable commands section.
 */
function formatClaudeCommand(cmd: CommandDefinition): string {
  const cmdStr = cmd.args ? `\`!${cmd.command} ${cmd.args}\`` : `\`!${cmd.command}\``;
  let line = `- ${cmdStr}`;

  if (cmd.command === 'worktree' && cmd.subcommands) {
    // Special case: only list is useful for Claude
    line = '- `!worktree list` - List all worktrees. Result is sent back to you in a <command-result> tag.';
  } else if (cmd.claudeNotes) {
    line += ` - ${cmd.claudeNotes}`;
  } else {
    line += ` - ${cmd.description}`;
  }

  return line;
}

/**
 * Build session context line for the system prompt.
 *
 * The `**Thread:**` URL gives Claude a stable handle for the conversation it
 * is running inside. It is included so Claude can reference the chat from
 * artifacts it produces — e.g. paste it into the description of a merge
 * request or ticket so reviewers can trace the work back to the discussion.
 */
export function buildSessionContext(
  platform: {
    platformType: string;
    displayName: string;
    getThreadLink(threadId: string): string;
  },
  workingDir: string,
  threadId: string,
): string {
  const platformName = platform.platformType.charAt(0).toUpperCase() + platform.platformType.slice(1);
  const threadUrl = platform.getThreadLink(threadId);
  return `**Platform:** ${platformName} (${platform.displayName}) | **Working Directory:** ${workingDir} | **Thread:** ${threadUrl}`;
}

/**
 * Resolved collaborator with the data we need for a Co-Authored-By trailer.
 * `name` falls back to username when displayName is missing; `email` is required
 * (collaborators without an email cannot be tagged as co-author).
 */
export interface ResolvedCollaborator {
  username: string;
  name: string;
  email: string;
}

/**
 * Resolve the co-authorable collaborators for a session.
 *
 * Looks up each non-owner username in `sessionAllowedUsers` via the platform
 * and keeps the ones with an email. Owner is excluded — the owner is the
 * implicit author, not a co-author. Users without email are skipped silently
 * (debug-logged) because we can't form a valid Co-Authored-By trailer for them.
 */
export async function resolveCollaborators(
  platform: Pick<PlatformClient, 'getUserByUsername'>,
  ownerUsername: string,
  allowedUsers: Iterable<string>,
): Promise<ResolvedCollaborator[]> {
  const resolved: ResolvedCollaborator[] = [];
  for (const username of allowedUsers) {
    if (username === ownerUsername) continue;
    try {
      const user = await platform.getUserByUsername(username);
      if (!user) {
        log.debug(`Collaborator @${username} not found on platform — skipping`);
        continue;
      }
      if (!user.email) {
        log.debug(`Collaborator @${username} has no email — skipping co-author tag`);
        continue;
      }
      resolved.push({
        username,
        name: user.displayName || user.username,
        email: user.email,
      });
    } catch (err) {
      log.debug(`Lookup failed for collaborator @${username}: ${(err as Error).message}`);
    }
  }
  return resolved;
}

/**
 * Build the "Git commit attribution" section of the system prompt.
 *
 * Two shapes:
 * - No collaborators: a one-liner that only kicks in if a "Collaborators
 *   updated" notice appears later in the thread. Solo sessions stay quiet.
 * - With collaborators: the full rule plus the current list and a pointer
 *   to the thread for later updates.
 */
export function buildCollaboratorContext(collaborators: ResolvedCollaborator[]): string {
  if (collaborators.length === 0) {
    return `If a "Collaborators updated" notice appears in this thread, add each listed person as a \`Co-Authored-By: Name <email>\` trailer on subsequent git commits. Do not add the session owner (they are the implicit author), the bot, or any AI assistant.`;
  }

  const lines = collaborators.map(c => `- ${c.name} <${c.email}>`).join('\n');
  return `## Git commit attribution

When you create a git commit in this session, add every current collaborator
listed below as a \`Co-Authored-By:\` trailer at the end of the commit
message, each on its own line, after a blank line separating them from the
body. Use the format \`Co-Authored-By: Name <email>\`. Do not add the session
owner (they are the implicit author), the bot, or any AI assistant.

Current collaborators:
${lines}

If a "Collaborators updated" notice appears later in this thread, use the
list from the most recent such notice instead — it supersedes this one.`;
}

/**
 * Format the collaborator list for an in-thread "collaborators updated" notice.
 * Returns an empty string when there is nothing co-authorable; the caller
 * is expected to produce a "no co-authors" sentence in that case.
 */
export function formatCollaboratorListForChat(collaborators: ResolvedCollaborator[]): string {
  return collaborators.map(c => `${c.name} <${c.email}>`).join(', ');
}

/**
 * Compose the full `appendSystemPrompt` for a Claude session.
 *
 * Layers (in order, blank-line-separated):
 *   1. session context line — included unless `omitSessionContext` is set,
 *      which is the worktree-respawn case where Claude already has a title
 *      and the bestaande spawn-pad omits it to keep prompt-rebuilds cheap.
 *   2. static chat-platform prompt (commands, send_file, etc.)
 *   3. collaborator co-author section — always included so the rule can't
 *      silently disappear across `!cd` / worktree / resume.
 *
 * Centralizing every spawn-site through this helper guarantees they all
 * teach Claude the same conventions; adding a layer in one place but not
 * another previously caused `!cd` to silently strip attribution.
 */
export async function buildAppendSystemPrompt(
  platform: Pick<PlatformClient, 'getUserByUsername'> & {
    platformType: string;
    displayName: string;
    getThreadLink(threadId: string): string;
  },
  workingDir: string,
  threadId: string,
  ownerUsername: string,
  allowedUsers: Iterable<string>,
  staticChatPlatformPrompt: string,
  options?: { omitSessionContext?: boolean },
): Promise<string> {
  const collaborators = await resolveCollaborators(platform, ownerUsername, allowedUsers);
  const collaboratorSection = buildCollaboratorContext(collaborators);

  const parts: string[] = [];
  if (!options?.omitSessionContext) {
    parts.push(buildSessionContext(platform, workingDir, threadId));
  }
  parts.push(staticChatPlatformPrompt);
  parts.push(collaboratorSection);
  return parts.join('\n\n');
}

/**
 * Generate the chat platform system prompt from the command registry.
 *
 * This prompt is appended to Claude's system prompt via --append-system-prompt.
 * It provides context about running in a chat platform and available commands.
 */
export function generateChatPlatformPrompt(): string {
  // Get user commands (excluding passthrough)
  const userCommands = COMMAND_REGISTRY
    .filter(cmd =>
      cmd.category !== 'passthrough' &&
      ['stop', 'escape', 'approve', 'invite', 'kick', 'cd', 'permissions', 'update'].includes(cmd.command)
    );

  // Format user commands section
  const userCommandLines = userCommands.map(formatUserCommand);

  // Add update subcommands
  const updateCmd = COMMAND_REGISTRY.find(c => c.command === 'update');
  if (updateCmd?.subcommands) {
    const updateIndex = userCommandLines.findIndex(l => l.includes('!update'));
    if (updateIndex !== -1) {
      // Replace the update line with expanded version
      userCommandLines[updateIndex] = '- `!update`: Show auto-update status';
      userCommandLines.splice(updateIndex + 1, 0,
        '- `!update now`: Apply pending update immediately',
        '- `!update defer`: Defer pending update for 1 hour'
      );
    }
  }

  // Get Claude executable commands
  const claudeCommands = getClaudeExecutableCommands()
    .filter(cmd => ['worktree', 'cd'].includes(cmd.command));

  // Get commands Claude should avoid
  const avoidCommands = getClaudeAvoidCommands();

  return `
You are running inside a chat platform (like Mattermost or Slack). Users interact with you through chat messages in a thread.

**Claude Threads Version:** ${VERSION}

## How This Works
- You are Claude Code running as a bot via "Claude Threads"
- Your responses appear as messages in a chat thread
- Keep responses concise - very long responses are split across multiple messages
- Multiple users may participate in a session (the owner can invite others)

## Sending files into THIS thread
You are RIGHT NOW running inside a chat thread (Mattermost or Slack). The \`send_file\` MCP tool — exposed as \`mcp__claude-threads-permissions__send_file\` in your tool list — uploads a file from your working directory and posts it directly into THIS thread, where the user is talking to you. It is NOT a hypothetical capability that requires extra setup; it works for the session you are in right now.

Use it whenever the user asks to "send", "share", "show", or "post" a file, OR whenever you produce an artifact (screenshot, generated audio, plot, document, PDF) that the user would benefit from seeing inline rather than as a path to read.

Arguments: \`{ path: <absolute path inside the working directory>, caption?: <optional one-line message> }\`. Returns a JSON envelope: \`{ ok: true, postId }\` on success or \`{ ok: false, reason }\` on failure — when it fails, surface \`reason\` to the user verbatim so they understand what went wrong (e.g. "outside the working directory", "file too large").

Do NOT tell the user the tool isn't available, doesn't apply, or requires Mattermost — it's wired up and pointed at this very thread. Just call it.

## Permissions & Interactions
- Permission requests (file writes, commands, etc.) appear as messages with emoji options
- Users approve with 👍 or deny with 👎 by reacting to the message
- Plan approvals and questions also use emoji reactions (👍/👎 for plans, number emoji for choices)
- Users can also type \`!approve\` or \`!yes\` to approve pending plans

## User Commands
Users can control sessions with these commands:
${userCommandLines.join('\n')}

## Commands You Can Execute
You can execute certain commands by writing them on their own line in your response.
The bot intercepts these and executes them, then sends results back to you.

Available commands:
${claudeCommands.map(formatClaudeCommand).join('\n')}

Commands you should NOT use (counterproductive):
${avoidCommands.map(c => `- \`!${c.command}\` - ${c.reason}`).join('\n')}
`.trim();
}
