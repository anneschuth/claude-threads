/**
 * Regression tests for the ping-as-activity attachment (#498).
 *
 * An idle Socket Mode connection carries only protocol-level ping frames, so
 * a heartbeat fed from `onmessage` alone concludes every healthy idle
 * connection is dead and kills it once a minute, forever. These pin both the
 * fake-object contract and the real behavior against a live `ws` server.
 */

import { describe, it, expect } from 'bun:test';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { countPingsAsActivity } from './websocket.js';

describe('countPingsAsActivity', () => {
  it('feeds the clock through an EventTarget-style ping (Bun native)', () => {
    let pings = 0;
    const listeners: Record<string, () => void> = {};
    const fake = {
      addEventListener: (event: string, fn: () => void) => {
        listeners[event] = fn;
      },
    };

    countPingsAsActivity(fake, () => pings++);
    listeners.ping?.();

    expect(pings).toBe(1);
  });

  it('feeds the clock through an EventEmitter-style ping (Node 20 ws)', () => {
    let pings = 0;
    const listeners: Record<string, () => void> = {};
    const fake = {
      on: (event: string, fn: () => void) => {
        listeners[event] = fn;
      },
    };

    countPingsAsActivity(fake, () => pings++);
    listeners.ping?.();

    expect(pings).toBe(1);
  });

  it('is a silent no-op on a socket exposing neither (Node 22+ undici)', () => {
    expect(() => countPingsAsActivity({}, () => {})).not.toThrow();
  });

  it('attaches both mechanisms without double-counting a single frame', () => {
    // A runtime offering both would otherwise count one frame twice. Each
    // mechanism fires only for its own dispatch, so one frame is one call.
    let pings = 0;
    const et: Record<string, () => void> = {};
    const ee: Record<string, () => void> = {};
    const fake = {
      addEventListener: (e: string, fn: () => void) => { et[e] = fn; },
      on: (e: string, fn: () => void) => { ee[e] = fn; },
    };

    countPingsAsActivity(fake, () => pings++);
    et.ping?.();

    expect(pings).toBe(1);
  });

  // End-to-end coverage rather than a discriminator: Bun's `ws` client
  // satisfies both attachment styles, so this stays green if either half is
  // removed. The two fake-object tests above are what pin each mechanism.
  it('counts a real protocol ping from a live ws server', async () => {
    const server = new WebSocketServer({ port: 0 });
    try {
      const port = (server.address() as AddressInfo).port;
      server.on('connection', (socket) => socket.ping());

      const { WebSocket: WsClient } = await import('ws');
      const client = new WsClient(`ws://127.0.0.1:${port}`);

      const sawPing = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 3000);
        countPingsAsActivity(client, () => {
          clearTimeout(timer);
          resolve(true);
        });
        client.on('error', () => {
          clearTimeout(timer);
          resolve(false);
        });
      });

      client.close();
      expect(sawPing).toBe(true);
    } finally {
      server.close();
    }
  });
});
