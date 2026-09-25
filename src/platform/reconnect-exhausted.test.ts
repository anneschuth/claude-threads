/**
 * What happens when reconnection attempts run out (#500, #531).
 *
 * The failure this prevents is "active but deaf": a live process whose socket
 * is dead, which a supervisor sees as healthy and a user sees as a bot that
 * stopped answering. Both policies end that state — `retry` by recovering,
 * `exit` by handing the problem to the supervisor.
 */
import { describe, it, expect, mock } from 'bun:test';
import { BasePlatformClient } from './base-client.js';

// Only the reconnect machinery is under test, so the ~20 platform methods
// are left unimplemented and the class is declared abstract to say so.
abstract class ReconnectHarness extends BasePlatformClient {
  readonly platformId = 'test';
  readonly platformType = 'test';
  readonly displayName = 'Test';
  connectCalls = 0;

  async connect(): Promise<void> { this.connectCalls++; }
  // Delegates: the base implementation is what cancels a pending cool-down.
  async disconnect(): Promise<void> { await super.disconnect(); }
  protected async forceCloseConnection(): Promise<void> { /* no socket in this harness */ }

  /** Drive the private state the way an exhausted reconnect loop would. */
  exhaust(): void {
    (this as unknown as { reconnectAttempts: number }).reconnectAttempts =
      (this as unknown as { maxReconnectAttempts: number }).maxReconnectAttempts;
    (this as unknown as { scheduleReconnect: () => void }).scheduleReconnect();
  }
  get attempts(): number { return (this as unknown as { reconnectAttempts: number }).reconnectAttempts; }
  /**
   * Shorten the cool-down AND the first backoff step, so the test does not
   * wait a real minute plus a real second.
   */
  setCooldownMs(ms: number): void {
    (this as unknown as { RECONNECT_COOLDOWN_MS: number }).RECONNECT_COOLDOWN_MS = ms;
    (this as unknown as { reconnectDelay: number }).reconnectDelay = 1;
  }
  pokeScheduleReconnect(): void {
    (this as unknown as { scheduleReconnect: () => void }).scheduleReconnect();
  }
  pokeConnectionEstablished(): void {
    (this as unknown as { onConnectionEstablished: () => void }).onConnectionEstablished();
  }
  get hasPendingReconnect(): boolean {
    return (this as unknown as { reconnectTimeout: unknown }).reconnectTimeout !== null;
  }
}

const TestClient = ReconnectHarness as unknown as new () => ReconnectHarness;

