/**
 * Contract tests — every executor satisfies `Executor<TState>`.
 *
 * The `Executor` interface defines the structural shape MessageManager
 * relies on when dispatching reactions and building persistence payloads.
 * These tests iterate every concrete executor and assert that the required
 * members are present (`getState`, `reset`) and that optional members
 * behave as declared when they're implemented.
 *
 * Catches drift: if someone adds a new executor and forgets to implement
 * `getState` / `reset`, or if they change a `handleReaction` signature out
 * of line with the interface, these tests fail fast.
 */

import { describe, it, expect, mock } from 'bun:test';
import type { Executor } from './types.js';
import { BaseExecutor, type ExecutorOptions } from './base.js';
import { ContentExecutor } from './content.js';
import { TaskListExecutor } from './task-list.js';
import { QuestionApprovalExecutor } from './question-approval.js';
import { MessageApprovalExecutor } from './message-approval.js';
import { PromptExecutor } from './prompt.js';
import { BugReportExecutor } from './bug-report.js';
import { SubagentExecutor } from './subagent.js';
import { SystemExecutor } from './system.js';
import { WorktreePromptExecutor } from './worktree-prompt.js';

function makeBaseOptions(): ExecutorOptions {
  return {
    registerPost: mock(() => undefined),
    updateLastMessage: mock(() => undefined),
  };
}

interface ExecutorCase {
  name: string;
  create: () => Executor;
  expectsHandleReaction: boolean;
  expectsSerialize: boolean;
}

/**
 * Every concrete executor, with whether it's expected to expose
 * `handleReaction` / `serialize`. The boolean flags double as intent: if
 * someone adds a new executor, they MUST update this table — otherwise
 * the contract test skips it silently.
 */
const CASES: ExecutorCase[] = [
  { name: 'ContentExecutor',           create: () => new ContentExecutor(makeBaseOptions()),           expectsHandleReaction: false, expectsSerialize: false },
  { name: 'TaskListExecutor',          create: () => new TaskListExecutor(makeBaseOptions()),          expectsHandleReaction: true,  expectsSerialize: true  },
  { name: 'QuestionApprovalExecutor',  create: () => new QuestionApprovalExecutor(makeBaseOptions()),  expectsHandleReaction: true,  expectsSerialize: false },
  { name: 'MessageApprovalExecutor',   create: () => new MessageApprovalExecutor(makeBaseOptions()),   expectsHandleReaction: true,  expectsSerialize: false },
  { name: 'PromptExecutor',            create: () => new PromptExecutor(makeBaseOptions()),            expectsHandleReaction: true,  expectsSerialize: true  },
  { name: 'BugReportExecutor',         create: () => new BugReportExecutor(makeBaseOptions()),         expectsHandleReaction: true,  expectsSerialize: false },
  { name: 'SubagentExecutor',          create: () => new SubagentExecutor(makeBaseOptions()),          expectsHandleReaction: true,  expectsSerialize: false },
  { name: 'SystemExecutor',            create: () => new SystemExecutor(makeBaseOptions()),            expectsHandleReaction: false, expectsSerialize: false },
  { name: 'WorktreePromptExecutor',    create: () => new WorktreePromptExecutor(makeBaseOptions()),    expectsHandleReaction: true,  expectsSerialize: false },
];

describe('Executor contract', () => {
  for (const { name, create, expectsHandleReaction, expectsSerialize } of CASES) {
    describe(name, () => {
      it('extends BaseExecutor (required getState + reset)', () => {
        const e = create();
        expect(e).toBeInstanceOf(BaseExecutor);
        expect(typeof e.getState).toBe('function');
        expect(typeof e.reset).toBe('function');
        // getState returns a readable object
        expect(typeof e.getState()).toBe('object');
      });

      it(`${expectsHandleReaction ? 'exposes' : 'does not expose'} handleReaction`, () => {
        const e = create();
        if (expectsHandleReaction) {
          expect(typeof e.handleReaction).toBe('function');
        } else {
          expect(e.handleReaction).toBeUndefined();
        }
      });

      it(`${expectsSerialize ? 'exposes' : 'does not expose'} serialize`, () => {
        const e = create();
        if (expectsSerialize) {
          expect(typeof e.serialize).toBe('function');
          // serialize() must be callable with no args and produce something.
          // We don't assert a specific shape — each executor's shape is its
          // own contract with `PersistedSession`.
          expect(() => (e.serialize as () => unknown)()).not.toThrow();
        } else {
          expect(e.serialize).toBeUndefined();
        }
      });
    });
  }

  it('reset() is idempotent across all executors', () => {
    for (const { name, create } of CASES) {
      const e = create();
      const before = JSON.stringify(e.getState());
      e.reset();
      e.reset();
      const after = JSON.stringify(e.getState());
      expect({ executor: name, state: after }).toEqual({ executor: name, state: before });
    }
  });
});

// ---------------------------------------------------------------------------
// handleReaction signature — uniform (postId, emoji, user, action, ctx)
// ---------------------------------------------------------------------------

describe('Executor.handleReaction signature is uniform', () => {
  it('every executor with handleReaction declares exactly 5 required params', () => {
    for (const { name, create, expectsHandleReaction } of CASES) {
      if (!expectsHandleReaction) continue;
      const e = create();
      // `Function.length` counts required parameters (those before the first
      // default value or rest). The Executor contract pins this at 5:
      // (postId, emoji, user, action, ctx).
      expect({ executor: name, arity: e.handleReaction!.length })
        .toEqual({ executor: name, arity: 5 });
    }
  });
});
