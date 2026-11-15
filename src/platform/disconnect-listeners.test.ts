/**
 * Listeners across an intentional disconnect.
 *
 * After `disconnect()` no handler may run, so one the socket queued just
 * before close cannot act on a bot that is shutting down. The terminal UI can
 * also disable a platform and enable it again, and the listeners are attached
 * only once, at startup. They used to be detached on disconnect, which left
 * the re-enabled platform connected and ignoring every message.
 */
import { describe, it, expect } from 'bun:test';
import { BasePlatformClient } from './base-client.js';

// Only listener bookkeeping is under test, so the platform methods are left
// unimplemented and the class is declared abstract to say so.
abstract class ListenerHarness extends BasePlatformClient {
  readonly platformId = 'test';
  readonly platformType = 'test';
  readonly displayName = 'Test';
  async connect(): Promise<void> { /* no socket in this harness */ }
  protected async forceCloseConnection(): Promise<void> { /* no socket in this harness */ }
}
const TestClient = ListenerHarness as unknown as new () => ListenerHarness;

describe('listeners across an intentional disconnect', () => {
  it('hear nothing while the client is disconnected', async () => {
    const client = new TestClient();
    const seen: string[] = [];
    client.on('message', () => seen.push('message'));

    await client.disconnect();
    client.emit('message');

    expect(seen).toEqual([]);
  });

  it('are back after prepareForReconnect, so a re-enabled platform hears messages again', async () => {
    const client = new TestClient();
    const seen: string[] = [];
    client.on('message', () => seen.push('message'));
    client.on('reaction', () => seen.push('reaction'));

    await client.disconnect();
    client.prepareForReconnect();
    client.emit('message');
    client.emit('reaction');

    expect(seen).toEqual(['message', 'reaction']);
  });

  it('fire once per event, also after overlapping disconnects and repeated toggles', async () => {
    const client = new TestClient();
    const seen: string[] = [];
    client.on('message', () => seen.push('message'));

    await Promise.all([client.disconnect(), client.disconnect()]);
    client.prepareForReconnect();
    client.prepareForReconnect();
    await client.disconnect();
    client.prepareForReconnect();
    client.emit('message');

    expect(seen).toEqual(['message']);
  });

  it('respects a listener removed while disconnected', async () => {
    const client = new TestClient();
    const seen: string[] = [];
    const handler = () => seen.push('connected');
    client.on('connected', handler);

    await client.disconnect();
    client.off('connected', handler);
    client.prepareForReconnect();
    client.emit('connected');

    expect(seen).toEqual([]);
  });

  it('does not replay missed messages when it was disabled in the middle of a reconnect', async () => {
    const client = new TestClient();
    (client as unknown as { isReconnecting: boolean }).isReconnecting = true;

    await client.disconnect();
    client.prepareForReconnect();

    expect((client as unknown as { isReconnecting: boolean }).isReconnecting).toBe(false);
  });

  it('keeps a once-listener one-shot', async () => {
    const client = new TestClient();
    const seen: string[] = [];
    client.once('connected', () => seen.push('connected'));

    await client.disconnect();
    client.prepareForReconnect();
    client.emit('connected');
    client.emit('connected');

    expect(seen).toEqual(['connected']);
  });
});
