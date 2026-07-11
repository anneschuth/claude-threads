#!/usr/bin/env bun
/**
 * Mock Codex CLI (app-server mode) for integration testing
 *
 * Simulates `codex app-server`: JSON-RPC 2.0 over newline-delimited stdio.
 * Handles the subset of the protocol that CodexCli (src/agents/codex/cli.ts)
 * speaks: initialize/initialized, thread/start, thread/resume, turn/start,
 * turn/interrupt, and server-initiated approval requests.
 *
 * Usage (wired via CODEX_PATH in tests/integration/helpers/bot-starter.ts):
 *   CODEX_SCENARIO=codex-simple mock-codex app-server
 *
 * Environment variables:
 *   CODEX_SCENARIO  - Scenario file from ./scenarios (default: 'codex-simple')
 *   MOCK_DELAY      - Base delay between events in ms (default: 50)
 *   DEBUG           - Set to '1' for debug logging on stderr
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = join(__dirname, 'scenarios');

const SCENARIO = process.env.CODEX_SCENARIO || process.env.CLAUDE_SCENARIO || 'codex-simple';
const BASE_DELAY = parseInt(process.env.MOCK_DELAY || '50', 10);
const DEBUG = process.env.DEBUG === '1';

function debug(msg: string): void {
  if (DEBUG) console.error(`[mock-codex] ${msg}`);
}

interface ScenarioNotification {
  method: string;
  delay?: number;
  params: Record<string, unknown>;
}

interface MockCodexScenario {
  name: string;
  description?: string;
  model?: string;
  /** When set, an approval request is sent before turn events and the mock waits for the decision */
  approval?: { command: string; cwd?: string };
  /** Notifications played after each turn/start (placeholders: $THREAD_ID, $TURN_ID) */
  turnEvents: ScenarioNotification[];
  /** When true, thread/resume responds with an error (for permanent-failure tests) */
  failResume?: boolean;
}

function loadScenario(name: string): MockCodexScenario {
  const path = join(SCENARIOS_DIR, `${name}.json`);
  if (!existsSync(path)) {
    console.error(`[mock-codex] Scenario not found: ${path}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as MockCodexScenario;
}

const scenario = loadScenario(SCENARIO);
debug(`Loaded scenario: ${scenario.name}`);

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

let serverRequestId = 0;
const pendingApprovals = new Map<number, (decision: string) => void>();

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function respond(id: number | string, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id: number | string, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
}

function notify(method: string, params: unknown): void {
  send({ jsonrpc: '2.0', method, params });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ask for approval and wait for the client's decision */
function requestApproval(params: Record<string, unknown>): Promise<string> {
  const id = serverRequestId++;
  return new Promise((resolve) => {
    pendingApprovals.set(id, resolve);
    send({ jsonrpc: '2.0', id, method: 'item/commandExecution/requestApproval', params });
  });
}

// ---------------------------------------------------------------------------
// Protocol state
// ---------------------------------------------------------------------------

const THREAD_ID = `mock-thread-${SCENARIO}`;
const MODEL = scenario.model ?? 'gpt-5.5-codex-mock';
let turnCounter = 0;

function substitute(value: unknown, turnId: string): unknown {
  const json = JSON.stringify(value)
    .replaceAll('$THREAD_ID', THREAD_ID)
    .replaceAll('$TURN_ID', turnId);
  return JSON.parse(json);
}

async function playTurn(): Promise<void> {
  const turnId = `mock-turn-${++turnCounter}`;

  notify('turn/started', { threadId: THREAD_ID, turn: { id: turnId, items: [], status: 'inProgress' } });

  if (scenario.approval) {
    debug('Requesting command approval');
    const decision = await requestApproval({
      threadId: THREAD_ID,
      turnId,
      itemId: `exec-approval-${turnId}`,
      command: scenario.approval.command,
      cwd: scenario.approval.cwd ?? '/tmp',
      startedAtMs: 0,
    });
    debug(`Approval decision: ${decision}`);
    if (decision !== 'accept' && decision !== 'acceptForSession') {
      // Denied: report a declined command and finish the turn
      notify('item/completed', {
        threadId: THREAD_ID,
        turnId,
        completedAtMs: 0,
        item: { type: 'commandExecution', id: `exec-${turnId}`, command: scenario.approval.command, status: 'declined', exitCode: null },
      });
      notify('item/completed', {
        threadId: THREAD_ID,
        turnId,
        completedAtMs: 0,
        item: { type: 'agentMessage', id: `msg-denied-${turnId}`, text: 'Command was denied, stopping here.' },
      });
      notify('turn/completed', { threadId: THREAD_ID, turn: { id: turnId, items: [], status: 'completed', error: null } });
      return;
    }
  }

  for (const event of scenario.turnEvents) {
    await sleep(event.delay ?? BASE_DELAY);
    notify(event.method, substitute(event.params, turnId));
  }
}

// ---------------------------------------------------------------------------
// Message loop
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: { decision?: string } };
  try {
    msg = JSON.parse(trimmed);
  } catch {
    debug(`Unparseable line: ${trimmed.slice(0, 100)}`);
    return;
  }

  // Client response to one of our approval requests
  if (msg.id !== undefined && msg.method === undefined) {
    const resolver = pendingApprovals.get(msg.id as number);
    if (resolver) {
      pendingApprovals.delete(msg.id as number);
      resolver(msg.result?.decision ?? 'decline');
    }
    return;
  }

  debug(`<- ${msg.method}`);
  switch (msg.method) {
    case 'initialize':
      respond(msg.id!, { userAgent: 'mock-codex/0.144.0' });
      break;

    case 'initialized':
      break;

    case 'thread/start':
      respond(msg.id!, {
        thread: { id: THREAD_ID },
        model: MODEL,
        approvalPolicy: msg.params?.approvalPolicy ?? 'never',
        cwd: msg.params?.cwd ?? '/tmp',
      });
      break;

    case 'thread/resume':
      if (scenario.failResume) {
        respondError(msg.id!, `no rollout found for thread id ${msg.params?.threadId}`);
      } else {
        respond(msg.id!, {
          thread: { id: msg.params?.threadId ?? THREAD_ID },
          model: MODEL,
        });
      }
      break;

    case 'turn/start':
      respond(msg.id!, { turn: { id: `mock-turn-${turnCounter + 1}`, items: [], status: 'inProgress' } });
      playTurn().catch((err) => debug(`playTurn failed: ${err}`));
      break;

    case 'turn/interrupt':
      respond(msg.id!, {});
      notify('turn/completed', { threadId: THREAD_ID, turn: { id: `mock-turn-${turnCounter}`, items: [], status: 'interrupted', error: null } });
      break;

    default:
      if (msg.id !== undefined) respond(msg.id, {});
      break;
  }
});

// Stay alive until killed (like the real app-server)
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
debug('mock-codex app-server ready');
