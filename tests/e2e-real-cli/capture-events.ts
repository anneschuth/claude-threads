/**
 * Real-CLI event capture harness.
 *
 * Runs the REAL Claude CLI (stream-json in/out) through the flows the
 * integration mock has to imitate, and records every stdout event line —
 * verbatim, in order — to a JSONL file per flow. These captures are the
 * ground truth the mock CLI (tests/integration/fixtures/mock-claude/) is
 * written against: when the mock and a capture disagree, the capture wins.
 *
 * MANUAL tool — not run in CI (needs live credentials, spends tokens):
 *   bun run build   # flows that exercise the MCP server run from dist/
 *   bun tests/e2e-real-cli/capture-events.ts [flow ...]
 *
 * With no arguments every flow runs. Captures land in
 * tests/integration/fixtures/real-cli-captures/<flow>.jsonl with a `_meta`
 * first line recording the CLI version, args, prompts, and stdin script.
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DecisionBridgeServer } from '../../src/mcp/decision-bridge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPTURE_DIR = join(__dirname, '../integration/fixtures/real-cli-captures');
const WORK_DIR = '/tmp/claude-threads-capture-wd';
mkdirSync(CAPTURE_DIR, { recursive: true });
mkdirSync(WORK_DIR, { recursive: true });

const CLI_VERSION = execSync('claude --version', { encoding: 'utf8' }).trim();

interface StdinStep {
  /** Milliseconds to wait after the previous step (or a predicate below). */
  afterMs?: number;
  /** Wait until an emitted event satisfies this before sending. */
  afterEvent?: (ev: Record<string, unknown>) => boolean;
  /** The user message to send. */
  text: string;
}

interface Flow {
  name: string;
  description: string;
  args: string[];
  env?: Record<string, string>;
  steps: StdinStep[];
  /** End the run when this event arrives (default: n-th result event). */
  doneWhen?: (ev: Record<string, unknown>, resultCount: number) => boolean;
  /** Hard timeout for the whole flow. */
  timeoutMs?: number;
  /** Spin up a real DecisionBridgeServer + real dist MCP server. */
  withBridge?: boolean;
  /** Bridge handler behavior for plan/question requests. */
  bridgeDecide?: 'approve' | 'deny';
  /**
   * Send SIGINT this long after the first assistant event — captures what
   * the CLI emits when the bot interrupts (!escape sends SIGINT).
   */
  sigintAfterFirstAssistantMs?: number;
}

const BASE_ARGS = [
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--model', 'claude-haiku-4-5-20251001',
];

