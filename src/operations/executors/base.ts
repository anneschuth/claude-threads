/**
 * Base Executor - Abstract base class for all executors
 *
 * Eliminates duplicated boilerplate across executor classes.
 * Provides common infrastructure for:
 * - Callback management (registerPost, updateLastMessage)
 * - Event emission (events)
 * - State management (getState, reset)
 */

import type { RegisterPostCallback, UpdateLastMessageCallback } from './types.js';
import type { TypedEventEmitter } from '../message-manager-events.js';

// ---------------------------------------------------------------------------
// Executor Options
// ---------------------------------------------------------------------------

/**
 * Base options for all executors.
 */
export interface ExecutorOptions {
  /** Callback for registering a post with the tracker */
  registerPost: RegisterPostCallback;
  /** Callback for updating last message tracking */
  updateLastMessage: UpdateLastMessageCallback;
  /** Optional event emitter for notifying about events */
  events?: TypedEventEmitter;
}

// ---------------------------------------------------------------------------
// Base Executor
// ---------------------------------------------------------------------------

/**
 * Abstract base class for all executors.
 *
 * Provides common infrastructure that was previously duplicated across
 * 9+ executor classes. Subclasses must:
 * 1. Call super(options, initialState) in constructor
 * 2. Implement getInitialState() for reset()
 * 3. Override reset() if cleanup is needed beyond state reset
 *
 * @template TState - The state type managed by the executor
 */
export abstract class BaseExecutor<TState extends object> {
  /** Executor state - subclasses access via protected */
  protected state: TState;

  /** Callback for registering a post with the tracker */
  protected readonly registerPost: RegisterPostCallback;

  /** Callback for updating last message tracking */
  protected readonly updateLastMessage: UpdateLastMessageCallback;

  /** Optional event emitter for notifying about events */
  protected readonly events?: TypedEventEmitter;

  /**
   * Create a new executor.
   *
   * @param options - Executor options (callbacks and events)
   * @param initialState - Initial state for the executor
   */
  constructor(options: ExecutorOptions, initialState: TState) {
    this.state = initialState;
    this.registerPost = options.registerPost;
    this.updateLastMessage = options.updateLastMessage;
    this.events = options.events;
  }

  /**
   * Get the current state (for inspection/testing).
   * Returns a shallow copy to prevent external mutation.
   */
  getState(): Readonly<TState> {
    return { ...this.state };
  }

  /**
   * Reset state to initial values.
   * Override in subclasses if cleanup is needed (e.g., clearing timers).
   */
  reset(): void {
    this.state = this.getInitialState();
  }

  /**
   * Get the initial state for this executor.
   * Called by reset() to restore state to initial values.
   */
  protected abstract getInitialState(): TState;
}
