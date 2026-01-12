/**
 * Message Manager Events - TypedEventEmitter for MessageManager
 *
 * Provides a type-safe event emitter pattern to replace callback-based
 * communication between MessageManager and Session/Lifecycle layers.
 *
 * Benefits over callbacks:
 * - Cleaner MessageManager constructor (no callback parameters)
 * - Easy to add new event types (just update MessageManagerEventMap)
 * - Multiple listeners possible per event
 * - Better separation of concerns
 * - More testable (can spy on event emissions)
 */

import { EventEmitter } from 'events';
import type { PendingBugReport } from './executors/types.js';
import type { StatusUpdateOp, LifecycleOp } from './types.js';

// ---------------------------------------------------------------------------
// Event Payload Types
// ---------------------------------------------------------------------------

/**
 * Question answer from user response.
 */
export interface QuestionAnswer {
  header: string;
  answer: string;
}

/**
 * Event map defining all MessageManager events and their payloads.
 */
export interface MessageManagerEventMap {
  /**
   * Emitted when all questions in a question set have been answered.
   */
  'question:complete': {
    toolUseId: string;
    answers: QuestionAnswer[];
  };

  /**
   * Emitted when an approval prompt receives a response.
   */
  'approval:complete': {
    toolUseId: string;
    approved: boolean;
  };

  /**
   * Emitted when a message approval prompt receives a response.
   */
  'message-approval:complete': {
    decision: 'allow' | 'invite' | 'deny';
    fromUser: string;
    originalMessage: string;
  };

  /**
   * Emitted when a context prompt receives a response.
   */
  'context-prompt:complete': {
    selection: number | 'timeout';
    queuedPrompt: string;
    queuedFiles?: Array<{ id: string; name: string }>;
    threadMessageCount: number;
  };

  /**
   * Emitted when an existing worktree prompt receives a response.
   */
  'worktree-prompt:complete': {
    decision: 'join' | 'skip';
    branch: string;
    worktreePath: string;
    username: string;
  };

  /**
   * Emitted when an update prompt receives a response.
   */
  'update-prompt:complete': {
    decision: 'update_now' | 'defer';
  };

  /**
   * Emitted when a bug report prompt receives a response.
   */
  'bug-report:complete': {
    decision: 'approve' | 'deny';
    report: PendingBugReport;
  };

  /**
   * Emitted when status information is updated (context usage, model info, etc.).
   */
  'status:update': Partial<StatusUpdateOp>;

  /**
   * Emitted for session lifecycle events (idle, processing, etc.).
   */
  'lifecycle:event': {
    event: LifecycleOp['event'];
  };
}

/**
 * Type alias for event names.
 */
export type MessageManagerEvent = keyof MessageManagerEventMap;

// ---------------------------------------------------------------------------
// TypedEventEmitter
// ---------------------------------------------------------------------------

/**
 * A type-safe EventEmitter for MessageManager events.
 *
 * Provides compile-time type checking for event names and payloads,
 * ensuring that events are emitted and subscribed to with the correct types.
 */
export class TypedEventEmitter extends EventEmitter {
  /**
   * Emit a typed event.
   *
   * @param event - Event name from MessageManagerEventMap
   * @param data - Event payload (type checked against MessageManagerEventMap)
   * @returns true if listeners were called, false otherwise
   */
  emit<K extends MessageManagerEvent>(
    event: K,
    data: MessageManagerEventMap[K]
  ): boolean {
    return super.emit(event, data);
  }

  /**
   * Subscribe to a typed event.
   *
   * @param event - Event name from MessageManagerEventMap
   * @param listener - Handler function (type checked for correct payload)
   * @returns this (for chaining)
   */
  on<K extends MessageManagerEvent>(
    event: K,
    listener: (data: MessageManagerEventMap[K]) => void
  ): this {
    return super.on(event, listener);
  }

  /**
   * Subscribe to a typed event for a single invocation.
   *
   * @param event - Event name from MessageManagerEventMap
   * @param listener - Handler function (type checked for correct payload)
   * @returns this (for chaining)
   */
  once<K extends MessageManagerEvent>(
    event: K,
    listener: (data: MessageManagerEventMap[K]) => void
  ): this {
    return super.once(event, listener);
  }

  /**
   * Remove a typed event listener.
   *
   * @param event - Event name from MessageManagerEventMap
   * @param listener - Handler function to remove
   * @returns this (for chaining)
   */
  off<K extends MessageManagerEvent>(
    event: K,
    listener: (data: MessageManagerEventMap[K]) => void
  ): this {
    return super.off(event, listener);
  }

  /**
   * Remove all listeners for a specific event or all events.
   *
   * @param event - Optional event name to remove listeners for
   * @returns this (for chaining)
   */
  removeAllListeners(event?: MessageManagerEvent): this {
    return super.removeAllListeners(event);
  }

  /**
   * Get listener count for a specific event.
   *
   * @param event - Event name from MessageManagerEventMap
   * @returns Number of listeners registered for this event
   */
  listenerCount(event: MessageManagerEvent): number {
    return super.listenerCount(event);
  }
}

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

/**
 * Create a new TypedEventEmitter instance.
 */
export function createMessageManagerEvents(): TypedEventEmitter {
  return new TypedEventEmitter();
}
