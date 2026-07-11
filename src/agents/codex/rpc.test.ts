import { describe, it, expect } from 'bun:test';
import { PassThrough } from 'stream';
import { JsonRpcConnection, JsonRpcError } from './rpc.js';

function createConnection() {
  const input = new PassThrough();  // client -> server
  const output = new PassThrough(); // server -> client
  const rpc = new JsonRpcConnection(input, output);

  const written: unknown[] = [];
  input.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) written.push(JSON.parse(line));
    }
  });

  const serverSend = (obj: unknown) => output.write(JSON.stringify(obj) + '\n');
  return { rpc, written, serverSend };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('JsonRpcConnection', () => {
  it('sends requests with incrementing ids and resolves matching responses', async () => {
    const { rpc, written, serverSend } = createConnection();

    const promise = rpc.request('thread/start', { cwd: '/tmp' });
    await flush();

    expect(written).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'thread/start', params: { cwd: '/tmp' } },
    ]);

    serverSend({ id: 1, result: { thread: { id: 'thr_1' } } });
    expect(await promise).toEqual({ thread: { id: 'thr_1' } });
  });

  it('rejects on error responses with JsonRpcError', async () => {
    const { rpc, serverSend } = createConnection();

    const promise = rpc.request('thread/resume', { threadId: 'gone' });
    await flush();
    serverSend({ id: 1, error: { code: -32000, message: 'thread not found' } });

    expect(promise).rejects.toBeInstanceOf(JsonRpcError);
    await promise.catch((err: JsonRpcError) => {
      expect(err.message).toBe('thread not found');
      expect(err.code).toBe(-32000);
    });
  });

  it('sends notifications without ids', async () => {
    const { rpc, written } = createConnection();

    rpc.notify('initialized', {});
    await flush();

    expect(written).toEqual([{ jsonrpc: '2.0', method: 'initialized', params: {} }]);
  });

  it('routes server notifications to the notification handler', async () => {
    const { rpc, serverSend } = createConnection();

    const received: Array<{ method: string; params: unknown }> = [];
    rpc.onNotification((method, params) => received.push({ method, params }));

    serverSend({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { status: 'completed' } } });
    await flush();

    expect(received).toEqual([
      { method: 'turn/completed', params: { turn: { status: 'completed' } } },
    ]);
  });

  it('routes server-initiated requests and sends back responses via respond()', async () => {
    const { rpc, written, serverSend } = createConnection();

    rpc.onServerRequest((id, method) => {
      expect(method).toBe('item/commandExecution/requestApproval');
      rpc.respond(id, { decision: 'accept' });
    });

    serverSend({ jsonrpc: '2.0', id: 42, method: 'item/commandExecution/requestApproval', params: { command: 'rm -rf x' } });
    await flush();

    expect(written).toEqual([{ jsonrpc: '2.0', id: 42, result: { decision: 'accept' } }]);
  });

  it('handles messages split across chunks', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const rpc = new JsonRpcConnection(input, output);

    const received: string[] = [];
    rpc.onNotification((method) => received.push(method));

    const line = JSON.stringify({ jsonrpc: '2.0', method: 'turn/started', params: {} }) + '\n';
    output.write(line.slice(0, 10));
    await flush();
    output.write(line.slice(10));
    await flush();

    expect(received).toEqual(['turn/started']);
  });

  it('rejects in-flight requests when closed', async () => {
    const { rpc } = createConnection();

    const promise = rpc.request('turn/start', {});
    rpc.close('process exited');

    expect(promise).rejects.toThrow('process exited');
  });
});