const userEvent = (text: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';

async function runFlow(flow: Flow): Promise<void> {
  console.log(`\n[capture] ▶ ${flow.name}: ${flow.description}`);

  let bridge: DecisionBridgeServer | null = null;
  let mcpArgs: string[] = [];
  if (flow.withBridge) {
    bridge = await DecisionBridgeServer.create(async (req) => {
      console.log(`[capture]   bridge request: ${req.kind} (${req.toolName})`);
      if (flow.bridgeDecide === 'deny') {
        return { behavior: 'deny', message: 'User denied via capture harness' };
      }
      if (req.kind === 'plan_approval') {
        return { behavior: 'allow', updatedInput: req.input };
      }
      const questions = (req.input.questions as Array<{ question: string; options?: Array<{ label: string }> }>) ?? [];
      const answers: Record<string, string> = {};
      for (const q of questions) answers[q.question] = q.options?.[0]?.label ?? 'first';
      return { behavior: 'allow', updatedInput: { ...req.input, answers } };
    });
    const mcpConfig = {
      mcpServers: {
        'claude-threads-mcp': {
          type: 'stdio',
          command: 'node',
          args: [join(__dirname, '../../dist/mcp/mcp-server.js')],
          env: {
            DECISION_BRIDGE_PATH: bridge.path,
            PLATFORM_TYPE: 'mattermost',
            PLATFORM_URL: '', PLATFORM_TOKEN: '', PLATFORM_CHANNEL_ID: '',
            ALLOWED_USERS: '', DEBUG: '',
          },
        },
      },
    };
    const cfgPath = join(WORK_DIR, `mcp-${flow.name}.json`);
    writeFileSync(cfgPath, JSON.stringify(mcpConfig));
    mcpArgs = [
      '--mcp-config', cfgPath,
      '--permission-prompt-tool', 'mcp__claude-threads-mcp__permission_prompt',
    ];
  }

  const args = [...BASE_ARGS, ...mcpArgs, ...flow.args];
  const events: string[] = [];
  const stderrLines: string[] = [];

  // Strip inherited session identity: without this every capture inherits
  // the harness session's CLAUDE_CODE_SESSION_ID and they all overwrite one
  // shared history file (discovered empirically — the resume capture replayed
  // a different flow's history).
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...flow.env };
  delete childEnv.CLAUDE_CODE_SESSION_ID;

  const proc: ChildProcess = spawn('claude', args, {
    cwd: WORK_DIR,
    env: childEnv,
  });

  let stdoutBuf = '';
  let resultCount = 0;
  let finished = false;
  const emitted: Array<Record<string, unknown>> = [];

  const finishPromise = new Promise<void>((resolve) => {
    const finish = () => { if (!finished) { finished = true; resolve(); } };

    proc.stdout!.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      let idx: number;
      while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line.trim()) continue;
        events.push(line);
        try {
          const ev = JSON.parse(line) as Record<string, unknown>;
          emitted.push(ev);
          if (ev.type === 'result') resultCount++;
          const done = flow.doneWhen
            ? flow.doneWhen(ev, resultCount)
            : resultCount >= flow.steps.length;
          if (done) finish();
        } catch { /* non-JSON line: keep raw */ }
      }
    });
    proc.stderr!.on('data', (c: Buffer) => stderrLines.push(c.toString('utf8')));
    proc.on('close', finish);
    setTimeout(finish, flow.timeoutMs ?? 180_000);

    if (flow.sigintAfterFirstAssistantMs !== undefined) {
      const t = setInterval(() => {
        if (emitted.some(ev => ev.type === 'assistant')) {
          clearInterval(t);
          setTimeout(() => {
            console.log('[capture]   → SIGINT');
            proc.kill('SIGINT');
          }, flow.sigintAfterFirstAssistantMs);
        }
      }, 100);
    }
  });

  // Drive stdin per the script
  (async () => {
    for (const step of flow.steps) {
      if (step.afterEvent) {
        const pred = step.afterEvent;
        await new Promise<void>((resolve) => {
          const check = () => {
            if (finished || emitted.some(pred)) { clearInterval(t); resolve(); }
          };
          const t = setInterval(check, 100);
          check();
        });
        // small settle so the CLI finishes its turn bookkeeping
        await new Promise(r => setTimeout(r, 500));
      } else if (step.afterMs) {
        await new Promise(r => setTimeout(r, step.afterMs));
      }
      if (finished) break;
      console.log(`[capture]   → stdin: ${step.text.slice(0, 60)}...`);
      proc.stdin!.write(userEvent(step.text));
    }
  })();

  await finishPromise;
  proc.kill('SIGKILL');
  await bridge?.close();

  const meta = {
    _meta: true,
    flow: flow.name,
    description: flow.description,
    cliVersion: CLI_VERSION,
    args,
    steps: flow.steps.map(s => s.text),
    capturedAt: 'see git log',
    eventCount: events.length,
  };
  const outPath = join(CAPTURE_DIR, `${flow.name}.jsonl`);
  writeFileSync(outPath, [JSON.stringify(meta), ...events].join('\n') + '\n');
  console.log(`[capture] ✔ ${flow.name}: ${events.length} events → ${outPath}`);
  if (events.length === 0) {
    console.log(`[capture]   stderr tail: ${stderrLines.join('').slice(-500)}`);
  }
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