describe('reconnection exhausted', () => {
  it('exit policy: emits reconnect-exhausted and does not kill the process itself', () => {
    const client = new TestClient();
    client.setReconnectPolicy('exit');
    const onExhausted = mock(() => {});
    client.on('reconnect-exhausted', onExhausted);
    const exitSpy = mock(() => undefined as never);
    const realExit = process.exit;
    (process as unknown as { exit: unknown }).exit = exitSpy;

    try {
      client.exhaust();
    } finally {
      (process as unknown as { exit: unknown }).exit = realExit;
    }

    expect(onExhausted).toHaveBeenCalledTimes(1);
    // One platform's dead socket must not take down sessions on healthy
    // platforms, and a library class must not decide the process's fate.
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exit policy: emits once per exhaustion round, not once per trigger', () => {
    // With `exit` the attempt counter is deliberately not reset, so every
    // later trigger re-entered the exhausted branch. Slack produces two per
    // round on its own (a close before `hello` fires onConnectionClosed AND
    // rejects connect()), so shutdown was being asked for repeatedly
    // (CodeRabbit review).
    const client = new TestClient();
    client.setReconnectPolicy('exit');
    const onExhausted = mock(() => {});
    client.on('reconnect-exhausted', onExhausted);

    client.exhaust();
    client.pokeScheduleReconnect();
    client.pokeScheduleReconnect();

    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it('exit policy: a new round can exhaust again after a successful connection', async () => {
    // The latch must not be permanent — a socket that recovers and later dies
    // again has to be reported again.
    const client = new TestClient();
    client.setReconnectPolicy('exit');
    const onExhausted = mock(() => {});
    client.on('reconnect-exhausted', onExhausted);

    try {
      client.exhaust();
      expect(onExhausted).toHaveBeenCalledTimes(1);

      client.pokeConnectionEstablished();  // the socket came back
      client.exhaust();                    // ...and died again later

      expect(onExhausted).toHaveBeenCalledTimes(2);
    } finally {
      await client.disconnect();  // stops the heartbeat pokeConnection... started
    }
  });

  it('retry policy (the default): actually reconnects after the cool-down', async () => {
    // Codex review: the first version of this test asserted the counter reset
    // and cancelled the timer, which stayed green with the whole cool-down
    // block deleted. It has to prove a connection is attempted.
    const client = new TestClient();
    client.setCooldownMs(20);
    const onExhausted = mock(() => {});
    client.on('reconnect-exhausted', onExhausted);
    const exitSpy = mock(() => undefined as never);
    const realExit = process.exit;
    (process as unknown as { exit: unknown }).exit = exitSpy;

    try {
      client.exhaust();
      expect(client.attempts).toBe(0);      // reset, ready for a fresh round
      expect(client.connectCalls).toBe(0);  // but not yet — it is cooling down

      // Cool-down elapses, then the first backoff step of the new round.
      await new Promise((r) => setTimeout(r, 60));
      expect(client.connectCalls).toBeGreaterThan(0);
    } finally {
      (process as unknown as { exit: unknown }).exit = realExit;
      client.clearReconnectTimer();
    }

    expect(exitSpy).not.toHaveBeenCalled();
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it('a second trigger during the cool-down does not shorten it', async () => {
    // Codex review: `scheduleReconnect` clears the pending timer at the top,
    // so without explicit cool-down state a duplicate trigger replaced the
    // 60s wait with a 1s attempt-1 backoff. Slack reaches this naturally — a
    // close before `hello` both fires onConnectionClosed and rejects
    // connect(), whose catch schedules again.
    const client = new TestClient();
    client.setCooldownMs(40);

    client.exhaust();
    client.pokeScheduleReconnect();  // the duplicate trigger
    client.pokeScheduleReconnect();

    // Well past a 1s-equivalent short-circuit would have been, still waiting.
    await new Promise((r) => setTimeout(r, 20));
    expect(client.connectCalls).toBe(0);

    await new Promise((r) => setTimeout(r, 60));
    expect(client.connectCalls).toBeGreaterThan(0);
    client.clearReconnectTimer();
  });

  it('a successful connection cancels a pending cool-down instead of tearing itself down', async () => {
    // CodeRabbit: the cool-down timer outlived a reconnection that succeeded
    // by another route (a heartbeat-driven retry landing first). It then
    // fired on a HEALTHY socket, and scheduleReconnect() force-closes before
    // reconnecting — so recovering from the outage killed the connection
    // that recovered it.
    const client = new TestClient();
    client.setCooldownMs(20);

    try {
      client.exhaust();
      expect(client.hasPendingReconnect).toBe(true);

      client.pokeConnectionEstablished();   // the socket came back on its own
      expect(client.hasPendingReconnect).toBe(false);

      await new Promise((r) => setTimeout(r, 60));
      expect(client.connectCalls).toBe(0);  // nothing tore it down
    } finally {
      await client.disconnect();            // stops the heartbeat this started
    }
  });

  it('an intentional disconnect cancels a pending cool-down', async () => {
    // Gemini review: the cool-down timer would otherwise hold the event loop
    // open through shutdown and then reconnect a deliberately closed client.
    const client = new TestClient();
    client.setCooldownMs(20);

    client.exhaust();
    expect(client.hasPendingReconnect).toBe(true);

    await client.disconnect();

    // The timer is gone, not merely neutered: the reconnect callback already
    // bails on an intentional disconnect, so `connectCalls` alone cannot tell
    // a cancelled timer from a live one still holding the event loop open.
    expect(client.hasPendingReconnect).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(client.connectCalls).toBe(0);
  });
});
