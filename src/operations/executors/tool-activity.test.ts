import { describe, it, expect } from 'bun:test';
import { ToolActivityExecutor, renderToolSummary } from './tool-activity.js';
import { noneSink, type ToolDetailsSink, type ToolActivityEvent } from '../tool-details/types.js';
import { createToolActivityOp } from '../types.js';
import type { ExecutorContext } from './types.js';

const formatter = { formatLink: (text: string, url: string) => `[${text}](${url})` };
const ctx = { formatter, sessionId: 's' } as unknown as ExecutorContext;

function recordingSink(link: string | null = null) {
  const appended: ToolActivityEvent[] = [];
  let ended = 0;
  let resets = 0;
  const sink: ToolDetailsSink = {
    append: async (op) => { appended.push(op); },
    turnEnded: async () => { ended++; },
    link: () => link,
    reset: () => { resets++; },
  };
  return { sink, appended, ended: () => ended, resets: () => resets };
}

describe('renderToolSummary', () => {
  it('counts, times and marks running, failed and linked turns', () => {
    const base = { started: 1, finished: 0, failed: 0, firstStartAt: 1000, lastEndAt: null, lastTool: null };
    expect(renderToolSummary(base, 3500, null, formatter)).toBe('🔧 1 tool · 3 s…');
    expect(renderToolSummary({ ...base, started: 12, finished: 12, failed: 1, lastEndAt: 41000 }, 99000, null, formatter)).toBe('🔧 12 tools · 40 s · 1 ❌');
    expect(renderToolSummary({ ...base, finished: 1, lastEndAt: 2000 }, 9000, 'https://x/t/1.html', formatter)).toBe('🔧 1 tool · 1 s · [details](https://x/t/1.html)');
  });

  // @thejdubb02 in #505, agreed by the maintainer in #534: once the stream is
  // hidden this line is the only liveness signal, so it should say what the
  // bot is doing, not only how much it has done.
  it('carries the last tool name, MCP names shortened to the tool part', () => {
    const base = { started: 12, finished: 12, failed: 0, firstStartAt: 1000, lastEndAt: 41000, lastTool: 'Bash' };
    expect(renderToolSummary(base, 99000, null, formatter)).toBe('🔧 12 tools · 40 s · Bash');
    expect(renderToolSummary({ ...base, failed: 1 }, 99000, null, formatter)).toBe('🔧 12 tools · 40 s · Bash · 1 ❌');
    expect(renderToolSummary({ ...base, lastTool: 'mcp__playwright__browser_navigate' }, 99000, null, formatter))
      .toBe('🔧 12 tools · 40 s · browser_navigate');
    expect(renderToolSummary({ ...base, lastTool: null }, 99000, null, formatter)).toBe('🔧 12 tools · 40 s');
  });
});

describe('ToolActivityExecutor', () => {
  it('summary: every start and end re-renders the header and reaches the sink; turn_end renders the final line', async () => {
    const headers: string[] = [];
    const { sink, appended } = recordingSink();
    let now = 1000;
    const exec = new ToolActivityExecutor({ mode: 'summary', sink, onHeader: (l) => headers.push(l), now: () => now });

    await exec.execute(createToolActivityOp('s', { kind: 'start', toolUseId: 't1', name: 'Bash', display: 'Bash ls' }), ctx);
    now = 6000;
    await exec.execute(createToolActivityOp('s', { kind: 'end', toolUseId: 't1', ok: false, elapsedMs: 5000, display: '  ↳ ❌' }), ctx);
    now = 9000;
    await exec.execute(createToolActivityOp('s', { kind: 'turn_end' }), ctx);

    expect(headers).toEqual(['🔧 1 tool · 0 s… · Bash', '🔧 1 tool · 5 s · Bash · 1 ❌', '🔧 1 tool · 5 s · Bash · 1 ❌']);
    expect(appended.map((op) => op.kind)).toEqual(['start', 'end']);
  });

  it('reset is idempotent: a turn with no tools is not abandoned twice', async () => {
    // The respawn path reaches reset() twice on a fresh-session restart
    // (restartClaudeSession, then clearClaudeSessionState). A sink that
    // numbers turns — the file sink does — would skip one per extra call.
    const { sink, resets } = recordingSink();
    const exec = new ToolActivityExecutor({ mode: 'summary', sink, onHeader: () => {} });

    exec.reset();
    exec.reset();
    expect(resets()).toBe(0);

    await exec.execute(createToolActivityOp('s', { kind: 'start', toolUseId: 't1', name: 'Bash', display: 'Bash ls' }), ctx);
    exec.reset();
    exec.reset();
    expect(resets()).toBe(1);
  });

  it('hidden: the sink still gets every line, the header is never rendered', async () => {
    const headers: string[] = [];
    const { sink, appended } = recordingSink();
    const exec = new ToolActivityExecutor({ mode: 'hidden', sink, onHeader: (l) => headers.push(l) });

    await exec.execute(createToolActivityOp('s', { kind: 'start', toolUseId: 't1', name: 'Read', display: 'Read x' }), ctx);
    await exec.execute(createToolActivityOp('s', { kind: 'end', toolUseId: 't1', ok: true, elapsedMs: 10, display: '  ↳ ✓' }), ctx);

    expect(headers).toEqual([]);
    expect(appended).toHaveLength(2);
  });

  it('after the result flush the sink is told the turn ended and the counter starts over; a turn without tools is silent', async () => {
    const { sink, ended } = recordingSink();
    const exec = new ToolActivityExecutor({ mode: 'summary', sink, onHeader: () => undefined });

    await exec.afterResultFlush(ctx);
    expect(ended()).toBe(0);

    await exec.execute(createToolActivityOp('s', { kind: 'start', toolUseId: 't1', name: 'Read', display: 'Read x' }), ctx);
    await exec.execute(createToolActivityOp('s', { kind: 'turn_end' }), ctx);
    await exec.afterResultFlush(ctx);

    expect(ended()).toBe(1);
    expect(exec.getStats().started).toBe(0);
  });

  it('the none sink accepts everything and links nothing', async () => {
    await noneSink.append(createToolActivityOp('s', { kind: 'start', toolUseId: 't', name: 'n', display: 'd' }) as ToolActivityEvent, ctx);
    await noneSink.turnEnded(ctx);
    expect(noneSink.link()).toBeNull();
  });

  it('reset clears the counter and resets the sink', async () => {
    const { sink, resets } = recordingSink();
    const exec = new ToolActivityExecutor({ mode: 'summary', sink, onHeader: () => undefined });
    await exec.execute(createToolActivityOp('s', { kind: 'start', toolUseId: 't1', name: 'Read', display: 'Read x' }), ctx);

    exec.reset();

    expect(exec.getStats().started).toBe(0);
    expect(resets()).toBe(1);
  });
});

