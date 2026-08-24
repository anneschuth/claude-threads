/**
 * Polling and waiting utilities for integration tests
 */

export interface WaitOptions {
  /** Maximum time to wait in milliseconds (default: 10000) */
  timeout?: number;
  /** Interval between checks in milliseconds (default: 100) */
  interval?: number;
  /** Description for error messages */
  description?: string;
}

/**
 * Sleep for a specified number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for a condition to become truthy
 *
 * @param condition - Function that returns a value or promise. Truthy = done, falsy = keep waiting.
 * @param options - Wait options
 * @returns The truthy value returned by the condition
 * @throws Error if timeout is reached
 */
export async function waitFor<T>(
  condition: () => T | Promise<T>,
  options: WaitOptions = {},
): Promise<NonNullable<T>> {
  const { timeout = 10000, interval = 100, description = 'condition' } = options;

  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const result = await condition();
      if (result) {
        return result as NonNullable<T>;
      }
    } catch {
      // Condition threw an error, keep waiting
    }

    await sleep(interval);
  }

  throw new Error(`Timeout waiting for ${description} (${timeout}ms)`);
}

/**
 * Retry an operation with exponential backoff
 */
export async function retry<T>(
  fn: () => T | Promise<T>,
  options: {
    maxAttempts?: number;
    initialDelay?: number;
    maxDelay?: number;
    backoffFactor?: number;
    description?: string;
  } = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelay = 100,
    maxDelay = 5000,
    backoffFactor = 2,
    description = 'operation',
  } = options;

  let lastError: Error | null = null;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt === maxAttempts) {
        throw new Error(
          `${description} failed after ${maxAttempts} attempts. Last error: ${lastError.message}`,
        );
      }

      await sleep(delay);
      delay = Math.min(delay * backoffFactor, maxDelay);
    }
  }

  throw lastError;
}
