/**
 * The one lifecycle every reaction-resolved prompt shares: match the pending
 * state to the reacted post, rewrite the prompt post with the outcome
 * (best-effort — a failed update must not lose the decision), clear the
 * pending slot, and emit the typed completion event.
 *
 * Seven executor handlers (context, existing-worktree, update, routine,
 * watch, message-approval, bug-report, plan approval) used to carry
 * near-identical copies of this body; each is now a thin adapter that
 * supplies its wording, its slot, and its typed emit.
 */

import type { ExecutorContext } from './types.js';

export async function completePendingPrompt<P extends { postId: string }>(opts: {
  pending: P | null;
  postId: string;
  ctx: ExecutorContext;
  /** Human label for the failed-update debug log (e.g. 'context prompt'). */
  label: string;
  /** Build the outcome text the prompt post is rewritten to; decision logging happens here too. */
  statusMessage(pending: P): string;
  clear(): void;
  emit(pending: P): void;
}): Promise<boolean> {
  const { pending, postId, ctx } = opts;
  if (!pending || pending.postId !== postId) return false;

  const statusMessage = opts.statusMessage(pending);
  try {
    await ctx.platform.updatePost(postId, statusMessage);
  } catch (err) {
    ctx.logger.debug(`Failed to update ${opts.label} post: ${err}`);
  }

  opts.clear();
  opts.emit(pending);
  return true;
}
