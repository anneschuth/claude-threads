/**
 * Commands module exports
 */

// Parser exports
export {
  parseCommand,
  parseClaudeCommand,
  isClaudeAllowedCommand,
  removeCommandFromText,
  CLAUDE_ALLOWED_COMMANDS,
  type ParsedCommand,
} from './parser.js';

// Registry exports (single source of truth for commands)
export {
  COMMAND_REGISTRY,
  REACTION_REGISTRY,
  getCommandsByCategory,
  getUserHelpCommands,
  getClaudeExecutableCommands,
  getClaudeAvoidCommands,
  getCommand,
  getReactionsByContext,
  buildClaudeAllowedCommandsSet,
  type CommandDefinition,
  type SubcommandDefinition,
  type ReactionDefinition,
  type CommandCategory,
  type CommandAudience,
} from './registry.js';

// Help generator exports
export { generateHelpMessage } from './help-generator.js';

// System prompt generator exports
export {
  generateChatPlatformPrompt,
  buildSessionContext,
  buildFullSystemPrompt,
} from './system-prompt-generator.js';
