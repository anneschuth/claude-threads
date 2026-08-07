/**
 * Decision bridge: local IPC between the bot process and the per-session MCP
 * permission server.
 *
 * Why it exists: on modern Claude CLIs (verified 2.1.223), `ExitPlanMode` and
 * `AskUserQuestion` block on the `--permission-prompt-tool` — the MCP server
 * is the authoritative approval gate. But the rich UI (plan post with
 * approval reactions, question posts with numbered options) lives in the main
 * bot process, rendered from the tool_use event. Without a channel between
 * the two, users saw TWO competing prompts, and reacting on the bot's UI let
 * the MCP prompt time out into a deny.
 *
 * The bridge closes that gap: the bot listens on a per-session local socket;
 * the MCP server forwards plan/question permission requests over it and waits;
 * the bot resolves them from its existing reaction UI. Questions travel back
 * through the permission response's `updatedInput.answers` — the CLI then
 * tells Claude "Your questions have been answered" (verified empirically).
 *
 * Transport: newline-delimited JSON over a unix domain socket (a named pipe
 * on Windows). One request per connection.
 */

import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';

/** What the MCP server asks the bot to decide. */
export interface BridgeRequest {
  kind: 'plan_approval' | 'question';
  toolName: string;
  input: Record<string, unknown>;
}

/** The decision, in the permission-result shape the CLI understands. */
export interface BridgeResponse {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}

export type BridgeDecisionHandler = (req: BridgeRequest) => Promise<BridgeResponse>;

/** Build a platform-appropriate socket path for a new bridge. */
export function bridgeSocketPath(): string {
  const name = `claude-threads-bridge-${randomUUID()}`;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${name}`
    : join(tmpdir(), `${name}.sock`);
}

/**
 * Bot-side server. One per session; its `path` travels to the MCP child via
 * the DECISION_BRIDGE_PATH env var.
 */
export class DecisionBridgeServer {
  private constructor(
    private readonly server: Server,
    public readonly path: string
  ) {}

  static async create(handler: BridgeDecisionHandler): Promise<DecisionBridgeServer> {
    const path = bridgeSocketPath();
    const server = createServer((socket: Socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = '';
        let request: BridgeRequest;
        try {
          request = JSON.parse(line) as BridgeRequest;
        } catch {
          socket.end(JSON.stringify({ behavior: 'deny', message: 'Malformed bridge request' }) + '\n');
          return;
        }
        handler(request)
          .then((response) => {
            socket.end(JSON.stringify(response) + '\n');
          })
          .catch((err) => {
            socket.end(
              JSON.stringify({
                behavior: 'deny',
                message: `Bridge handler failed: ${err instanceof Error ? err.message : String(err)}`,
              }) + '\n'
            );
          });
      });
      // A dying MCP child mid-request: nothing to do, the handler's eventual
      // resolution writes into a closed socket, which is a no-op via 'error'.
      socket.on('error', () => {});
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    return new DecisionBridgeServer(server, path);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    // Unix sockets leave a filesystem entry behind; named pipes don't.
    if (process.platform !== 'win32') {
      await unlink(this.path).catch(() => {});
    }
  }
}

/**
 * MCP-side client. Connects, sends one request, waits for the decision.
 * Throws on connect failure or timeout — the caller falls back to its legacy
 * behavior (the bridge is an enhancement, never a hard dependency).
 */
export function requestBridgeDecision(
  path: string,
  request: BridgeRequest,
  timeoutMs: number
): Promise<BridgeResponse> {
  return new Promise<BridgeResponse>((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = '';
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };

    const timer = setTimeout(
      () => fail(new Error(`Bridge decision timed out after ${timeoutMs}ms`)),
      timeoutMs
    );

    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n');
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as BridgeResponse);
      } catch {
        reject(new Error('Malformed bridge response'));
      }
    });
    socket.on('error', (err) => fail(err));
    socket.on('close', () => fail(new Error('Bridge connection closed before a decision arrived')));
  });
}
