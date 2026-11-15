import { describe, it, expect } from 'bun:test';
import { createSerialByKey } from './serial-by-key.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('createSerialByKey', () => {
  it('finishes a task before it starts the next one for the same key', async () => {
    const serial = createSerialByKey<string>();
    const events: string[] = [];
    const task = (name: string, ms: number) => async () => {
      events.push(`start ${name}`);
      await sleep(ms);
      events.push(`done ${name}`);
    };

    await Promise.all([serial('a', task('enable', 20)), serial('a', task('disable', 1)), serial('a', task('enable again', 1))]);

    expect(events).toEqual(['start enable', 'done enable', 'start disable', 'done disable', 'start enable again', 'done enable again']);
  });

  it('does not make one key wait for another', async () => {
    const serial = createSerialByKey<string>();
    const events: string[] = [];
    const slow = serial('a', async () => { await sleep(30); events.push('a'); });
    const fast = serial('b', async () => { events.push('b'); });

    await Promise.all([slow, fast]);

    expect(events).toEqual(['b', 'a']);
  });

  it('reports a failure to its caller and still runs what is queued behind it', async () => {
    const serial = createSerialByKey<string>();
    const failed = serial('a', async () => { throw new Error('nope'); });
    const next = serial('a', async () => 'ran');

    await expect(failed).rejects.toThrow('nope');
    expect(await next).toBe('ran');
  });
});
