/**
 * Skill tool formatter
 *
 * Handles formatting of Skill tool invocations with:
 * - Skill name parsing (namespace:command format)
 * - Arguments display
 * - Clear visual distinction from other tools
 *
 * Skills are user-defined shortcuts/workflows that Claude can invoke.
 * They typically have a namespace (e.g., "ralph-loop") and a command name.
 *
 * Example inputs:
 * - { skill: "commit" }
 * - { skill: "ralph-loop:ralph-loop", args: "Build a REST API" }
 * - { skill: "review-pr", args: "123" }
 */

import type { ToolFormatter, ToolFormatResult, ToolInput, ToolFormatOptions } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SkillInput {
  /** The skill name, optionally with namespace (e.g., "commit", "ralph-loop:ralph-loop") */
  skill?: string;
  /** Optional arguments passed to the skill */
  args?: string;
}

interface ParsedSkill {
  /** The namespace/plugin name (e.g., "ralph-loop"), or null if no namespace */
  namespace: string | null;
  /** The command name (e.g., "ralph-loop", "commit") */
  command: string;
  /** The full skill identifier */
  full: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a skill name into namespace and command parts.
 *
 * Examples:
 * - "commit" -> { namespace: null, command: "commit", full: "commit" }
 * - "ralph-loop:ralph-loop" -> { namespace: "ralph-loop", command: "ralph-loop", full: "ralph-loop:ralph-loop" }
 * - "ms-office-suite:pdf" -> { namespace: "ms-office-suite", command: "pdf", full: "ms-office-suite:pdf" }
 */
function parseSkillName(skill: string): ParsedSkill {
  const colonIndex = skill.indexOf(':');
  if (colonIndex === -1) {
    return { namespace: null, command: skill, full: skill };
  }
  return {
    namespace: skill.substring(0, colonIndex),
    command: skill.substring(colonIndex + 1),
    full: skill,
  };
}

/**
 * Truncate text at a reasonable length, adding ellipsis if needed.
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

// ---------------------------------------------------------------------------
// Skill Formatter
// ---------------------------------------------------------------------------

/**
 * Formatter for the Skill tool.
 *
 * Displays skill invocations with:
 * - Lightning bolt emoji for quick visual recognition
 * - Bold "Skill" label
 * - Skill name in code format (with namespace if present)
 * - Arguments in italic quotes (if provided)
 */
export const skillToolsFormatter: ToolFormatter = {
  toolNames: ['Skill'],

  format(toolName: string, input: ToolInput, options: ToolFormatOptions): ToolFormatResult | null {
    if (toolName !== 'Skill') return null;

    const { formatter } = options;
    const skillInput = input as SkillInput;

    const skillName = skillInput.skill || 'unknown';
    const args = skillInput.args;

    // Parse the skill name to extract namespace and command
    const parsed = parseSkillName(skillName);

    // Build the display string
    const parts: string[] = [];

    // Emoji and tool name
    parts.push(`⚡ ${formatter.formatBold('Skill')}`);

    // Skill identifier - show command prominently, namespace in parentheses if present
    if (parsed.namespace) {
      // Format: /command (namespace)
      parts.push(`${formatter.formatCode('/' + parsed.command)} ${formatter.formatItalic(`(${parsed.namespace})`)}`);
    } else {
      // Simple format: /command
      parts.push(formatter.formatCode('/' + parsed.command));
    }

    // Arguments if provided
    if (args) {
      const truncatedArgs = truncateText(args, 80);
      parts.push(`"${truncatedArgs}"`);
    }

    const display = parts.join(' ');

    // Permission text (more verbose for approval prompts)
    const permissionParts: string[] = [];
    permissionParts.push(`⚡ ${formatter.formatBold('Skill')}`);
    permissionParts.push(formatter.formatCode(parsed.full));
    if (args) {
      permissionParts.push(`with args: "${truncateText(args, 100)}"`);
    }

    return {
      display,
      permissionText: permissionParts.join(' '),
    };
  },
};
