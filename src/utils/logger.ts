/**
 * Logging Utility
 *
 * Provides consistent logging across the codebase with:
 * - Configurable prefix for different components
 * - DEBUG environment variable check
 * - stdout vs stderr routing option
 * - Pre-configured loggers for common components
 *
 * Benefits:
 * - DRY: Single implementation for all logging
 * - Consistency: Standard output formats
 * - Debugging: Easy to enable/disable debug logs
 * - Filtering: Component-based prefixes make logs filterable
 */

// =============================================================================
// Logger Interface
// =============================================================================

export interface Logger {
  /** Log a debug message (only when DEBUG=1) */
  debug: (msg: string, ...args: unknown[]) => void;
  /** Log an info message (always shown) */
  info: (msg: string, ...args: unknown[]) => void;
  /** Log a warning message (always shown) */
  warn: (msg: string, ...args: unknown[]) => void;
  /** Log an error message (always shown, to stderr) */
  error: (msg: string, err?: Error) => void;
}

// =============================================================================
// Logger Factory
// =============================================================================

/**
 * Create a logger with a specific component name.
 *
 * @param component - Component name (e.g., 'lifecycle', 'events', 'mcp')
 * @param useStderr - If true, use stderr for all output (default: false)
 * @returns Logger object with debug, info, warn, and error methods
 *
 * @example
 * const log = createLogger('lifecycle');
 * log.info('Session started');
 * log.debug('Processing event'); // Only shown when DEBUG=1
 * log.error('Something failed', error);
 */
export function createLogger(component: string, useStderr = false): Logger {
  const isDebug = () => process.env.DEBUG === '1';
  const log = useStderr ? console.error : console.log;
  const prefix = `  [${component}]`;

  return {
    debug: (msg: string, ...args: unknown[]) => {
      if (isDebug()) {
        if (args.length > 0) {
          log(`${prefix} ${msg}`, ...args);
        } else {
          log(`${prefix} ${msg}`);
        }
      }
    },
    info: (msg: string, ...args: unknown[]) => {
      if (args.length > 0) {
        log(`${prefix} ${msg}`, ...args);
      } else {
        log(`${prefix} ${msg}`);
      }
    },
    warn: (msg: string, ...args: unknown[]) => {
      if (args.length > 0) {
        console.warn(`${prefix} ⚠️ ${msg}`, ...args);
      } else {
        console.warn(`${prefix} ⚠️ ${msg}`);
      }
    },
    error: (msg: string, err?: Error) => {
      console.error(`${prefix} ❌ ${msg}`);
      if (err && isDebug()) {
        console.error(err);
      }
    },
  };
}

// =============================================================================
// Pre-configured Loggers
// =============================================================================

/**
 * Logger for MCP permission server.
 * Uses stderr (required for MCP stdio communication).
 */
export const mcpLogger = createLogger('MCP', true);

/**
 * Logger for WebSocket client.
 */
export const wsLogger = createLogger('ws', false);

/**
 * Logger for session lifecycle operations.
 */
export const lifecycleLogger = createLogger('lifecycle');

/**
 * Logger for Claude event handling.
 */
export const eventsLogger = createLogger('events');

/**
 * Logger for user commands.
 */
export const commandsLogger = createLogger('commands');

/**
 * Logger for worktree management.
 */
export const worktreeLogger = createLogger('worktree');

/**
 * Logger for message streaming.
 */
export const streamingLogger = createLogger('streaming');

/**
 * Logger for reactions handling.
 */
export const reactionsLogger = createLogger('reactions');

/**
 * Logger for persistence operations.
 */
export const persistLogger = createLogger('persist');

/**
 * Logger for sticky message management.
 */
export const stickyLogger = createLogger('sticky');

/**
 * Logger for cleanup operations.
 */
export const cleanupLogger = createLogger('cleanup');

/**
 * Logger for context prompts.
 */
export const contextLogger = createLogger('context');
