/**
 * MANUAL end-to-end verification of the decision bridge against the REAL
 * Claude CLI. NOT run in CI: it needs live Claude credentials, spends real
 * tokens, and is nondeterministic.
 *
 * Usage:
 *   bun run build                      # the MCP server runs from dist/
 *   bun tests/e2e-real-cli/decision-bridge-e2e.ts
 *
 * Verifies with a real CLI + the real built mcp-server.js + a real
 * DecisionBridgeServer:
 *  1. ExitPlanMode routes through the bridge; approving it makes the CLI tell
 *     Claude "User has approved your plan".
 *  2. AskUserQuestion routes through the bridge; the bot-side answers arrive
 *     back in Claude's context via updatedInput.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { DecisionBridgeServer, type BridgeRequest } from '../../src/mcp/decision-bridge.js';

const dir = '/tmp/claude-threads-bridge-e2e';
mkdirSync(`${dir}/e2e-wd`, { recursive: true });

// Optional: DECISION_DELAY_MS holds the decision to verify the CLI tolerates
// a long-pending bridge request (users answer plans on their own schedule).
const parsedDelay = parseInt(process.env.DECISION_DELAY_MS || '0', 10);
const decisionDelayMs = Number.isFinite(parsedDelay) ? parsedDelay : 0;

const seen: BridgeRequest[] = [];
const bridge = await DecisionBridgeServer.create(async (req) => {
  seen.push(req);
  console.log(`[bridge] request: ${req.kind} (${req.toolName})${decisionDelayMs ? `, deciding in ${decisionDelayMs}ms` : ''}`);
  if (decisionDelayMs) await new Promise(r => setTimeout(r, decisionDelayMs));
  if (req.kind === 'plan_approval') {
    return { behavior: 'allow', updatedInput: req.input };
  }
  // question: pick the FIRST option of each question, like a user reacting 1️⃣
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
      args: [new URL('../../dist/mcp/mcp-server.js', import.meta.url).pathname],
      env: {
        DECISION_BRIDGE_PATH: bridge.path,
        PLATFORM_TYPE: 'mattermost',
        PLATFORM_URL: '',
        PLATFORM_TOKEN: '',
        PLATFORM_CHANNEL_ID: '',
        ALLOWED_USERS: '',
        DEBUG: '',
      },
    },
  },
};
writeFileSync(`${dir}/e2e-mcp-config.json`, JSON.stringify(mcpConfig));

function runClaude(extraArgs: string[], prompt: string): Promise<string> {
  // MUST be async: the bridge server lives in THIS process — a synchronous
  // spawn would block the event loop and the bridge could never answer.
  return new Promise((resolve) => {
    const proc = spawn('claude', [
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--mcp-config', `${dir}/e2e-mcp-config.json`,
      '--permission-prompt-tool', 'mcp__claude-threads-mcp__permission_prompt',
      '--model', 'claude-haiku-4-5-20251001',
      ...extraArgs,
    ], { cwd: `${dir}/e2e-wd` });
    let out = '';
    proc.stdout.on('data', (c) => { out += c.toString(); });
    proc.stderr.on('data', () => {});
    const timer = setTimeout(() => proc.kill('SIGKILL'), 120_000 + decisionDelayMs);
    proc.on('close', () => { clearTimeout(timer); resolve(out); });
    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
    // Leave stdin open briefly so the turn completes, then end it
    setTimeout(() => proc.stdin.end(), 100_000 + decisionDelayMs);
  });
}

// --- Scenario 1: plan approval through the bridge ---
console.log('[e2e] scenario 1: plan approval');
const planOut = await runClaude(
  ['--permission-mode', 'plan'],
  'Plan how you would write the word hello to hello.txt, then call ExitPlanMode with your plan to request approval. After approval, stop without doing anything else and reply exactly: PLAN-FLOW-DONE'
);
const planApproved = planOut.includes('User has approved your plan');
const planViaBridge = seen.some(r => r.kind === 'plan_approval');

// --- Scenario 2: question answers through the bridge ---
console.log('[e2e] scenario 2: question answers');
const qOut = await runClaude(
  [],
  'Use the AskUserQuestion tool to ask me whether I prefer red or blue (options labelled Red and Blue, in that order). Then reply exactly: ANSWER-WAS-<the answer>'
);
const questionViaBridge = seen.some(r => r.kind === 'question');
const answered = qOut.includes('Your questions have been answered') && qOut.includes('ANSWER-WAS-Red');

await bridge.close();

const checks: Array<[string, boolean]> = [
  ['plan request reached the bridge', planViaBridge],
  ['CLI reported "User has approved your plan"', planApproved],
  ['question request reached the bridge', questionViaBridge],
  ['answers delivered via updatedInput (ANSWER-WAS-Red)', answered],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (!ok) failed++;
}
if (failed) {
  console.log('--- plan run tail:', planOut.slice(-600));
  console.log('--- question run tail:', qOut.slice(-600));
}
process.exit(failed ? 1 : 0);
