/**
 * Session-scoped Logger Factory
 *
 * Provides a factory function to create session-scoped loggers.
 * This eliminates duplication of the `sessionLog()` helper function
 * that appears in multiple modules throughout the codebase.
 *
 * Usage:
 * ```typescript
 * import { createLogger } from './logger.js';
 * import { createSessionLog } from './session-log.js';
 *
 * const log = createLogger('mymodule');
 * const sessionLog = createSessionLog(log);
 *
 * // In your code:
 * sessionLog(session).info('Something happened');
 * sessionLog(session).debug('Debug info');
 * ```
 *
 * Benefits:
 * - DRY: Single implementation used by all modules
 * - Type safety: Works with Session or any object with sessionId
 * - Flexibility: Handles null/undefined sessions gracefully
 */

import type { Logger } from './logger.js';

/**
 * Minimal interface for objects that can be logged for.
 * Only requires sessionId to be present.
 */
export interface SessionLike {
  sessionId: string;
}

/**
 * Create a session-scoped logger factory function.
 *
 * The returned function takes a session (or any object with sessionId)
 * and returns a logger scoped to that session. If the session is null
 * or undefined, returns the base logger.
 *
 * @param baseLog - The base logger to use (created by createLogger)
 * @returns A function that creates session-scoped loggers
 *
 * @example
 * const log = createLogger('lifecycle');
 * const sessionLog = createSessionLog(log);
 *
 * // With session:
 * sessionLog(session).info('Session started');
 *
 * // Without session (falls back to base logger):
 * sessionLog(null).warn('No session available');
 */
export function createSessionLog(baseLog: Logger) {
  return (session: SessionLike | null | undefined): Logger => {
    if (session?.sessionId) {
      return baseLog.forSession(session.sessionId);
    }
    return baseLog;
  };
}
