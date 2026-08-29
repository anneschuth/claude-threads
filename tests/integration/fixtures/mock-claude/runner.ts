#!/usr/bin/env bun
/**
 * Mock Claude CLI for integration testing — MODERN DIALECT.
 *
 * Emits the event stream of a real Claude CLI (verified against 2.1.225;
 * reference captures live in ../real-cli-captures/*.jsonl — when this file
 * and a capture disagree, the capture wins):
 *
 * - `system`/`init` at session start (session_id from --session-id/--resume)
 * - a `rate_limit_event` after init, like the real CLI
 * - assistant events with the real message envelope (id/model/usage)
 * - tool results as `tool_result` blocks inside `user` events — the legacy
 *   top-level `{type:"tool_result"}` event is never emitted by modern CLIs
 * - task tracking via TaskCreate/TaskUpdate (never TodoWrite), with ids that
 *   only resolve through the "Task #N created successfully" result text
 * - one `result` event per turn, and the process STAYS ALIVE for the next
 *   user message (the real CLI is long-lived under stream-json input)
 * - ExitPlanMode / AskUserQuestion routed through the REAL MCP permission
 *   server from --mcp-config when --permission-prompt-tool is set: the mock
 *   speaks actual MCP (initialize + tools/call permission_prompt) so
 *   integration tests exercise the true permission-prompt → decision-bridge
 *   → reaction-UI path end to end
 * - on SIGINT: rejected tool_result + `error_during_execution` result with
 *   terminal_reason "aborted_streaming", then exit — the real CLI exits
 *   after SIGINT (verified empirically)
 *
 * Documented divergences (test conveniences, marked per scenario):
 * - `exitAtEnd: true` makes the process exit after the final turn's result.
 *   The real CLI only exits on stdin close or signal; suites that assert
 *   "session ended" after a one-shot response opt into this.
 * - Delays are compressed (MOCK_DELAY, default 100ms).
 *
 * Environment:
 *   CLAUDE_SCENARIO  - scenario name from ./scenarios/*.json (default: 'default')
 *   MOCK_DELAY       - base delay between events in ms (default: 100)
 *   DEBUG / INTEGRATION_TEST - stderr logging (tests assert on these lines)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = join(__dirname, 'scenarios');

/** Version reported for --version; inside the verified range. */
const MOCK_CLI_VERSION = '2.1.251';

// ============================================================================
// Argv — the bot passes these; parse what shapes the event stream
// ============================================================================

interface CliArgs {
  sessionId: string;
  resumed: boolean;
  bypassPermissions: boolean;
  permissionPromptTool: string | null;
  permissionMode: string | null;
  mcpConfigRaw: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    sessionId: randomUUID(),
    resumed: false,
    bypassPermissions: false,
    permissionPromptTool: null,
    permissionMode: null,
    mcpConfigRaw: null,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--session-id': args.sessionId = argv[++i]; break;
      case '--resume': args.sessionId = argv[++i]; args.resumed = true; break;
      case '--dangerously-skip-permissions': args.bypassPermissions = true; break;
      case '--permission-prompt-tool': args.permissionPromptTool = argv[++i]; break;
      case '--permission-mode': args.permissionMode = argv[++i]; break;
      case '--mcp-config': args.mcpConfigRaw = argv[++i]; break;
      // Flags with a value we ignore:
      case '--append-system-prompt': case '--settings':
      case '--input-format': case '--output-format': case '--model':
        i++; break;
      default: break; // --verbose, --chrome, unknown flags
    }
  }
  return args;
}

// --version must answer fast: the bot's sticky message shells out to it.
if (process.argv.includes('--version')) {
  console.log(`${MOCK_CLI_VERSION} (Claude Code)`);
  process.exit(0);
}

