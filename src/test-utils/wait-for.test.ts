import { describe, it, expect } from 'bun:test';
import { waitFor } from './wait-for.js';

describe('waitFor', () => {
  it('returns immediately when condition is truthy on first call', async () => {
    const start = Date.now();
    const result = await waitFor(() => 'ready', { timeoutMs: 1000, intervalMs: 50 });
    expect(result).toBe('ready');
    expect(Date.now() - start).toBeLessThan(20);
  });

  it('returns when condition becomes truthy before timeout', async () => {
    let attempts = 0;
    const result = await waitFor(() => {
      attempts += 1;
      return attempts >= 3 ? attempts : null;
    }, { timeoutMs: 1000, intervalMs: 10 });
    expect(result).toBe(3);
  });

  it('supports async conditions', async () => {
    let attempts = 0;
    const result = await waitFor(async () => {
      attempts += 1;
      return attempts >= 2 ? 'done' : null;
    }, { timeoutMs: 1000, intervalMs: 10 });
    expect(result).toBe('done');
  });

  it('throws after timeout when condition never becomes truthy', async () => {
    await expect(
      waitFor(() => false, { timeoutMs: 50, intervalMs: 10 })
    ).rejects.toThrow(/timed out/);
  });

  it('uses custom error message', async () => {
    await expect(
      waitFor(() => null, { timeoutMs: 50, intervalMs: 10, message: 'custom boom' })
    ).rejects.toThrow(/custom boom/);
  });
});
