import { describe, it, expect, mock } from 'bun:test';
import { createThreadSink } from './thread.js';
import { ContentExecutor } from '../executors/content.js';
import type { ExecutorContext } from '../executors/types.js';
import { createToolActivityOp } from '../types.js';
import type { ToolActivityEvent } from './types.js';
import { DefaultContentBreaker } from '../content-breaker.js';
import { PostTracker } from '../post-tracker.js';

function fakeContext(root: string) {
  const created: Array<{ content: string; root: string }> = [];
  const updated: Array<{ id: string; content: string }> = [];
  const warnings: string[] = [];
  const platform = {
    getFormatter: () => ({ formatMarkdown: (t: string) => t }),
    createPost: mock(async (content: string, threadId: string) => {
      created.push({ content, root: threadId });
      return { id: `d${created.length}`, platformId: 'p', channelId: 'c', message: content, createAt: 0, userId: 'bot' };
    }),
    updatePost: mock(async (id: string, content: string) => { updated.push({ id, content }); }),
    getMessageLimits: () => ({ maxLength: 16000, hardThreshold: 12000 }),
  };
  const ctx = {
    sessionId: 's',
    threadId: root,
    platform,
    formatter: { formatMarkdown: (t: string) => t, formatItalic: (t: string) => `_${t}_` },
    logger: { debug: () => undefined, info: () => undefined, warn: (m: string) => warnings.push(m), error: () => undefined },
    postTracker: new PostTracker(),
    contentBreaker: new DefaultContentBreaker(),
    createPost: async (content: string) => platform.createPost(content, root),
  } as unknown as ExecutorContext;
  return { ctx, created, updated, warnings };
}

const start = (id: string, display: string) => createToolActivityOp('s', { kind: 'start', toolUseId: id, name: 'Bash', display }) as ToolActivityEvent;
const end = (id: string) => createToolActivityOp('s', { kind: 'end', toolUseId: id, ok: true, elapsedMs: 0, display: '  ↳ ✓' }) as ToolActivityEvent;

describe('thread sink', () => {
  it('posts the tool lines under the turn root and closes at turn end', async () => {
    const { ctx, created, updated } = fakeContext('root-1');
    const sink = createThreadSink({ contextFor: () => ctx, makeExecutor: () => new ContentExecutor({ registerPost: () => undefined, updateLastMessage: () => undefined }) });

    await sink.append(start('t1', 'Bash ls'), ctx);
    await sink.append(end('t1'), ctx);
    await sink.turnEnded(ctx);

    expect(created).toHaveLength(1);
    expect(created[0].root).toBe('root-1');
    expect(created[0].content).toContain('Bash ls');
    expect(created[0].content).toContain('↳ ✓');
    expect(updated).toHaveLength(0);
  });

  it('queues lines until a root exists, then delivers them together', async () => {
    const { ctx, created } = fakeContext('root-2');
    let available = false;
    const sink = createThreadSink({ contextFor: () => (available ? ctx : null), makeExecutor: () => new ContentExecutor({ registerPost: () => undefined, updateLastMessage: () => undefined }) });

    await sink.append(start('t1', 'Read a'), ctx);
    expect(created).toHaveLength(0);
    available = true;
    await sink.append(start('t2', 'Read b'), ctx);
    await sink.turnEnded(ctx);

    expect(created).toHaveLength(1);
    expect(created[0].content).toContain('Read a');
    expect(created[0].content).toContain('Read b');
  });

  it('a turn that never gets a root drops its lines with a warning, not silently', async () => {
    const { ctx, created, warnings } = fakeContext('root-3');
    const sink = createThreadSink({ contextFor: () => null, makeExecutor: () => new ContentExecutor({ registerPost: () => undefined, updateLastMessage: () => undefined }) });

    await sink.append(start('t1', 'Read a'), ctx);
    await sink.turnEnded(ctx);

    expect(created).toHaveLength(0);
    expect(warnings.join(' ')).toContain('dropped');
  });

  it('each turn starts a fresh executor under the current root', async () => {
    const { ctx, created } = fakeContext('root-4');
    let root = 'turn-a';
    const sink = createThreadSink({ contextFor: () => ({ ...ctx, createPost: async (c: string) => ctx.platform.createPost(c, root) }) as ExecutorContext, makeExecutor: () => new ContentExecutor({ registerPost: () => undefined, updateLastMessage: () => undefined }) });

    await sink.append(start('t1', 'first turn'), ctx);
    await sink.turnEnded(ctx);
    root = 'turn-b';
    await sink.append(start('t2', 'second turn'), ctx);
    await sink.turnEnded(ctx);

    expect(created.map((c) => c.root)).toEqual(['turn-a', 'turn-b']);
  });

  it('reset forgets the turn in progress: nothing queued survives, nothing is posted later', async () => {
    const { ctx, created, warnings } = fakeContext('root-5');
    const sink = createThreadSink({ contextFor: () => null, makeExecutor: () => new ContentExecutor({ registerPost: () => undefined, updateLastMessage: () => undefined }) });

    await sink.append(start('t1', 'Read a'), ctx);
    sink.reset();
    await sink.turnEnded(ctx);

    expect(created).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });
});

