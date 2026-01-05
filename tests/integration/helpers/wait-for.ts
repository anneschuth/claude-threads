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
 * Wait for a condition to NOT throw an error
 *
 * @param fn - Function that may throw
 * @param options - Wait options
 * @returns The value returned by the function
 */
export async function waitForNoThrow<T>(
  fn: () => T | Promise<T>,
  options: WaitOptions = {},
): Promise<T> {
  const { timeout = 10000, interval = 100, description = 'operation' } = options;

  const startTime = Date.now();
  let lastError: Error | null = null;

  while (Date.now() - startTime < timeout) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
    }

    await sleep(interval);
  }

  throw new Error(
    `Timeout waiting for ${description} (${timeout}ms). Last error: ${lastError?.message}`,
  );
}

/**
 * Wait for an array to have at least N items
 */
export async function waitForLength<T>(
  getArray: () => T[] | Promise<T[]>,
  minLength: number,
  options: WaitOptions = {},
): Promise<T[]> {
  return waitFor(
    async () => {
      const arr = await getArray();
      return arr.length >= minLength ? arr : null;
    },
    { ...options, description: options.description || `array length >= ${minLength}` },
  );
}

/**
 * Wait for a specific value in an array
 */
export async function waitForInArray<T>(
  getArray: () => T[] | Promise<T[]>,
  predicate: (item: T) => boolean,
  options: WaitOptions = {},
): Promise<T> {
  return waitFor(
    async () => {
      const arr = await getArray();
      return arr.find(predicate) || null;
    },
    { ...options, description: options.description || 'item in array' },
  );
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

/**
 * Create a deferred promise that can be resolved/rejected externally
 */
export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

/**
 * Wait for an event emitter to emit a specific event
 */
export function waitForEvent<T>(
  emitter: { on: (event: string, handler: (data: T) => void) => void },
  event: string,
  options: WaitOptions = {},
): Promise<T> {
  const { timeout = 10000, description = `event "${event}"` } = options;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for ${description} (${timeout}ms)`));
    }, timeout);

    emitter.on(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/**
 * Wait for a WebSocket to connect
 */
export function waitForWebSocketOpen(
  ws: WebSocket,
  options: WaitOptions = {},
): Promise<void> {
  const { timeout = 10000 } = options;

  if (ws.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`WebSocket connection timeout (${timeout}ms)`));
    }, timeout);

    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });

    ws.addEventListener('error', (event) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${event}`));
    });
  });
}
