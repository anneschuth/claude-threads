/**
 * `toolDetails: file`: one HTML page per turn under
 * `<dir>/<platformId>/<sessionId>/<turn>.html`, plus an `index.html` per
 * session. The daemon only writes; serving the directory (behind auth: it
 * holds command lines and outputs) is the operator's job. With a URL base,
 * the summary line links to the page. See docs/quiet-tools-spec.md.
 */

import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import type { ExecutorContext } from '../executors/types.js';
import type { ToolActivityEvent, ToolDetailsSink } from './types.js';

export interface FileSinkDeps {
  dir: string;
  /** Base URL that serves `dir`; without it the summary carries no link. */
  urlBase?: string;
  platformId: string;
  sessionId: string;
  now?: () => Date;
}

// Built from the escape char's code: a literal control character in a regex
// literal trips no-control-regex, and rightly so.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A path segment that survives any filesystem; ':' in session ids is the usual offender. */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_') || '_';
}

const STYLE = 'body{font:14px/1.5 ui-monospace,monospace;max-width:60rem;margin:2rem auto;padding:0 1rem}pre{white-space:pre-wrap;margin:0;padding:.4rem .6rem;border-left:3px solid #ccc}pre.end{color:#666;border-color:#eee}h1{font-size:1.1rem}';

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLE}</style><h1>${escapeHtml(title)}</h1>\n${body}`;
}

export function createFileSink(deps: FileSinkDeps): ToolDetailsSink {
  const sessionDir = join(deps.dir, safeSegment(deps.platformId), safeSegment(deps.sessionId));
  const urlDir = deps.urlBase
    ? `${deps.urlBase.replace(/\/+$/, '')}/${encodeURIComponent(safeSegment(deps.platformId))}/${encodeURIComponent(safeSegment(deps.sessionId))}`
    : null;
  let turn = 1;
  let lines: string[] = [];
  const finished: Array<{ turn: number; tools: number; at: string }> = [];
  let failed = false;
  let chain: Promise<void> = Promise.resolve();

  const stamp = () => (deps.now?.() ?? new Date()).toISOString();

  async function writeTurn(done: boolean): Promise<void> {
    await mkdir(sessionDir, { recursive: true });
    const title = `Turn ${turn}${done ? '' : ' (running)'} — ${deps.sessionId}`;
    await writeFile(join(sessionDir, `${turn}.html`), page(title, lines.join('\n')));
  }

  async function writeIndex(): Promise<void> {
    const rows = finished.map((f) => `<li><a href="${f.turn}.html">Turn ${f.turn}</a> — ${f.tools} tool${f.tools === 1 ? '' : 's'} · ${escapeHtml(f.at)}</li>`);
    await writeFile(join(sessionDir, 'index.html'), page(`Tool details — ${deps.sessionId}`, `<ul>${rows.join('')}</ul>`));
  }

  /** Writes are sequential; the first failure is reported once and stops the sink. */
  function enqueue(ctx: ExecutorContext, work: () => Promise<void>): Promise<void> {
    if (failed) return chain;
    chain = chain.then(work).catch(async (err: unknown) => {
      if (failed) return;
      failed = true;
      const message = `tool details could not be written to ${sessionDir}: ${(err as Error).message}. Tool details are off for this session.`;
      ctx.logger.error(message);
      await ctx.createPost(`⚠️ ${message}`, { type: 'content' }).catch((postErr: unknown) => ctx.logger.error(`and the notice could not be posted: ${(postErr as Error).message}`));
    });
    return chain;
  }

  return {
    async append(op: ToolActivityEvent, ctx) {
      const text = escapeHtml(stripAnsi(op.display));
      lines.push(op.kind === 'start' ? `<pre class="tool">${text}</pre>` : `<pre class="end">${text}</pre>`);
      await enqueue(ctx, () => writeTurn(false));
    },
    async turnEnded(ctx) {
      const tools = lines.filter((l) => l.startsWith('<pre class="tool"')).length;
      await enqueue(ctx, async () => {
        await writeTurn(true);
        finished.push({ turn, tools, at: stamp() });
        await writeIndex();
      });
      turn++;
      lines = [];
    },
    link: () => (failed || !urlDir ? null : `${urlDir}/${turn}.html`),
    reset() {
      // The turn in progress is abandoned; its page stays as written so far.
      lines = [];
      turn++;
    },
  };
}