// -p (print mode): quickQuery spawns `claude -p --model haiku` for one-shot
// asks (watch match confirms, distillation, NL parses) with the prompt on
// stdin. Answer deterministically so those paths are testable end to end;
// unknown prompts get a bare OK (callers treat unusable output as a no-op).
if (process.argv.includes('-p')) {
  const prompt = await new Promise<string>((resolve) => {
    let buf = '';
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
    setTimeout(() => resolve(buf), 5000).unref();
  });
  if (prompt.includes('Trigger condition:')) {
    // Watch confirm — MOCK_WATCH_CONFIRM=false simulates a semantic no-match.
    const match = process.env.MOCK_WATCH_CONFIRM !== 'false';
    console.log(JSON.stringify({ match, reason: 'mock confirm' }));
  } else {
    console.log('OK');
  }
  process.exit(0);
}

const ARGS = parseArgs(process.argv.slice(2));

// ============================================================================
// Logging (tests assert on these stderr lines — keep the formats)
// ============================================================================

const MOCK_ALWAYS_LOG = process.env.INTEGRATION_TEST === '1' || process.env.DEBUG === '1';

function log(message: string): void {
  if (MOCK_ALWAYS_LOG) {
    console.error(`[mock-claude pid=${process.pid}] ${message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BASE_DELAY = parseInt(process.env.MOCK_DELAY || '100', 10);

// ============================================================================
// Persistent per-session state (supports --resume across mock restarts)
// ============================================================================

interface SessionState {
  turnIndex: number;
  taskCounter: number;
  tasks: Record<string, { id: string; subject: string; status: string }>;
}

const STATE_DIR = join(tmpdir(), 'mock-claude-state');
const statePath = () => join(STATE_DIR, `${ARGS.sessionId}.json`);

function loadState(): SessionState {
  if (ARGS.resumed && existsSync(statePath())) {
    try {
      return JSON.parse(readFileSync(statePath(), 'utf-8')) as SessionState;
    } catch { /* fresh state below */ }
  }
  return { turnIndex: 0, taskCounter: 0, tasks: {} };
}

function saveState(state: SessionState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(statePath(), JSON.stringify(state));
}

const STATE = loadState();

// ============================================================================
// Modern-dialect event emitters (shapes from ../real-cli-captures/)
// ============================================================================

function emit(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + '\n');
  log(`Emitted: ${event.type}${event.subtype ? '/' + event.subtype : ''}`);
}

const sid = () => ARGS.sessionId;

function emitInit(): void {
  const interactiveTools = ARGS.bypassPermissions ? [] : ['ExitPlanMode', 'AskUserQuestion'];
  emit({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    session_id: sid(),
    tools: [
      'Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'NotebookEdit',
      'WebFetch', 'WebSearch', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
      ...interactiveTools,
    ],
    mcp_servers: ARGS.mcpConfigRaw ? [{ name: 'claude-threads-mcp', status: 'connected' }] : [],
    model: 'claude-haiku-4-5-20251001',
    permissionMode: ARGS.bypassPermissions
      ? 'bypassPermissions'
      : (ARGS.permissionMode ?? 'default'),
    // Subset of the real init list (54 entries on 2.1.226) — must include
    // model/effort: the bot's dynamic passthrough gates !model/!effort on
    // their presence here.
    slash_commands: ['compact', 'context', 'cost', 'effort', 'init', 'model', 'pr-comments', 'release-notes', 'todos', 'review'],
    apiKeySource: 'none',
    claude_code_version: MOCK_CLI_VERSION,
    output_style: 'default',
    agents: ['general-purpose', 'statusline-setup', 'Explore', 'Plan'],
    skills: [],
    plugins: [],
    uuid: randomUUID(),
  });
}

function emitRateLimit(): void {
  emit({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed',
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
      rateLimitType: 'five_hour',
      overageStatus: 'allowed',
      isUsingOverage: false,
    },
    uuid: randomUUID(),
    session_id: sid(),
  });
}

interface ContentBlock { [key: string]: unknown }

function emitAssistant(content: ContentBlock[]): void {
  emit({
    type: 'assistant',
    message: {
      model: 'claude-haiku-4-5-20251001',
      id: `msg_mock_${randomUUID().slice(0, 12)}`,
      type: 'message',
      role: 'assistant',
      content,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1000,
        output_tokens: 25,
        service_tier: 'standard',
      },
    },
    parent_tool_use_id: null,
    session_id: sid(),
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  });
}

function emitToolResult(toolUseId: string, content: string, isError = false): void {
  const block: ContentBlock = { tool_use_id: toolUseId, type: 'tool_result', content };
  if (isError) block.is_error = true;
  emit({
    type: 'user',
    message: { role: 'user', content: [block] },
    parent_tool_use_id: null,
    session_id: sid(),
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  });
}

function emitResult(opts: {
  isError?: boolean;
  subtype?: string;
  resultText?: string;
  terminalReason?: string;
  stopReason?: string;
  numTurns?: number;
} = {}): void {
  emit({
    type: 'result',
    subtype: opts.subtype ?? (opts.isError ? 'error_during_execution' : 'success'),
    is_error: opts.isError ?? false,
    duration_ms: 1500,
    duration_api_ms: 1200,
    num_turns: opts.numTurns ?? 1,
    // Error results in the real captures never carry end_turn/completed —
    // scenario steps override these (see error-response.json).
    stop_reason: opts.stopReason ?? 'end_turn',
    result: opts.resultText ?? '',
    session_id: sid(),
    total_cost_usd: 0.0015,
    usage: {
      input_tokens: 12,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 2000,
      output_tokens: 40,
      service_tier: 'standard',
    },
    modelUsage: {
      'claude-haiku-4-5-20251001': {
        inputTokens: 112, outputTokens: 40,
        cacheReadInputTokens: 2000, cacheCreationInputTokens: 100,
        webSearchRequests: 0, costUSD: 0.0015, contextWindow: 200000,
      },
    },
    permission_denials: [],
    terminal_reason: opts.terminalReason ?? 'completed',
    uuid: randomUUID(),
  });
}

// ============================================================================
// Minimal MCP client — drives the REAL mcp-server.js from --mcp-config
// ============================================================================

interface McpServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

class McpPermissionClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, (msg: Record<string, unknown>) => void>();
  private buffer = '';
  private initialized: Promise<void> | null = null;

  constructor(private readonly spec: McpServerSpec) {}

  private ensureStarted(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = (async () => {
      log(`Spawning MCP server: ${this.spec.command} ${(this.spec.args ?? []).join(' ')}`);
      this.proc = spawn(this.spec.command, this.spec.args ?? [], {
        env: { ...process.env, ...this.spec.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.proc.stderr?.on('data', (c: Buffer) => log(`[mcp-server] ${c.toString().trim()}`));
      this.proc.stdout?.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString('utf8');
        let idx: number;
        while ((idx = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, idx);
          this.buffer = this.buffer.slice(idx + 1);
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as Record<string, unknown>;
            const id = msg.id as number | undefined;
            if (id !== undefined && this.pending.has(id)) {
              this.pending.get(id)!(msg);
              this.pending.delete(id);
            }
          } catch { /* ignore non-JSON */ }
        }
      });
      await this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mock-claude', version: MOCK_CLI_VERSION },
      });
      this.notify('notifications/initialized', {});
    })();
    return this.initialized;
  }

  private rejecters = new Map<number, (err: Error) => void>();

  private request(method: string, params: unknown, timeoutMs = 3_600_000): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.rejecters.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        this.rejecters.delete(id);
        resolve(msg);
      });
      this.rejecters.set(id, (err) => {
        clearTimeout(timer);
        this.pending.delete(id);
        this.rejecters.delete(id);
        reject(err);
      });
      this.proc!.stdin!.write(payload);
    });
  }

  /**
   * Reject every pending request immediately. SIGINT must be able to abort
   * a permission wait that would otherwise park for MCP_TOOL_TIMEOUT (an
   * hour under the bot) — the real CLI aborts and exits on SIGINT even with
   * a permission prompt outstanding.
   */
  abortAll(reason: string): void {
    for (const reject of [...this.rejecters.values()]) {
      reject(new Error(reason));
    }
  }

  private notify(method: string, params: unknown): void {
    this.proc!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  /** Eagerly spawn + initialize the server (real CLIs connect at startup). */
  warmUp(): Promise<void> {
    return this.ensureStarted();
  }

  /**
   * Call permission_prompt like the real CLI does. Returns the parsed
   * PermissionResult ({behavior:'allow'|'deny', updatedInput?, message?}).
   * MCP_TOOL_TIMEOUT caps the wait, matching the real CLI contract.
   */
  async requestPermission(toolName: string, input: Record<string, unknown>): Promise<{ behavior: string; updatedInput?: Record<string, unknown>; message?: string }> {
    await this.ensureStarted();
    const timeoutMs = parseInt(process.env.MCP_TOOL_TIMEOUT || '120000', 10);
    log(`Requesting permission for ${toolName} via MCP`);
    const resp = await this.request('tools/call', {
      name: 'permission_prompt',
      arguments: { tool_name: toolName, input },
    }, timeoutMs);
    const result = resp.result as { content?: Array<{ type: string; text?: string }> } | undefined;
    const text = result?.content?.find((c) => c.type === 'text')?.text ?? '{"behavior":"deny","message":"empty MCP response"}';
    try {
      return JSON.parse(text) as { behavior: string; updatedInput?: Record<string, unknown>; message?: string };
    } catch {
      return { behavior: 'deny', message: `Unparseable permission response: ${text.slice(0, 100)}` };
    }
  }

  close(): void {
    this.proc?.kill('SIGTERM');
  }
}

function loadMcpClient(): McpPermissionClient | null {
  if (!ARGS.mcpConfigRaw || !ARGS.permissionPromptTool) return null;
  try {
    const raw = ARGS.mcpConfigRaw.trim().startsWith('{')
      ? ARGS.mcpConfigRaw
      : readFileSync(ARGS.mcpConfigRaw, 'utf-8');
    const cfg = JSON.parse(raw) as { mcpServers?: Record<string, McpServerSpec> };
    const spec = cfg.mcpServers?.['claude-threads-mcp'];
    if (!spec) return null;
    return new McpPermissionClient(spec);
  } catch (err) {
    log(`Failed to load --mcp-config: ${err}`);
    return null;
  }
}

const mcpClient = loadMcpClient();

// ============================================================================
// Scenario schema v2 — turn-based steps rendered into modern events
// ============================================================================

type Step =
  | { kind: 'text'; text: string; delay?: number }
  | { kind: 'tool'; name: string; input: Record<string, unknown>; result?: string; isError?: boolean; delay?: number }
  | { kind: 'task-create'; subject: string; delay?: number }
  | { kind: 'task-update'; subject: string; status: 'in_progress' | 'completed' | 'deleted'; delay?: number }
  | { kind: 'plan'; plan: string; delay?: number }
  | { kind: 'question'; questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }>; delay?: number }
  | { kind: 'result'; isError?: boolean; subtype?: string; resultText?: string; terminalReason?: string; stopReason?: string; delay?: number }
  | { kind: 'raw'; event: Record<string, unknown>; delay?: number };

interface Turn {
  /** Steps played for this user message. */
  steps: Step[];
}

interface ScenarioV2 {
  name: string;
  description?: string;
  /**
   * Turns are consumed in order per user message; when they run out the
   * last turn repeats (set repeatLastTurn: false to fall back to a plain
   * acknowledgement instead).
   */
  turns: Turn[];
  repeatLastTurn?: boolean;
  /**
   * TEST CONVENIENCE (divergence from the real CLI, which only exits on
   * stdin close/signal): exit the process after the final turn's result.
   * Suites asserting "session ended after the response" opt in.
   */
  exitAtEnd?: boolean;
}

const fallbackTurn: Turn = {
  steps: [
    { kind: 'text', text: 'Acknowledged. (mock fallback turn)' },
    { kind: 'result' },
  ],
};

const defaultScenario: ScenarioV2 = {
  name: 'default',
  description: 'Simple echo response',
  turns: [{
    steps: [
      { kind: 'text', text: 'Hello! I received your message. This is a mock response for testing.' },
      { kind: 'result' },
    ],
  }],
};

function loadScenario(name: string): ScenarioV2 {
  const scenarioPath = join(SCENARIOS_DIR, `${name}.json`);
  if (!existsSync(scenarioPath)) {
    if (name !== 'default') log(`Scenario '${name}' not found, using default`);
    return defaultScenario;
  }
  try {
    const parsed = JSON.parse(readFileSync(scenarioPath, 'utf-8')) as ScenarioV2;
    if (!Array.isArray(parsed.turns)) {
      log(`Scenario '${name}' has no turns[] — modern scenarios are turn-based. Using default.`);
      return defaultScenario;
    }
    return parsed;
  } catch (error) {
    log(`Error loading scenario '${name}': ${error}`);
    return defaultScenario;
  }
}

// ============================================================================
// Step interpreter
// ============================================================================

/** Tool uses currently in flight — SIGINT rejects them like the real CLI. */
const inFlightToolUses: Array<{ id: string; name: string }> = [];
let interrupted = false;

async function stepDelay(step: { delay?: number }): Promise<void> {
  await sleep(step.delay ?? BASE_DELAY);
}

async function gatedToolFlow(
  toolName: string,
  input: Record<string, unknown>,
  onAllow: (updatedInput?: Record<string, unknown>) => Promise<void>,
  onDeny: (message?: string) => Promise<void>,
): Promise<void> {
  if (ARGS.bypassPermissions || !mcpClient) {
    await onAllow();
    return;
  }
  try {
    const decision = await mcpClient.requestPermission(toolName, input);
    if (decision.behavior === 'allow') {
      await onAllow(decision.updatedInput);
    } else {
      await onDeny(decision.message);
    }
  } catch (err) {
    log(`Permission request failed (${err}) — denying like the real CLI`);
    await onDeny(String(err));
  }
}

async function playStep(step: Step, state: SessionState): Promise<'continue' | 'stop'> {
  if (interrupted) return 'stop';
  await stepDelay(step);
  if (interrupted) return 'stop';

  switch (step.kind) {
    case 'text': {
      emitAssistant([{ type: 'text', text: step.text }]);
      return 'continue';
    }

    case 'tool': {
      const id = `toolu_mock_${randomUUID().slice(0, 12)}`;
      emitAssistant([{ type: 'tool_use', id, name: step.name, input: step.input }]);
      inFlightToolUses.push({ id, name: step.name });
      await gatedToolFlow(step.name, step.input, async () => {
        await sleep(BASE_DELAY);
        emitToolResult(id, step.result ?? `${step.name} completed`, step.isError ?? false);
      }, async (message) => {
        await sleep(BASE_DELAY);
        emitToolResult(id, message ?? "The user doesn't want to proceed with this tool use.", true);
      });
      inFlightToolUses.pop();
      return 'continue';
    }

    case 'task-create': {
      const id = `toolu_mock_${randomUUID().slice(0, 12)}`;
      state.taskCounter++;
      const taskId = String(state.taskCounter);
      state.tasks[step.subject] = { id: taskId, subject: step.subject, status: 'pending' };
      emitAssistant([{ type: 'tool_use', id, name: 'TaskCreate', input: { subject: step.subject, description: step.subject } }]);
      await sleep(BASE_DELAY);
      // Id resolution happens ONLY through this result text (task-tracker.ts)
      emitToolResult(id, `Task #${taskId} created successfully: ${step.subject}`);
      saveState(state);
      return 'continue';
    }

    case 'task-update': {
      const task = state.tasks[step.subject];
      const taskId = task?.id ?? '999';
      if (task) task.status = step.status;
      const id = `toolu_mock_${randomUUID().slice(0, 12)}`;
      emitAssistant([{ type: 'tool_use', id, name: 'TaskUpdate', input: { taskId, status: step.status } }]);
      await sleep(BASE_DELAY);
      emitToolResult(id, step.status === 'deleted' ? `Updated task #${taskId} deleted` : `Updated task #${taskId} status`);
      saveState(state);
      return 'continue';
    }

    case 'plan': {
      // Real bypass CLIs don't even expose ExitPlanMode — a scenario using
      // it under bypass is unfaithful; warn loudly but still emit.
      if (ARGS.bypassPermissions) {
        log('WARNING: plan step under --dangerously-skip-permissions — real CLIs have no ExitPlanMode tool in bypass');
      }
      const id = `toolu_mock_${randomUUID().slice(0, 12)}`;
      emitAssistant([{ type: 'tool_use', id, name: 'ExitPlanMode', input: { plan: step.plan } }]);
      await gatedToolFlow('ExitPlanMode', { plan: step.plan }, async () => {
        await sleep(BASE_DELAY);
        emitToolResult(id, 'User has approved your plan. You can now start coding. Start with updating your todo list if applicable');
      }, async (message) => {
        await sleep(BASE_DELAY);
        // The real CLI surfaces the deny message verbatim as the tool
        // result content (see plan-denied-bridge.jsonl).
        emitToolResult(id, message ?? "The user doesn't want to proceed with this tool use. The plan was rejected.", true);
      });
      return 'continue';
    }

    case 'question': {
      if (ARGS.bypassPermissions) {
        log('WARNING: question step under --dangerously-skip-permissions — real CLIs have no AskUserQuestion tool in bypass');
      }
      const id = `toolu_mock_${randomUUID().slice(0, 12)}`;
      const input = { questions: step.questions };
      emitAssistant([{ type: 'tool_use', id, name: 'AskUserQuestion', input }]);
      await gatedToolFlow('AskUserQuestion', input, async (updatedInput) => {
        await sleep(BASE_DELAY);
        const answers = (updatedInput?.answers ?? {}) as Record<string, string>;
        const answerText = Object.entries(answers)
          .map(([q, a]) => `"${q}"="${a}"`)
          .join(', ');
        emitToolResult(id, `Your questions have been answered: ${answerText}. You can now continue with these answers in mind.`);
      }, async () => {
        await sleep(BASE_DELAY);
        emitToolResult(id, 'User did not answer the questions.', true);
      });
      return 'continue';
    }

    case 'result': {
      emitResult({
        isError: step.isError,
        subtype: step.subtype,
        resultText: step.resultText,
        terminalReason: step.terminalReason,
        stopReason: step.stopReason,
      });
      return 'continue';
    }

    case 'raw': {
      emit(step.event);
      return 'continue';
    }
  }
}