const FLOWS: Flow[] = [
  {
    name: 'simple-text-multi-turn',
    description: 'Two text-only turns in ONE process — proves the CLI stays alive after result',
    args: ['--dangerously-skip-permissions'],
    steps: [
      { text: 'Reply with exactly: FIRST-TURN-DONE' },
      { afterEvent: (ev) => ev.type === 'result', text: 'Reply with exactly: SECOND-TURN-DONE' },
    ],
  },
  {
    name: 'tool-use-write',
    description: 'Write tool: tool_use block + tool_result inside a user event',
    args: ['--dangerously-skip-permissions'],
    steps: [
      { text: 'Write the single word hello to hello.txt using the Write tool, then reply exactly: WROTE-IT' },
    ],
  },
  {
    name: 'tool-use-error',
    description: 'A failing tool call: is_error tool_result shape',
    args: ['--dangerously-skip-permissions'],
    steps: [
      { text: 'Read the file /nonexistent/definitely-missing.txt with the Read tool (it does not exist — that is intentional, I want to see the error). Then reply exactly: SAW-ERROR' },
    ],
  },
  {
    name: 'tasks',
    description: 'TaskCreate/TaskUpdate incremental task tracking + result texts',
    args: ['--dangerously-skip-permissions'],
    steps: [
      { text: 'Create exactly two tasks with your task tools: "First demo task" and "Second demo task". Then mark the first one completed. Then reply exactly: TASKS-DONE. Do not do any other work.' },
    ],
  },
  {
    name: 'plan-approval-bridge',
    description: 'ExitPlanMode through the real MCP permission prompt + decision bridge (approved)',
    args: ['--permission-mode', 'plan'],
    withBridge: true,
    bridgeDecide: 'approve',
    steps: [
      { text: 'Plan how you would write the word hello to hello.txt, then call ExitPlanMode with your plan to request approval. After approval, stop without doing anything else and reply exactly: PLAN-FLOW-DONE' },
    ],
  },
  {
    name: 'plan-denied-bridge',
    description: 'ExitPlanMode denied via the bridge',
    args: ['--permission-mode', 'plan'],
    withBridge: true,
    bridgeDecide: 'deny',
    steps: [
      { text: 'Plan how you would write the word hello to hello.txt, then call ExitPlanMode with your plan. If the plan is rejected, reply exactly: PLAN-WAS-REJECTED and stop.' },
    ],
  },
  {
    name: 'question-bridge',
    description: 'AskUserQuestion answered through the bridge via updatedInput',
    args: [],
    withBridge: true,
    bridgeDecide: 'approve',
    steps: [
      { text: 'Use the AskUserQuestion tool to ask me whether I prefer red or blue (options labelled Red and Blue, in that order). Then reply exactly: ANSWER-WAS-<the answer>' },
    ],
  },
  {
    // NOTE: ordinary tools do NOT ride the decision bridge — the MCP server
    // posts a permission prompt to the chat platform and waits for a
    // reaction. This harness has no platform, so the server denies with
    // "Permission service not configured": what this flow captures is the
    // DENY shape of a gated ordinary tool. The approve path's post-approval
    // tool_result shape is covered by tool-use-write.jsonl (bypass) and by
    // the integration suite end-to-end (real platform + reactions).
    name: 'permission-write-denied',
    description: 'Ordinary Write gated through the MCP prompt with no platform configured — captures the deny shape',
    args: [],
    withBridge: true,
    bridgeDecide: 'approve',
    steps: [
      // Pin an absolute path outside any auto-allowed sandbox dir, or the
      // Write may never hit the permission gate at all.
      { text: 'Use the Write tool to write the single word hello to exactly this absolute path: /etc/claude-capture-test.txt — do not choose a different path. If the permission is denied, stop and reply exactly: WRITE-WAS-DENIED' },
    ],
    timeoutMs: 240_000,
  },
  {
    name: 'subagent',
    description: 'Task tool subagent: parent_tool_use_id sidechain events',
    args: ['--dangerously-skip-permissions'],
    steps: [
      { text: 'Use the Task tool to launch a subagent with this exact prompt: "Reply with the word SUBAGENT-HELLO and nothing else." Wait for it, then reply exactly: SUBAGENT-DONE' },
    ],
    timeoutMs: 240_000,
  },
  {
    name: 'error-max-turns',
    description: 'Error-shaped result event (via --max-turns 1 on a multi-step task)',
    args: ['--dangerously-skip-permissions', '--max-turns', '1'],
    steps: [
      { text: 'Write hello to a.txt, then read it back, then write its contents to b.txt. Use separate tool calls.' },
    ],
    timeoutMs: 120_000,
  },
  {
    name: 'plan-bypass',
    description: 'ExitPlanMode under --dangerously-skip-permissions: does the CLI gate or auto-approve?',
    args: ['--dangerously-skip-permissions'],
    steps: [
      { text: 'Call the ExitPlanMode tool with a short plan for writing hello to hello.txt. After that resolves, reply exactly: BYPASS-PLAN-DONE without doing anything else.' },
    ],
    timeoutMs: 120_000,
  },
  {
    name: 'question-bypass',
    description: 'AskUserQuestion availability under bypass (expected: tool absent, Claude reports it cannot ask)',
    args: ['--dangerously-skip-permissions'],
    steps: [
      { text: 'Use the AskUserQuestion tool to ask me whether I prefer red or blue. If the tool is not available to you, reply exactly: NO-QUESTION-TOOL' },
    ],
    timeoutMs: 120_000,
  },
  {
    name: 'interrupt',
    description: 'SIGINT mid-turn (what the bot sends on !escape) — captures the abort shape',
    args: ['--dangerously-skip-permissions'],
    steps: [
      { text: 'Count slowly from 1 to 50 using one Bash echo call per number.' },
    ],
    sigintAfterFirstAssistantMs: 3000,
    doneWhen: (_ev, resultCount) => resultCount >= 1,
    timeoutMs: 90_000,
  },
];

