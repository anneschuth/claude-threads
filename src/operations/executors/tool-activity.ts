/**
 * Keeps the per-turn tool counter behind the summary line and hands every
 * tool line to the details sink. See docs/quiet-tools-spec.md.
 */

import type { PlatformFormatter } from '../../platform/index.js';
import { parseMcpToolName } from '../tool-formatters/utils.js';
import type { ToolActivityOp } from '../types.js';
import type { ToolDetailsSink } from '../tool-details/types.js';
import type { ExecutorContext } from './types.js';

export interface ToolTurnStats {
  started: number;
  finished: number;
  failed: number;
  firstStartAt: number | null;
  lastEndAt: number | null;
  /** Name of the most recently started tool — the turn's liveness signal. */
  lastTool: string | null;
}

const fresh = (): ToolTurnStats => ({ started: 0, finished: 0, failed: 0, firstStartAt: null, lastEndAt: null, lastTool: null });

/**
 * `mcp__playwright__browser_navigate` is the tool's wire name, not something
 * to put in a one-line summary; the part after the server is the action.
 */
function shortToolName(name: string): string {
  // `mcp__server__` parses with an empty tool part; an empty component would
  // render as a dangling separator, so fall back to the wire name (Codex).
  return parseMcpToolName(name)?.tool || name;
}

/** `🔧 12 tools · 40 s · Bash`, with `…` while tools are still running, `· 1 ❌` on failures, `· details` when linked. */
export function renderToolSummary(
  stats: ToolTurnStats,
  now: number,
  link: string | null,
  formatter: Pick<PlatformFormatter, 'formatLink'>,
): string {
  const running = stats.started > stats.finished;
  const until = running || stats.lastEndAt === null ? now : stats.lastEndAt;
  const seconds = stats.firstStartAt === null ? 0 : Math.max(0, Math.round((until - stats.firstStartAt) / 1000));
  const parts = [`🔧 ${stats.started} ${stats.started === 1 ? 'tool' : 'tools'}`, `${seconds} s${running ? '…' : ''}`];
  // Once the stream is hidden this line is the only sign of what the bot is
  // doing, not just how much it has done (@thejdubb02, #505).
  if (stats.lastTool) parts.push(shortToolName(stats.lastTool));
  if (stats.failed > 0) parts.push(`${stats.failed} ❌`);
  if (link) parts.push(formatter.formatLink('details', link));
  return parts.join(' · ');
}

export interface ToolActivityExecutorOptions {
  mode: 'summary' | 'hidden';
  sink: ToolDetailsSink;
  /** Called with the new summary line whenever it changes (summary mode only). */
  onHeader: (line: string) => void;
  now?: () => number;
}

export class ToolActivityExecutor {
  private stats = fresh();

  constructor(private readonly options: ToolActivityExecutorOptions) {}

  getStats(): Readonly<ToolTurnStats> {
    return this.stats;
  }

  async execute(op: ToolActivityOp, ctx: ExecutorContext): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    if (op.kind === 'start') {
      this.stats.started++;
      this.stats.firstStartAt ??= now;
      this.stats.lastTool = op.name;
      // Header first: on a turn's first tool it claims the new reply post,
      // and the sink resolves its root from that post. The other way round,
      // the root was still the previous turn's reply (direct channel mode
      // threaded turn 2's details under turn 1).
      this.renderHeader(now, ctx);
      await this.options.sink.append(op, ctx);
    } else if (op.kind === 'end') {
      // An end with nothing open belongs to a turn already closed: the late
      // result of a tool that turn_end counted as finished. Counting it would
      // open a phantom `🔧 0 tools` header in the next turn.
      if (this.stats.finished >= this.stats.started) return;
      this.stats.finished++;
      if (!op.ok) this.stats.failed++;
      this.stats.lastEndAt = now;
      await this.options.sink.append(op, ctx);
      this.renderHeader(now, ctx);
    } else if (this.stats.started > 0) {
      // turn_end: the final line, rendered by the result flush that follows.
      // A tool can end the turn without a result of its own (an interrupt);
      // the turn is over all the same, so it must not keep a running `…`.
      if (this.stats.started > this.stats.finished) {
        this.stats.finished = this.stats.started;
        this.stats.lastEndAt = now;
      }
      this.renderHeader(now, ctx);
    }
  }

  /**
   * After the reply's result flush: the turn's post exists (if it ever
   * will), so the sink can deliver and close, and the counter starts over.
   */
  async afterResultFlush(ctx: ExecutorContext): Promise<void> {
    if (this.stats.started === 0) return;
    // Start the next turn's counter BEFORE awaiting the sink: event handling
    // is not awaited upstream, so the next turn's first tool can arrive while
    // this turn's details are being written, and must not count into (and be
    // wiped with) this turn's stats.
    this.stats = fresh();
    try {
      await this.options.sink.turnEnded(ctx);
    } catch (err) {
      // Details are a side channel: a failure there must not cost the turn
      // its end-of-turn marker, which runs after this.
      ctx.logger.warn(`tool details: delivering the turn failed: ${(err as Error).message ?? err}`);
    }
  }

  /**
   * Session restart: the turn in progress is gone, and so is its counter.
   * A turn with no tools has nothing to abandon, and saying so keeps this
   * idempotent — the respawn path reaches it twice on a fresh-session
   * restart, and a sink that numbers turns would otherwise skip one.
   */
  reset(): void {
    if (this.stats.started === 0) return;
    this.stats = fresh();
    this.options.sink.reset();
  }

  private renderHeader(now: number, ctx: ExecutorContext): void {
    if (this.options.mode !== 'summary') return;
    this.options.onHeader(renderToolSummary(this.stats, now, this.options.sink.link(), ctx.formatter));
  }
}