describe('thread sink reset during a drain', () => {
  it('stops the drain in flight: no crash on the released executor, no flush scheduled after the reset', async () => {
    // A respawn or the session ending calls reset() while a drain may still
    // be awaiting its executor. Before the fix, the loop's next iteration
    // dereferenced the executor reset() had just nulled, and a surviving
    // drain scheduled a details flush for a turn that no longer exists.
    const { ctx } = fakeContext('root-r');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const scheduleFlush = mock(() => undefined);
    const fakeExecutor = {
      executeAppend: mock(async () => { await gate; }),
      scheduleFlush,
      executeFlush: mock(async () => undefined),
      closeCurrentPost: mock(() => undefined),
      reset: mock(() => undefined),
    } as unknown as ContentExecutor;
    let available = false;
    const sink = createThreadSink({ contextFor: () => (available ? ctx : null), makeExecutor: () => fakeExecutor });

    // Two lines queue while there is no root; the third append drains all three.
    await sink.append(start('t1', 'Bash a'), ctx);
    await sink.append(end('t1'), ctx);
    available = true;
    const draining = sink.append(start('t2', 'Bash b'), ctx);

    sink.reset();
    release();

    await expect(draining).resolves.toBeUndefined();
    expect(scheduleFlush).not.toHaveBeenCalled();
  });
});

describe('thread sink: turn end while a timer flush is writing', () => {
  it('waits for the in-flight flush instead of creating a second details post', async () => {
    // The sink's own flush timer fired and its createPost is still in flight
    // (a slow platform) when the result arrives. The turn-end flush must wait
    // for it: before, it saw no post yet and created a second one with the
    // same lines.
    const { ctx, created } = fakeContext('root-slow');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const slowCtx = { ...ctx, createPost: async (content: string, options: never) => { await gate; return ctx.createPost(content, options); } } as ExecutorContext;
    const sink = createThreadSink({
      contextFor: () => slowCtx,
      makeExecutor: () => new ContentExecutor({ registerPost: () => undefined, updateLastMessage: () => undefined }),
    });

    await sink.append(start('t1', 'Bash ls'), slowCtx);
    await new Promise((r) => setTimeout(r, 600)); // the 500 ms timer fires; its createPost waits on the gate
    const ending = sink.turnEnded(slowCtx);
    release();
    await ending;
    await new Promise((r) => setTimeout(r, 20));

    expect(created).toHaveLength(1);
  });
});

