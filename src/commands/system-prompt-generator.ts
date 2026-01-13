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
 */
export function buildSessionContext(
  platform: { platformType: string; displayName: string },
  workingDir: string
): string {
  const platformName = platform.platformType.charAt(0).toUpperCase() + platform.platformType.slice(1);
  return `**Platform:** ${platformName} (${platform.displayName}) | **Working Directory:** ${workingDir}`;
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
