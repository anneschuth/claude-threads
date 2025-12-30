/**
 * ASCII Art Logo for Claude Threads
 *
 * Stylized CT in Claude Code's block character style.
 */

// ANSI color codes for terminal
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  // Claude blue
  blue: '\x1b[38;5;27m',
  // Claude orange/coral
  orange: '\x1b[38;5;209m',
};

/**
 * ASCII logo for CLI display (with ANSI colors)
 * Stylized CT in block characters
 */
export const CLI_LOGO = `
${colors.orange} ✴${colors.reset} ${colors.blue}▄█▀ ███${colors.reset} ${colors.orange}✴${colors.reset}   ${colors.bold}claude-threads${colors.reset}
${colors.orange}✴${colors.reset}  ${colors.blue}█▀   █${colors.reset}   ${colors.orange}✴${colors.reset}  ${colors.dim}Chat × Claude Code${colors.reset}
 ${colors.orange}✴${colors.reset} ${colors.blue}▀█▄  █${colors.reset}  ${colors.orange}✴${colors.reset}
`;

/**
 * ASCII logo for chat platforms (plain text, no ANSI codes)
 * Use getPlatformLogo(version) instead to include version
 */
export const PLATFORM_LOGO = `\`\`\`
 ✴ ▄█▀ ███ ✴   claude-threads
✴  █▀   █   ✴  Chat × Claude Code
 ✴ ▀█▄  █  ✴
\`\`\``;

/**
 * Get ASCII logo for claude-threads with version included
 */
export function getLogo(version: string): string {
  return `\`\`\`
 ✴ ▄█▀ ███ ✴   claude-threads v${version}
✴  █▀   █   ✴  Chat × Claude Code
 ✴ ▀█▄  █  ✴
\`\`\``;
}

/**
 * @deprecated Use getLogo instead
 */
export const getMattermostLogo = getLogo;
export const getPlatformLogo = getLogo;

/**
 * @deprecated Use PLATFORM_LOGO instead
 */
export const MATTERMOST_LOGO = PLATFORM_LOGO;

/**
 * Compact inline logo for chat platform headers
 */
export const PLATFORM_LOGO_INLINE = '`▄█▀T` **claude-threads**';

/**
 * @deprecated Use PLATFORM_LOGO_INLINE instead
 */
export const MATTERMOST_LOGO_INLINE = PLATFORM_LOGO_INLINE;

/**
 * Very compact logo for space-constrained contexts
 */
export const LOGO_COMPACT = '▄█▀T claude-threads';

/**
 * Print CLI logo to stdout
 */
export function printLogo(): void {
  console.log(CLI_LOGO);
}
