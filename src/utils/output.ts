/**
 * Unified CLI Output Module
 *
 * Provides consistent styling and formatting for all CLI output.
 * All messages use 2-space indentation with emoji prefixes.
 *
 * When a log handler is set (via setOutputHandler), all output
 * is routed through that handler instead of console.log.
 */

// ANSI color codes
export const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  // Claude brand colors
  blue: '\x1b[38;5;27m',
  orange: '\x1b[38;5;209m',
};

// Helper functions for styling text
export const dim = (s: string): string => `${colors.dim}${s}${colors.reset}`;
export const bold = (s: string): string => `${colors.bold}${s}${colors.reset}`;
export const cyan = (s: string): string => `${colors.cyan}${s}${colors.reset}`;
export const green = (s: string): string => `${colors.green}${s}${colors.reset}`;
export const red = (s: string): string => `${colors.red}${s}${colors.reset}`;
export const yellow = (s: string): string => `${colors.yellow}${s}${colors.reset}`;

// Output handler for UI integration
type OutputLevel = 'debug' | 'info' | 'warn' | 'error';
type OutputHandler = (level: OutputLevel, emoji: string, message: string) => void;
let outputHandler: OutputHandler | null = null;

/**
 * Set a handler for all output messages.
 * When set, messages go through this handler instead of console.
 */
export function setOutputHandler(handler: OutputHandler | null): void {
  outputHandler = handler;
}

/**
 * Log an info message with emoji prefix (always shown)
 * Format: "  {emoji} {message}"
 */
export function log(emoji: string, message: string): void {
  if (outputHandler) {
    outputHandler('info', emoji, message);
  } else {
    console.log(`  ${emoji} ${message}`);
  }
}

/**
 * Log a debug message with emoji prefix (only when DEBUG=1)
 * Format: "  {emoji} {message}"
 */
export function debug(emoji: string, message: string): void {
  if (process.env.DEBUG === '1') {
    if (outputHandler) {
      outputHandler('debug', emoji, message);
    } else {
      console.log(`  ${emoji} ${dim(message)}`);
    }
  }
}

/**
 * Log an error message with emoji prefix (always shown, to stderr)
 * Format: "  {emoji} {message}"
 */
export function error(emoji: string, message: string): void {
  if (outputHandler) {
    outputHandler('error', emoji, message);
  } else {
    console.error(`  ${emoji} ${message}`);
  }
}

/**
 * Log a warning message with emoji prefix (always shown)
 * Format: "  {emoji} {message}"
 */
export function warn(emoji: string, message: string): void {
  if (outputHandler) {
    outputHandler('warn', emoji, message);
  } else {
    console.log(`  ${emoji} ${message}`);
  }
}

/**
 * Log a plain message with standard indentation (no emoji)
 * Format: "  {message}"
 */
export function logPlain(message: string): void {
  if (outputHandler) {
    outputHandler('info', '', message);
  } else {
    console.log(`  ${message}`);
  }
}

/**
 * Log an empty line
 */
export function logEmpty(): void {
  if (!outputHandler) {
    console.log('');
  }
  // When outputHandler is set, skip empty lines (UI handles spacing)
}
