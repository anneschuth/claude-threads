/**
 * Black-box end-to-end run of the BUILT bot under Node.
 *
 * Every other test in this repo runs the bot's code inside `bun test`, so a
 * behavior that differs between Bun and Node (#569: `removeAllListeners`
 * semantics) passes CI and fails in production, where `claude-threads` is
 * `node dist/index.js`. This test starts exactly that process, headless,
 * against the in-process Slack mock, with the mock Claude CLI, and drives one
 * session through Socket Mode: mention, reply, graceful SIGTERM. The MCP
 * permission server is spawned by the bot as `node dist/mcp/mcp-server.js`,
 * so that path runs under Node too.
 *
 * Needs `bun run build` first (the CI job does it; `bun run test:node-e2e`
 * does it locally). Not part of `bun run test`.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { SlackMockServer } from '../integration/fixtures/slack/mock-server.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const DIST_INDEX = join(ROOT, 'dist', 'index.js');
const MOCK_CLAUDE = join(ROOT, 'tests', 'integration', 'fixtures', 'mock-claude', 'mock-claude');
const PORT = Number(process.env.NODE_E2E_SLACK_PORT ?? 3461);
const BOT_USER = 'U_BOT_USER';
const TEST_USER = 'U_TEST_USER1';
const REPLY_TIMEOUT_MS = Number(process.env.NODE_E2E_REPLY_TIMEOUT_MS ?? 60_000);
const SCENARIO = process.env.NODE_E2E_SCENARIO ?? 'simple-response';

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
    if (!existsSync(DIST_INDEX)) throw new Error(`${DIST_INDEX} missing: run \`bun run build\` first`);
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
      '    permissionMode: bypass',
      `    apiUrl: http://localhost:${PORT}/api`,
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
    // The mention travels over the Socket Mode websocket; wait until the bot
    // has actually completed the handshake before injecting it.
    await waitFor(() => /hello|: connected/i.test(stdout) || null, 30_000, 'the Socket Mode connection');
    await new Promise((r) => setTimeout(r, 500));

    const channel = server.getChannelId();
    const mention = server.simulateMessageEvent(channel, TEST_USER, `<@${BOT_USER}> hello from node e2e`);

    const reply = await waitFor(
      () => [...server.getState().messages.values()].find(
        (m) => m.user === BOT_USER && m.thread_ts === mention.ts && m.text.includes('mock response'),
      ),
      REPLY_TIMEOUT_MS,
      "Claude's reply in the thread",
    );
    expect(reply.text).toContain('I received your message');

    // The session header is a bot post in the same thread; the sticky is a
    // top-level bot post in the channel. Both went through Node.
    const botPosts = [...server.getState().messages.values()].filter((m) => m.user === BOT_USER);
    expect(botPosts.some((m) => m.thread_ts === mention.ts && m.ts !== reply.ts)).toBe(true);
    expect(botPosts.some((m) => !m.thread_ts)).toBe(true);

    bot.kill('SIGTERM');
    const code = await Promise.race([
      exited,
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 20_000)),
    ]);
    expect(code).toBe(0);

    // Runtime-semantics bugs surface here as uncaught errors, not as failed assertions.
    expect(stderr).not.toMatch(/TypeError|ReferenceError|Unhandled|ERR_/);
    failed = false;
  }, 150_000);
});
