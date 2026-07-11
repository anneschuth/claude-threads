/**
 * Minimal JSON-RPC 2.0 client over newline-delimited JSON streams,
 * as spoken by `codex app-server`.
 *
 * Supports:
 * - client → server requests with promise-based responses
 * - client → server notifications
 * - server → client notifications (onNotification)
 * - server → client requests, e.g. approval prompts (onServerRequest + respond)
 */

import type { Readable, Writable } from 'stream';

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(error: JsonRpcErrorShape) {
    super(error.message);
    this.name = 'JsonRpcError';
    this.code = error.code;
    this.data = error.data;
  }
}

type NotificationHandler = (method: string, params: unknown) => void;
type ServerRequestHandler = (id: number | string, method: string, params: unknown) => void;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  method: string;
}

export class JsonRpcConnection {
  private readonly input: Writable;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private notificationHandler: NotificationHandler | null = null;
  private serverRequestHandler: ServerRequestHandler | null = null;
  private closed = false;

  constructor(input: Writable, output: Readable) {
    this.input = input;
    output.on('data', (chunk: Buffer | string) => this.onData(chunk.toString()));
  }

  /** Send a request and await the matching response. */
  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error(`JSON-RPC connection closed (request: ${method})`));
    }
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });
    this.write({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  /** Send a notification (no response expected). */
  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** Respond to a server-initiated request (e.g. an approval prompt). */
  respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  /** Register the handler for server → client notifications. */
  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  /** Register the handler for server → client requests. */
  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  /**
   * Mark the connection closed and reject all in-flight requests.
   * Called when the underlying process exits.
   */
  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error(reason ?? 'JSON-RPC connection closed');
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
  }

  private write(obj: unknown): void {
    if (this.closed || !this.input.writable) return;
    this.input.write(JSON.stringify(obj) + '\n');
  }

  private onData(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg: {
        id?: number | string;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: JsonRpcErrorShape;
      };
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue; // Ignore unparseable lines (partial JSON, stray output)
      }

      if (msg.id !== undefined && msg.method === undefined) {
        // Response to one of our requests
        const pending = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
        if (pending && typeof msg.id === 'number') {
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new JsonRpcError(msg.error));
          } else {
            pending.resolve(msg.result);
          }
        }
      } else if (msg.id !== undefined && msg.method) {
        // Server-initiated request (approvals etc.)
        this.serverRequestHandler?.(msg.id, msg.method, msg.params);
      } else if (msg.method) {
        // Notification
        this.notificationHandler?.(msg.method, msg.params);
      }
    }
  }
}
