/**
 * `toolDetails: thread`: the tool stream is posted as replies under the
 * turn's post, streamed by a ContentExecutor of its own — same edit-in-place
 * and splitting as the reply, none of its bookkeeping (no task-list bumps,
 * no "latest message" updates; see docs/quiet-tools-spec.md).
 *
 * The root post may not exist when the first tool starts (the summary header
 * creates it on the next flush), so lines queue until a context is available.
 *
 * Each turn has its own state, and every write for a turn runs on that turn's
 * serial chain. Two things depend on that:
 * - A timer flush still inside `createPost` and the turn-end flush never
 *   overlap; overlapping, both saw no post yet and each created one.
 * - `turnEnded` detaches the turn before it awaits anything. Event handling
 *   is not awaited upstream, so the next turn's first tool can arrive while
 *   this turn's details are still being written; it now lands in a fresh
 *   turn instead of in a queue that is about to be discarded.
 */

import { ContentExecutor } from '../executors/content.js';
import type { ExecutorContext } from '../executors/types.js';
import { createAppendContentOp, createFlushOp } from '../types.js';
import type { ToolDetailsSink } from './types.js';

export interface ThreadSinkDeps {
  /** A context whose createPost posts under this turn's root, or null while there is no root yet. */
  contextFor: () => ExecutorContext | null;
  /** A fresh executor per turn (each turn has its own root). */
  makeExecutor: () => ContentExecutor;
  /**
   * Hold every line until the turn ends. Set when the details share the
   * reply's thread (a thread session, where Slack has no nested threads):
   * streaming them early would put a details post above reply posts that
   * are still to come, instead of after the reply.
   */
  holdUntilTurnEnd?: boolean;
  /** Delay of the streaming flush; tests shorten it. */
  flushDelayMs?: number;
}

interface Turn {
  queued: string[];
  executor: ContentExecutor | null;
  ctx: ExecutorContext | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Every write for this turn, in order. */
  chain: Promise<void>;
  /** Set by reset(): whatever is still queued on the chain does nothing. */
  dead: boolean;
}

export function createThreadSink(deps: ThreadSinkDeps): ToolDetailsSink {
  const flushDelayMs = deps.flushDelayMs ?? 500;
  const newTurn = (): Turn => ({ queued: [], executor: null, ctx: null, timer: null, chain: Promise.resolve(), dead: false });
  let turn = newTurn();

  /** Run `work` after everything already queued for this turn. The chain survives a failure; the caller still sees it. */
  function enqueue(t: Turn, work: () => Promise<void>): Promise<void> {
    const run = t.chain.then(() => (t.dead ? undefined : work()));
    t.chain = run.catch(() => undefined);
    return run;
  }

  async function drain(t: Turn): Promise<void> {
    if (t.queued.length === 0) return;
    t.ctx ??= deps.contextFor();
    if (!t.ctx) return;
    t.executor ??= deps.makeExecutor();
    const lines = t.queued;
    t.queued = [];
    // Flush in chunks. A held turn arrives here as hundreds of lines at once,
    // and a first flush with no post yet truncates at the platform limit
    // instead of splitting; once a post exists, the executor splits.
    const chunk = Math.floor(t.ctx.platform.getMessageLimits().hardThreshold / 2);
    for (const line of lines) {
      await t.executor.executeAppend(createAppendContentOp(t.ctx.sessionId, line, true), t.ctx);
      if (t.dead) return;
      if (t.executor.getState().pendingContent.length >= chunk) {
        await t.executor.executeFlush(createFlushOp(t.ctx.sessionId, 'soft_threshold'), t.ctx);
        if (t.dead) return;
      }
    }
  }

  function scheduleFlush(t: Turn): void {
    if (t.timer || t.dead) return;
    t.timer = setTimeout(() => {
      t.timer = null;
      void enqueue(t, async () => {
        if (t.executor && t.ctx) await t.executor.executeFlush(createFlushOp(t.ctx.sessionId, 'soft_threshold'), t.ctx);
      });
    }, flushDelayMs);
  }

  function stopTimer(t: Turn): void {
    if (t.timer) {
      clearTimeout(t.timer);
      t.timer = null;
    }
  }

  return {
    async append(op) {
      const t = turn;
      t.queued.push(op.display);
      if (deps.holdUntilTurnEnd) return;
      await enqueue(t, async () => {
        await drain(t);
        if (t.executor) scheduleFlush(t);
      });
    },
    async turnEnded(ctx) {
      const t = turn;
      turn = newTurn();
      stopTimer(t);
      // Resolve the root now: once the next turn starts, contextFor() answers for it.
      t.ctx ??= deps.contextFor();
      await enqueue(t, async () => {
        await drain(t);
        if (t.executor && t.ctx) {
          await t.executor.executeFlush(createFlushOp(t.ctx.sessionId, 'result'), t.ctx);
          t.executor.closeCurrentPost(t.ctx);
        }
        if (t.queued.length > 0) {
          // Only possible when the turn produced no post at all to hang a
          // thread on; say so rather than pretend the stream was delivered.
          ctx.logger.warn(`tool details: ${t.queued.length} line(s) dropped, the turn has no post to thread under`);
          t.queued = [];
        }
      });
    },
    link: () => null,
    reset() {
      const t = turn;
      t.dead = true;
      stopTimer(t);
      t.executor?.reset();
      turn = newTurn();
    },
  };
}
