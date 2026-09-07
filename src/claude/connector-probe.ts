/**
 * claude.ai connector probe (#560).
 *
 * Sessions run with the account's claude.ai connectors disabled. An operator
 * who relied on them (an assistant-style bot with the account's Gmail or
 * Drive) sees nothing but a Claude that "has no such tool". The only way to
 * know whether an account has connectors at all is to ask the CLI: a
 * `claude -p "/usage"` run costs nothing (zero turns) and its system/init
 * event lists every MCP server the account brings, connectors included, as
 * `claude.ai <Name>`. This module runs that once per account at startup,
 * with the connectors deliberately left enabled for the probe itself.
 */
import { crossSpawn } from '../utils/spawn.js';
import { getClaudePath } from './version-check.js';
import { buildClaudeChildEnv, type ClaudeCliAccount } from './cli.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('connector-probe');

export const CONNECTOR_PREFIX = 'claude.ai ';
export const DEFAULT_CONNECTOR_PROBE_TIMEOUT_MS = 15_000;

/**
 * Connector names (prefix stripped, CLI order) from a stream-json stdout, or
 * null when no system/init event is in it. Pure.
 */
export function parseConnectorNames(stdout: string): string[] | null {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: { type?: string; subtype?: string; mcp_servers?: Array<{ name?: string }> };
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type !== 'system' || event.subtype !== 'init') continue;
    return (event.mcp_servers ?? [])
      .map((s) => s.name ?? '')
      .filter((name) => name.startsWith(CONNECTOR_PREFIX))
      .map((name) => name.slice(CONNECTOR_PREFIX.length));
  }
  return null;
}

/**
 * Ask the CLI which claude.ai connectors `account` (or, when undefined, the
 * bot's own environment) has. Resolves to null on any failure or timeout;
 * callers treat null as "unknown" and stay quiet.
 */
export async function probeClaudeAiConnectors(
  account?: ClaudeCliAccount,
  opts: { timeoutMs?: number } = {},
): Promise<string[] | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CONNECTOR_PROBE_TIMEOUT_MS;
  const label = account?.id ?? 'default account';
  const claudePath = getClaudePath();
  // The probe must see the connectors it is looking for.
  const env = buildClaudeChildEnv(process.env, account, { claudeAiConnectors: true });

  return new Promise<string[] | null>((resolve) => {
    let settled = false;
    let stdout = '';
    const finish = (value: string[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    let child: ReturnType<typeof crossSpawn>;
    try {
      child = crossSpawn(claudePath, ['-p', '/usage', '--output-format', 'stream-json', '--verbose'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      log.warn(`Connector probe for ${label} failed to spawn: ${err}`);
      resolve(null);
      return;
    }

    const timer = setTimeout(() => {
      log.debug(`Connector probe for ${label} timed out after ${timeoutMs}ms`);
      try { child.kill('SIGKILL'); } catch { /* best-effort */ }
      finish(parseConnectorNames(stdout));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      // The init event is the first line; nothing after it matters here.
      const names = parseConnectorNames(stdout);
      if (names !== null) {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        finish(names);
      }
    });
    child.stderr?.on('data', () => {}); // drain
    child.on('error', (err: Error) => {
      log.warn(`Connector probe for ${label} errored: ${err}`);
      finish(null);
    });
    child.on('close', () => finish(parseConnectorNames(stdout)));
  });
}
