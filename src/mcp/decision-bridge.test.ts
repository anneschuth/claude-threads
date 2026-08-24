/**
 * Tests for the decision bridge — real sockets, both halves.
 */

import { describe, it, expect } from 'bun:test';
import {
  DecisionBridgeServer,
  requestBridgeDecision,
  bridgeSocketPath,
  type BridgeRequest,
  type BridgeResponse,
} from './decision-bridge.js';

const PLAN_REQUEST: BridgeRequest = {
  kind: 'plan_approval',
  toolName: 'ExitPlanMode',
  input: { plan: 'Step 1: do the thing' },
};

describe('DecisionBridge', () => {
  it('round-trips an approval decision over a real socket', async () => {
    const seen: BridgeRequest[] = [];
    const server = await DecisionBridgeServer.create(async (req) => {
      seen.push(req as BridgeRequest);
      return { behavior: 'allow', updatedInput: req.input };
    });
    try {
      const decision = await requestBridgeDecision(server.path, PLAN_REQUEST, 5000);
      expect(decision).toEqual({ behavior: 'allow', updatedInput: { plan: 'Step 1: do the thing' } });
      expect(seen).toEqual([PLAN_REQUEST]);
    } finally {
      await server.close();
    }
  });

  it('round-trips a question decision with answers in updatedInput', async () => {
    const server = await DecisionBridgeServer.create(async (req) => ({
      behavior: 'allow',
      updatedInput: { ...req.input, answers: { 'Red or blue?': 'Blue' } },
    }));
    try {
      const decision = await requestBridgeDecision(
        server.path,
        { kind: 'question', toolName: 'AskUserQuestion', input: { questions: [] } },
        5000
      );
      expect(decision.behavior).toBe('allow');
      expect((decision.updatedInput as { answers: unknown }).answers).toEqual({ 'Red or blue?': 'Blue' });
    } finally {
      await server.close();
    }
  });

  it('serves multiple sequential requests', async () => {
    let n = 0;
    const server = await DecisionBridgeServer.create(async () => ({
      behavior: (++n % 2 ? 'allow' : 'deny') as BridgeResponse['behavior'],
    }));
    try {
      expect((await requestBridgeDecision(server.path, PLAN_REQUEST, 5000)).behavior).toBe('allow');
      expect((await requestBridgeDecision(server.path, PLAN_REQUEST, 5000)).behavior).toBe('deny');
      expect((await requestBridgeDecision(server.path, PLAN_REQUEST, 5000)).behavior).toBe('allow');
    } finally {
      await server.close();
    }
  });

  it('client times out when the handler never answers', async () => {
    const server = await DecisionBridgeServer.create(
      () => new Promise<BridgeResponse>(() => {}) // never resolves
    );
    try {
      await expect(requestBridgeDecision(server.path, PLAN_REQUEST, 150)).rejects.toThrow(/timed out/);
    } finally {
      await server.close();
    }
  });

  it('client rejects when nothing listens on the path', async () => {
    await expect(
      requestBridgeDecision(bridgeSocketPath(), PLAN_REQUEST, 1000)
    ).rejects.toThrow();
  });

  it('turns a throwing handler into a deny with the error message', async () => {
    const server = await DecisionBridgeServer.create(async () => {
      throw new Error('handler exploded');
    });
    try {
      const decision = await requestBridgeDecision(server.path, PLAN_REQUEST, 5000);
      expect(decision.behavior).toBe('deny');
      expect(decision.message).toContain('handler exploded');
    } finally {
      await server.close();
    }
  });

  it('denies malformed requests instead of crashing', async () => {
    const server = await DecisionBridgeServer.create(async () => ({ behavior: 'allow' }));
    try {
      const { createConnection } = await import('node:net');
      const decision = await new Promise<BridgeResponse>((resolve, reject) => {
        const socket = createConnection(server.path, () => {
          socket.write('this is not json\n');
        });
        let buf = '';
        socket.on('data', (c) => {
          buf += c.toString();
          if (buf.includes('\n')) {
            socket.destroy();
            resolve(JSON.parse(buf.slice(0, buf.indexOf('\n'))) as BridgeResponse);
          }
        });
        socket.on('error', reject);
      });
      expect(decision.behavior).toBe('deny');
      expect(decision.message).toContain('Malformed');
    } finally {
      await server.close();
    }
  });

  it('close() releases the socket path for reuse', async () => {
    const server = await DecisionBridgeServer.create(async () => ({ behavior: 'allow' }));
    const path = server.path;
    await server.close();
    await expect(requestBridgeDecision(path, PLAN_REQUEST, 500)).rejects.toThrow();
  });
});

describe('DecisionBridge - client disconnect aborts the handler', () => {
  it('signals abort when the client times out before a decision', async () => {
    let aborted = false;
    let sawSignal: AbortSignal | null = null;
    const server = await DecisionBridgeServer.create(
      (_req, signal) =>
        new Promise<BridgeResponse>(() => {
          sawSignal = signal;
          signal.addEventListener('abort', () => { aborted = true; });
        })
    );
    try {
      await expect(requestBridgeDecision(server.path, PLAN_REQUEST, 150)).rejects.toThrow(/timed out/);
      // The client destroyed its socket; the server must abort the parked handler
      await new Promise(r => setTimeout(r, 100));
      expect(sawSignal).not.toBeNull();
      expect(aborted).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('does not abort when the handler already responded', async () => {
    let aborted = false;
    const server = await DecisionBridgeServer.create(async (_req, signal) => {
      signal.addEventListener('abort', () => { aborted = true; });
      return { behavior: 'allow' };
    });
    try {
      await requestBridgeDecision(server.path, PLAN_REQUEST, 5000);
      await new Promise(r => setTimeout(r, 100));
      expect(aborted).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('keeps the socket path under the unix sun_path limit', async () => {
    // macOS caps sun_path at 104 bytes and silently truncates over-long
    // paths on bind/connect — cleanup then misses the real file.
    const path = bridgeSocketPath();
    expect(path.length).toBeLessThan(104);
    if (process.platform !== 'win32') {
      const { rm } = await import('node:fs/promises');
      const { join } = await import('node:path');
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });
});
