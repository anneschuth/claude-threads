/**
 * Black-box end-to-end run of the BUILT bot under Node.
 *
 * Every other test in this repo runs the bot's code inside `bun test`, so a
 * behavior that differs between Bun and Node (#569: `removeAllListeners`
 * semantics) passes CI and fails in production, where `claude-threads` is
 * `node dist/index.js`. This test starts exactly that process, headless,
 * against the in-process Slack mock, with the mock Claude CLI, and drives one
 * two sessions through Socket Mode: mention, reply, `!stop` (the dispose
 * path #569 leaked on), a second session, then SIGTERM while it is live
 * (the shutdown path #556 fixed) and the persisted state it leaves behind.
 * Permissions are interactive, so the bot spawns its MCP permission server
 * as `node dist/mcp/mcp-server.js` and the mock CLI connects to it; that
 * path runs under Node as well. What this cannot see: a silent leak that
 * changes nothing observable. It sees crashes, hangs, uncaught errors,
 * Node's own MaxListenersExceededWarning, and any behavior change in the
 * session round trip.
 *
 * Needs `bun run build` first (the CI job does it; `bun run test:node-e2e`
 * does it locally). Not part of `bun run test`.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { SlackMockServer } from '../integration/fixtures/slack/mock-server.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const DIST_INDEX = join(ROOT, 'dist', 'index.js');
const MOCK_CLAUDE = join(ROOT, 'tests', 'integration', 'fixtures', 'mock-claude', 'mock-claude');
const PORT = Number(process.env.NODE_E2E_SLACK_PORT ?? 0); // 0: a free port
const BOT_USER = 'U_BOT_USER';
const TEST_USER = 'U_TEST_USER1';
const REPLY_TIMEOUT_MS = Number(process.env.NODE_E2E_REPLY_TIMEOUT_MS ?? 60_000);
// persistent-session keeps the mock CLI alive between turns, like the real
// CLI, so !stop and SIGTERM both meet a live session.
const SCENARIO = process.env.NODE_E2E_SCENARIO ?? 'persistent-session';
const REPLY_TEXT = "I'm ready to help";

async function waitFor<T>(probe: () => T | null | undefined | false, timeoutMs: number, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe('built bot under Node (Slack mock, mock Claude)', () => {
  let server: SlackMockServer;
  let home: string;
  let bot: ChildProcess | null = null;
  let stdout = '';
  let stderr = '';
  let failed = true; // flipped at the end of the test body

  beforeAll(async () => {
    for (const f of [DIST_INDEX, join(ROOT, 'dist', 'mcp', 'mcp-server.js')]) {
      if (!existsSync(f)) throw new Error(`${f} missing: run \`bun run build\` first`);
    }
    server = new SlackMockServer({ port: PORT, debug: process.env.DEBUG === '1' });
    await server.start();

    // A private HOME: config.yaml, sessions, logs and memory all land here.
    home = mkdtempSync(join(tmpdir(), 'ct-node-e2e-'));
    const work = join(home, 'work');
    mkdirSync(work, { recursive: true });
    mkdirSync(join(home, '.config', 'claude-threads'), { recursive: true });
    writeFileSync(join(home, '.config', 'claude-threads', 'config.yaml'), [
      'version: 1',
      `workingDir: ${work}`,
      'chrome: false',
      'worktreeMode: off',
      'keepAlive: false',
      'autoUpdate:',
      '  enabled: false',
      'platforms:',
      '  - id: node-e2e-slack',
      '    type: slack',
      '    displayName: Node e2e',
      `    botToken: ${server.getBotToken()}`,
      `    appToken: ${server.getAppToken()}`,
      `    channelId: ${server.getChannelId()}`,
      '    botName: claude-code',
      '    allowedUsers: [testuser1]',
      '    permissionMode: default',
      `    apiUrl: ${server.getUrl()}/api`,
      '    memory: false',
      '    routines: false',
      '    watches: false',
      '',
    ].join('\n'), { mode: 0o600 });
  });

  afterAll(async () => {
    if (failed) {
      console.log('--- bot stdout (tail) ---\n' + stdout.split('\n').slice(-80).join('\n'));
      console.log('--- bot stderr (tail) ---\n' + stderr.split('\n').slice(-40).join('\n'));
    }
    if (bot && bot.exitCode === null) {
      try { bot.kill('SIGKILL'); } catch { /* gone */ }
    }
    await server.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test('starts, answers a mention over Socket Mode, and shuts down cleanly on SIGTERM', async () => {
    bot = spawn('node', [DIST_INDEX, '--headless', '--no-auto-restart', '--no-keep-alive'], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CLAUDE_PATH: MOCK_CLAUDE,
        CLAUDE_SCENARIO: SCENARIO,
        CLAUDE_THREADS_SESSIONS_PATH: join(home, 'sessions.json'),
        CLAUDE_THREADS_MEMORY_DIR: join(home, 'memory'),
        CLAUDE_THREADS_ROUTINES_PATH: join(home, 'routines.yaml'),
        CLAUDE_THREADS_WATCHES_PATH: join(home, 'watches.yaml'),
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    bot.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
    bot.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });
    const exited = new Promise<number | null>((r) => bot!.on('exit', (code) => r(code)));

    await waitFor(() => stdout.includes('Bot ready and listening for messages') || null, 45_000, 'the bot to report ready');
    // The mention travels over the Socket Mode websocket; the mock drops
    // events while nobody is connected, so ask the mock, not the log.
    await waitFor(() => server.getSocketModeConnectionCount() > 0 || null, 30_000, 'the Socket Mode connection');

    const channel = server.getChannelId();
    const botPosts = () => [...server.getState().messages.values()].filter((m) => m.user === BOT_USER);
    const replyIn = (threadTs: string) => botPosts().find((m) => m.thread_ts === threadTs && m.text.includes(REPLY_TEXT));

    // Session 1: mention, reply, then !stop, which runs the dispose path.
    const first = server.simulateMessageEvent(channel, TEST_USER, `<@${BOT_USER}> hello from node e2e`);
    const reply1 = await waitFor(() => replyIn(first.ts), REPLY_TIMEOUT_MS, "Claude's reply in thread 1");
    expect(reply1.text).toContain(REPLY_TEXT);
    // Session header in the thread, sticky at the top level: both went through Node.
    expect(botPosts().some((m) => m.thread_ts === first.ts && m.ts !== reply1.ts)).toBe(true);
    expect(botPosts().some((m) => !m.thread_ts)).toBe(true);

    server.simulateMessageEvent(channel, TEST_USER, '!stop', first.ts);
    await waitFor(
      () => botPosts().find((m) => m.thread_ts === first.ts && /Session cancelled/.test(m.text)),
      30_000, 'the "Session cancelled" post',
    );

    // Session 2 in a fresh thread; SIGTERM lands while it is live. Starting
    // it at all proves the first one left the registry (dispose ran).
    const second = server.simulateMessageEvent(channel, TEST_USER, `<@${BOT_USER}> second session`);
    await waitFor(() => replyIn(second.ts), REPLY_TIMEOUT_MS, "Claude's reply in thread 2");
    // And a fresh session in the STOPPED thread must start too: a stale
    // registry entry would swallow this message instead.
    const again = server.simulateMessageEvent(channel, TEST_USER, `<@${BOT_USER}> again after stop`, undefined);
    await waitFor(() => replyIn(again.ts), REPLY_TIMEOUT_MS, "Claude's reply in the third thread");

    // The claim that the MCP permission server runs under Node is checked,
    // not assumed: while session 2 is live, its child must be visible as
    // `node .../dist/mcp/mcp-server.js` (the mock CLI spawns the real server
    // from --mcp-config because permissions are interactive).
    const procs = execSync('ps -eo args', { encoding: 'utf8' });
    expect(procs).toMatch(/^node .*dist\/mcp\/mcp-server\.js/m);

    bot.kill('SIGTERM');
    const code = await Promise.race([
      exited,
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 20_000)),
    ]);
    expect(code).toBe(0);

    // Shutdown persists the live session for resume; the file is under the private HOME.
    const sessionsFile = join(home, 'sessions.json');
    expect(existsSync(sessionsFile)).toBe(true);
    expect(readFileSync(sessionsFile, 'utf8')).toContain(second.ts);

    // Runtime-semantics bugs surface as uncaught errors or Node's own leak
    // warning, not as failed assertions. stderr is empty on a healthy run.
    expect(stderr).not.toMatch(/TypeError|ReferenceError|Unhandled|ERR_|MaxListenersExceededWarning/);
    expect(stdout).not.toMatch(/\[ERROR\]/);
    failed = false;
  }, 200_000);
});