// ============================================================================
// Turn loop
// ============================================================================

const scenario = loadScenario(process.env.CLAUDE_SCENARIO || 'default');
let playing = false;
let turnsPlayedThisProcess = 0;

async function playTurn(state: SessionState): Promise<void> {
  const idx = state.turnIndex;
  let turn: Turn | undefined = scenario.turns[idx];
  if (!turn) {
    turn = scenario.repeatLastTurn === false
      ? fallbackTurn
      : scenario.turns[scenario.turns.length - 1] ?? fallbackTurn;
  }
  // The real CLI re-emits system/init at the start of every turn after the
  // first IN THIS PROCESS (see simple-text-multi-turn.jsonl; a resumed CLI's
  // first turn emits exactly one init — resume.jsonl). Startup already
  // emitted one, so gate on process-local turns, not the persisted index.
  if (turnsPlayedThisProcess > 0) emitInit();
  turnsPlayedThisProcess++;
  state.turnIndex = idx + 1;
  saveState(state);

  playing = true;
  for (const step of turn.steps) {
    const outcome = await playStep(step, state);
    if (outcome === 'stop' || interrupted) break;
  }
  playing = false;

  if (interrupted) {
    // Reject any in-flight tool use like the real CLI, then abort the turn.
    for (const t of inFlightToolUses.splice(0)) {
      emitToolResult(t.id, "The user doesn't want to proceed with this tool use. The tool use was rejected.", true);
    }
    emitResult({ isError: true, subtype: 'error_during_execution', terminalReason: 'aborted_streaming' });
    log('Interrupted — exiting like the real CLI after SIGINT');
    process.exit(0);
  }

  const wasLastTurn = state.turnIndex >= scenario.turns.length;
  if (scenario.exitAtEnd && wasLastTurn) {
    log('exitAtEnd: final turn complete, exiting (test convenience — real CLI stays alive)');
    process.exit(0);
  }
}

