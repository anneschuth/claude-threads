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
 * on Windows). One request per connection. The socket lives in a fresh 0700
 * directory so other local users can't connect regardless of umask, and the
 * short name keeps the path well under the 104-byte `sun_path` limit on
 * macOS (an over-long path binds truncated, and cleanup then misses it).
 */

import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';

/** What the MCP server asks the bot to decide. */
export interface BridgeRequest {
  kind: 'plan_approval' | 'question';
  toolName: string;
  input: Record<string, unknown>;
}

/**
 * Agent-initiated feature actions (remember_fact, propose_routine, …): the
 * MCP child has no access to the bot's stores — the stores, their mutexes
 * and their caps all live in the bot process — so the tool call travels
 * over the bridge and is executed bot-side. Same wire, new shape: the
 * transport is shape-agnostic (one JSON line per connection either way).
 */
export type AgentAction =
  | 'remember_fact'
  | 'list_memory'
  | 'propose_routine'
  | 'propose_watch'
  | 'list_routines'
  | 'list_watches';

export interface AgentActionRequest {
  kind: 'agent_action';
  action: AgentAction;
  input: Record<string, unknown>;
}

/**
 * Result of a bot-side agent action, serialized back as the MCP tool
 * result. `reason` is user-facing wording the model can act on.
 */
export interface AgentActionResponse {
  ok: boolean;
  result?: unknown;
  reason?: string;
}

/** The decision, in the permission-result shape the CLI understands. */
export interface BridgeResponse {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}

/**
 * Thrown by a handler to signal "this bridge can't decide right now" WITHOUT
 * producing a deny: the server then drops the connection with no response, the
 * client rejects, and the MCP server falls back to its legacy prompts. A
 * regular deny would be final — no fallback.
 */
export class BridgeUnavailableError extends Error {}

/**
 * Decision handler. `signal` aborts when the requesting client disconnected
 * before a decision was made (its timeout fired, the CLI cancelled the tool
 * call, or the MCP child died). Handlers that park state waiting for a user
 * reaction MUST clear it on abort — a stale pending would otherwise swallow
 * the next real decision instead of letting it fall back to stdin.
 */
export type BridgeDecisionHandler = (
  req: BridgeRequest | AgentActionRequest,
  signal: AbortSignal
) => Promise<BridgeResponse | AgentActionResponse>;

/**
 * Upper bound on one request line the bridge server buffers. The largest
 * legitimate request (a propose_* with maxed-out fields) is a few KB; 1 MB
 * leaves generous headroom while bounding what a misbehaving client can
 * make the bot hold in memory.
 */
export const MAX_BRIDGE_LINE_LENGTH = 1024 * 1024;

/** Build a platform-appropriate socket path for a new bridge. */
export function bridgeSocketPath(): string {
  if (process.platform === 'win32') {
    // Named pipes: no filesystem entry; default DACL already denies other
    // users; no length concerns.
    return `\\\\.\\pipe\\ctb-${randomUUID()}`;
  }
  // Fresh 0700 directory (mkdtemp guarantees the mode) + short socket name.
  // The 0700 mode shuts out other users, not other sessions: every session's
  // bridge runs under the bot's own UID, so a session that can run arbitrary
  // local processes could reach a sibling session's socket. That is the same
  // trust boundary as the memory/store files themselves (same UID, same
  // reach), so the real containment for untrusted sessions stays the CLI
  // permission mode — not this path.
  const dir = mkdtempSync(join(tmpdir(), 'ctb-'));
  return join(dir, 'b.sock');
}

/**
 * Bot-side server. One per session; its `path` travels to the MCP child via
 * the DECISION_BRIDGE_PATH env var.
 */
export class DecisionBridgeServer {
  private liveSockets: Set<Socket> = new Set();

  private constructor(
    private readonly server: Server,
    public readonly path: string
  ) {}