describe('ToolActivityExecutor turn boundaries (pre-release review)', () => {
  const startOp = (id: string) => createToolActivityOp('s', { kind: 'start', toolUseId: id, name: 'Bash', display: `Bash ${id}` });

  it('a turn ending with a tool still running renders a final line, not a running one', async () => {
    const headers: string[] = [];
    const exec = new ToolActivityExecutor({ mode: 'summary', sink: noneSink, onHeader: (l) => headers.push(l), now: () => 5000 });
    await exec.execute(startOp('t1'), ctx); // interrupted: no end op follows
    await exec.execute(createToolActivityOp('s', { kind: 'turn_end' }), ctx);

    expect(headers.at(-1)).not.toContain('…');
  });

  it('a tool of the next turn arriving while the details are delivered counts for the next turn', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const sink: ToolDetailsSink = { ...noneSink, turnEnded: async () => { await gate; } };
    const exec = new ToolActivityExecutor({ mode: 'summary', sink, onHeader: () => undefined });
    await exec.execute(startOp('t1'), ctx);

    const delivering = exec.afterResultFlush(ctx); // turn N's details are being written...
    await exec.execute(startOp('t2'), ctx); // ...when turn N+1's first tool starts
    release();
    await delivering;

    expect(exec.getStats().started).toBe(1);
  });
});

describe('ToolActivityExecutor after an interrupted turn (review round 2)', () => {
  const warnCtx = () => {
    const warnings: string[] = [];
    return { warnings, c: { formatter, sessionId: 's', logger: { warn: (m: string) => warnings.push(m), debug: () => undefined } } as unknown as ExecutorContext };
  };

  it('ignores the late end of a tool the previous turn already closed', async () => {
    const headers: string[] = [];
    const exec = new ToolActivityExecutor({ mode: 'summary', sink: noneSink, onHeader: (l) => headers.push(l), now: () => 1000 });
    await exec.execute(createToolActivityOp('s', { kind: 'start', toolUseId: 'x', name: 'Bash', display: 'x' }), ctx);
    await exec.execute(createToolActivityOp('s', { kind: 'turn_end' }), ctx);
    await exec.afterResultFlush(ctx);
    const before = headers.length;

    // The interrupted tool's result arrives in the next turn.
    await exec.execute(createToolActivityOp('s', { kind: 'end', toolUseId: 'x', ok: true, elapsedMs: 0, display: 'e' }), ctx);

    expect(headers.length).toBe(before);
    expect(exec.getStats()).toMatchObject({ started: 0, finished: 0 });
  });

  it('a failing details sink does not fail the turn end', async () => {
    const sink: ToolDetailsSink = { ...noneSink, turnEnded: async () => { throw new Error('flush boom'); } };
    const exec = new ToolActivityExecutor({ mode: 'summary', sink, onHeader: () => undefined });
    const { warnings, c } = warnCtx();
    await exec.execute(createToolActivityOp('s', { kind: 'start', toolUseId: 'x', name: 'Bash', display: 'x' }), c);

    await expect(exec.afterResultFlush(c)).resolves.toBeUndefined();
    expect(warnings.some((w) => w.includes('flush boom'))).toBe(true);
  });
});

describe('ToolActivityExecutor matches ends by tool id (review round 3)', () => {
  it('a late end of the interrupted tool does not stand in for the next tool\'s end', async () => {
    const rec = recordingSink();
    const exec = new ToolActivityExecutor({ mode: 'summary', sink: rec.sink, onHeader: () => undefined, now: () => 1000 });
    const s = (id: string) => createToolActivityOp('s', { kind: 'start', toolUseId: id, name: 'Bash', display: `start ${id}` });
    const e = (id: string, ok: boolean) => createToolActivityOp('s', { kind: 'end', toolUseId: id, ok, elapsedMs: 0, display: `end ${id}` });

    await exec.execute(s('x'), ctx);
    await exec.execute(createToolActivityOp('s', { kind: 'turn_end' }), ctx); // interrupted
    await exec.afterResultFlush(ctx);
    await exec.execute(s('y'), ctx);
    await exec.execute(e('x', true), ctx); // late
    await exec.execute(e('y', false), ctx); // the real one

    expect(exec.getStats()).toMatchObject({ started: 1, finished: 1, failed: 1 });
    expect(rec.appended.map((op) => op.display)).toContain('end y');
    expect(rec.appended.map((op) => op.display)).not.toContain('end x');
  });
});