describe('thread sink: holdUntilTurnEnd', () => {
  it('posts nothing while the turn runs, then all lines in one post at turn end', async () => {
    // A thread session: the details share the reply's thread, so a post made
    // mid-turn would sit above reply posts that are still to come.
    const { ctx, created } = fakeContext('root-hold');
    const sink = createThreadSink({
      contextFor: () => ctx,
      makeExecutor: () => new ContentExecutor({ registerPost: () => undefined, updateLastMessage: () => undefined }),
      holdUntilTurnEnd: true,
      flushDelayMs: 5,
    });

    await sink.append(start('t1', 'Bash ls'), ctx);
    await sink.append(end('t1'), ctx);
    // Longer than any streaming flush delay, including the 500 ms default.
    await new Promise((r) => setTimeout(r, 600));
    expect(created).toHaveLength(0);

    await sink.turnEnded(ctx);
    expect(created).toHaveLength(1);
    expect(created[0].content).toContain('Bash ls');
    expect(created[0].content).toContain('↳ ✓');
  });

  it('a line of the next turn arriving during delivery is not dropped with the ended turn', async () => {
    const { ctx, created } = fakeContext('root-next');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    const slowCtx = { ...ctx, createPost: async (content: string, options: never) => { if (first) { first = false; await gate; } return ctx.createPost(content, options); } } as ExecutorContext;
    const sink = createThreadSink({
      contextFor: () => slowCtx,
      makeExecutor: () => new ContentExecutor({ registerPost: () => undefined, updateLastMessage: () => undefined }),
      holdUntilTurnEnd: true,
    });

    await sink.append(start('t1', 'Bash turn-one'), slowCtx);
    const ending = sink.turnEnded(slowCtx);
    await sink.append(start('t2', 'Bash turn-two'), slowCtx);
    release();
    await ending;
    await sink.turnEnded(slowCtx);

    expect(created.map((c) => c.content)).toEqual([expect.stringContaining('turn-one'), expect.stringContaining('turn-two')]);
  });
});

describe('thread sink: a long held turn', () => {
  it('delivers every line across several posts instead of truncating one', async () => {
    // Held until turn end, a long turn reaches the executor as one big append.
    // A first flush with no post yet truncates at the platform limit, so the
    // sink has to flush in chunks and let the executor split.
    const { ctx, created, updated } = fakeContext('root-long');
    const sink = createThreadSink({
      contextFor: () => ctx,
      makeExecutor: () => new ContentExecutor({ registerPost: () => undefined, updateLastMessage: () => undefined }),
      holdUntilTurnEnd: true,
    });
    for (let i = 0; i < 400; i++) {
      await sink.append(start(`t${i}`, `🔧 Bash \`cat /some/long/path/file-${i}.ts | grep something\` LINE${i}.`), ctx);
    }
    await sink.turnEnded(ctx);

    const finalText = new Map<string, string>();
    created.forEach((c, i) => finalText.set(`d${i + 1}`, c.content));
    for (const u of updated) finalText.set(u.id, u.content);
    const all = [...finalText.values()].join('\n');
    const missing = [...Array(400).keys()].filter((i) => !all.includes(`LINE${i}.`));
    expect(missing).toEqual([]);
    expect(all).not.toContain('(truncated)');
    expect(created.length).toBeGreaterThan(1);
  });
});

describe('thread sink: failing platform and late roots (review round 3)', () => {
  it('stops flushing in chunks once a flush cannot shrink the pending text', async () => {
    // A rate-limited platform refuses every post; the pending text then never
    // shrinks, and a flush per line turned one held turn into thousands of
    // createPost attempts.
    const { ctx } = fakeContext('root-429');
    let attempts = 0;
    const failing = { ...ctx, createPost: async () => { attempts++; throw new Error('429 ratelimited'); } } as unknown as ExecutorContext;
    const sink = createThreadSink({
      contextFor: () => failing,
      makeExecutor: () => new ContentExecutor({ registerPost: () => undefined, updateLastMessage: () => undefined }),
      holdUntilTurnEnd: true,
    });
    for (let i = 0; i < 400; i++) await sink.append(start(`t${i}`, `🔧 Bash \`cat /some/long/path/file-${i}.ts | grep something\` LINE${i}.`), failing);
    await sink.turnEnded(failing);

    // What remains is the turn-end flush trying each post-sized chunk once
    // (about 20 here): bounded by the content, not by the line count. Before
    // the fix this was 4281.
    expect(attempts).toBeLessThan(50);
  });

  it('wake() delivers lines that queued while the turn had no root yet', async () => {
    const { ctx, created } = fakeContext('root-wake');
    let root = false;
    const sink = createThreadSink({
      contextFor: () => (root ? ctx : null),
      makeExecutor: () => new ContentExecutor({ registerPost: () => undefined, updateLastMessage: () => undefined }),
      flushDelayMs: 5,
    });
    await sink.append(start('t1', 'Bash build'), ctx); // no reply post yet: queued
    root = true; // the reply post now exists...
    (sink as { wake?: () => void }).wake?.(); // ...and the manager says so
    await new Promise((r) => setTimeout(r, 40));

    expect(created.map((c) => c.content)).toEqual([expect.stringContaining('Bash build')]);
  });
});