// Two-phase resume flow: run a seed turn with an explicit --session-id (the
// bot always passes one), kill the process, then relaunch with --resume and
// verify the CLI replays context. Captured as resume-seed.jsonl + resume.jsonl.
async function runResumeFlow(): Promise<void> {
  const sid = crypto.randomUUID();
  await runFlow({
    name: 'resume-seed',
    description: `Seed turn for the resume capture (--session-id ${sid})`,
    args: ['--dangerously-skip-permissions', '--session-id', sid],
    steps: [
      { text: 'Remember this codeword: PINEAPPLE-42. Reply exactly: SEEDED' },
    ],
  });
  await runFlow({
    name: 'resume',
    description: `Resumed session (--resume ${sid}) — CLI must recall prior context`,
    args: ['--dangerously-skip-permissions', '--resume', sid],
    steps: [
      { text: 'What was the codeword I gave you earlier? Reply with exactly the codeword.' },
    ],
  });
}

const wanted = process.argv.slice(2);
const toRun = wanted.length ? FLOWS.filter(f => wanted.includes(f.name)) : FLOWS;
// The resume pair is a two-phase flow (seed + resume) driven by
// runResumeFlow, not a FLOWS entry — selecting either name runs both.
const wantResume = !wanted.length || wanted.includes('resume') || wanted.includes('resume-seed');
if (toRun.length === 0 && !wantResume) {
  console.error(`No matching flows. Available: ${[...FLOWS.map(f => f.name), 'resume-seed', 'resume'].join(', ')}`);
  process.exit(1);
}

for (const flow of toRun) {
  try {
    await runFlow(flow);
  } catch (err) {
    console.error(`[capture] ✖ ${flow.name} failed:`, err);
  }
}
if (wantResume) {
  try {
    await runResumeFlow();
  } catch (err) {
    console.error('[capture] ✖ resume failed:', err);
  }
}
console.log('\n[capture] all done');
process.exit(0);