async function main(): Promise<void> {
  log(`Starting mock Claude CLI (modern dialect) scenario=${scenario.name} session=${ARGS.sessionId} resumed=${ARGS.resumed} bypass=${ARGS.bypassPermissions}`);

  // The real CLI blocks startup on --mcp-config server connects (capped by
  // MCP_CONNECTION_NONBLOCKING at 5s), so a permission call goes out
  // milliseconds after its tool_use event. Do the same: without this, a
  // gated tool_use is emitted while the server is still cold-starting, and
  // the user's reaction beats the bridge request to the bot — it then
  // resolves via the stdin fallback and the real bridge request parks
  // forever (observed as a race in suite runs).
  if (mcpClient) {
    const cap = new Promise<void>((r) => setTimeout(r, 5000));
    await Promise.race([
      mcpClient.warmUp().catch((err) => log(`MCP warm-up failed: ${err}`)),
      cap,
    ]);
  }

  emitInit();
  emitRateLimit();

  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line) => {
    try {
      const input = JSON.parse(line);
      log(`Received input type: ${input.type}`);
      if (input.type !== 'user') return;

      const message = input.message;
      let content = '';
      if (typeof message === 'string') {
        content = message;
      } else if (typeof message?.content === 'string') {
        content = message.content;
      } else if (Array.isArray(message?.content)) {
        content = message.content
          .filter((b: { type: string }) => b.type === 'text')
          .map((b: { text?: string }) => b.text || '')
          .join('\n');
      }
      // Tests assert on this exact stderr line — keep the format.
      log(`Received user message: ${content.substring(0, 50)}...`);

      if (playing) {
        // Real CLI queues user input arriving mid-turn; the mock just notes it.
        log('Turn in progress — input noted (mock does not queue)');
        return;
      }
      await playTurn(STATE);
    } catch (error) {
      log(`Error processing input: ${error}`);
    }
  });

  rl.on('close', () => {
    log('stdin closed, exiting');
    mcpClient?.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    log('Received SIGTERM, exiting');
    mcpClient?.close();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    log('Received SIGINT');
    if (playing) {
      // Abort the in-flight turn: playTurn emits the abort shape and exits.
      // A step may be parked inside an MCP permission wait (up to
      // MCP_TOOL_TIMEOUT — an hour under the bot), so reject those pending
      // calls too; the deny path runs, then the turn loop sees `interrupted`.
      interrupted = true;
      mcpClient?.abortAll('Interrupted by SIGINT');
    } else {
      // Idle: the real CLI exits promptly.
      mcpClient?.close();
      process.exit(0);
    }
  });
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { loadScenario, parseArgs, type ScenarioV2, type Step, type Turn };