  static async create(handler: BridgeDecisionHandler): Promise<DecisionBridgeServer> {
    const path = bridgeSocketPath();
    const liveSockets = new Set<Socket>();
    const server = createServer((socket: Socket) => {
      liveSockets.add(socket);
      socket.once('close', () => liveSockets.delete(socket));
      let buffer = '';
      const aborter = new AbortController();
      let responded = false;
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        // A legitimate request is a small JSON line; cap the buffer so a
        // newline-less stream can't grow the bot's RSS without bound.
        if (buffer.length > MAX_BRIDGE_LINE_LENGTH) {
          responded = true;
          socket.destroy();
          return;
        }
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = '';
        let request: BridgeRequest | AgentActionRequest;
        try {
          request = JSON.parse(line) as BridgeRequest | AgentActionRequest;
        } catch {
          responded = true;
          socket.end(JSON.stringify({ behavior: 'deny', message: 'Malformed bridge request' }) + '\n');
          return;
        }
        handler(request, aborter.signal)
          .then((response) => {
            responded = true;
            socket.end(JSON.stringify(response) + '\n');
          })
          .catch((err) => {
            responded = true;
            if (err instanceof BridgeUnavailableError) {
              // No response at all: the client rejects and the MCP server
              // falls back to its legacy prompts.
              socket.destroy();
              return;
            }
            socket.end(
              JSON.stringify({
                behavior: 'deny',
                message: `Bridge handler failed: ${err instanceof Error ? err.message : String(err)}`,
              }) + '\n'
            );
          });
      });
      // The requesting side died before a decision (its timeout, a cancelled
      // tool call, a dead MCP child): tell the handler so it clears any
      // parked pending state — see BridgeDecisionHandler.
      socket.on('close', () => {
        if (!responded) aborter.abort();
      });
      socket.on('error', () => {});
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    } catch (err) {
      // Don't leak the mkdtemp'd directory when listen fails
      if (process.platform !== 'win32') {
        await rm(join(path, '..'), { recursive: true, force: true }).catch(() => {});
      }
      throw err;
    }

    const bridge = new DecisionBridgeServer(server, path);
    bridge.liveSockets = liveSockets;
    return bridge;
  }

  async close(): Promise<void> {
    // Destroy live client connections first: server.close() waits for them,
    // and a connected-but-undecided MCP client would otherwise delay the
    // directory cleanup until its own timeout (or past process exit).
    for (const socket of this.liveSockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    // Remove the socket's private directory (unix only; pipes leave nothing).
    if (process.platform !== 'win32') {
      await rm(join(this.path, '..'), { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * MCP-side client. Connects, sends one request, waits for the decision.
 * Throws on connect failure, connection loss, or timeout — the caller falls
 * back to its legacy behavior (the bridge is an enhancement, never a hard
 * dependency).
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

/**
 * MCP-side client for agent actions. Same transport as
 * `requestBridgeDecision`; typed separately because the response shape is a
 * tool result, not a permission decision. Callers use a SHORT timeout
 * (~15s): the bot answers agent actions immediately (a store write or a
 * card post) — nothing waits on a human inside the bridge call.
 */
export async function requestAgentAction(
  path: string,
  request: AgentActionRequest,
  timeoutMs: number
): Promise<AgentActionResponse> {
  const response = await requestBridgeDecision(
    path,
    request as unknown as BridgeRequest,
    timeoutMs
  ) as unknown as AgentActionResponse & { behavior?: string; message?: string };
  // The server's built-in fallbacks (malformed request, a handler error
  // outside handleAgentAction's own catch) answer in the permission shape
  // ({behavior:'deny', message}). Map them onto the tool contract so the
  // model always sees { ok, reason } — never an ok-less mystery object.
  if (typeof response.ok !== 'boolean' && response.behavior !== undefined) {
    return { ok: false, reason: response.message ?? `bridge answered '${response.behavior}'` };
  }
  return response;
}
