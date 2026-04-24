/**
 * waitFor — poll `cond` until it returns truthy, or throw on timeout.
 *
 * Use in integration tests instead of arbitrary `setTimeout` sleeps. The
 * polling resolves as soon as `cond` is truthy, so fast machines do not
 * wait the full duration.
 */

export interface WaitForOptions {
  timeoutMs?: number;
  intervalMs?: number;
  message?: string;
}

export async function waitFor<T>(
  cond: () => T | Promise<T>,
  options: WaitForOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 25;
  const message = options.message ?? 'waitFor timed out';
  const deadline = Date.now() + timeoutMs;

  // First attempt — cheap path for the common case where cond is already true.
  const first = await cond();
  if (first) return first;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    const result = await cond();
    if (result) return result;
  }

  throw new Error(`${message} (after ${timeoutMs}ms)`);
}
