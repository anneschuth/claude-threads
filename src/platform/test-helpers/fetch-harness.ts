/**
 * Shared `fetch` harness for platform-API unit tests.
 *
 * Mattermost and Slack MCP-API tests both want the same shape: replace
 * `global.fetch` with a recorder + a per-test responder, then assert on
 * (url, method, headers, body). This module exposes a small object you
 * install/uninstall around each test.
 *
 * Why a class-ish wrapper instead of free state: free `let`s force every
 * test file to either re-declare them or import the same identifier name,
 * and `beforeEach` assignments leak across files in the same Bun test
 * runner process. A scoped harness is cheaper to reason about.
 */
import { afterEach, beforeEach } from 'bun:test';

export type FetchResponder = (url: string, init?: RequestInit) => Promise<Response> | Response;

export interface RecordedFetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface FetchHarness {
  /**
   * Calls recorded since the last beforeEach.
   *
   * **Contract:** the array is mutated in place between tests
   * (`length = 0` to clear, `push()` to record). The reference is
   * stable, so destructuring `const { calls } = installFetchHarness(...)`
   * gives you a binding that stays in sync with future tests. If a
   * future change ever re-assigns the array (`this.calls = []`),
   * destructuring callers will silently observe stale data — keep the
   * mutation-in-place semantics or switch to a getter function.
   */
  readonly calls: RecordedFetchCall[];
}

/**
 * Install the fetch harness via Bun's `beforeEach` / `afterEach`. The
 * caller passes a `getResponder` callback so it can keep its own
 * `let fetchResponder = ...` binding and the harness will read whatever
 * the test currently has assigned.
 *
 * Usage in a test file:
 *
 *     let fetchResponder: FetchResponder = () => jsonResponse({});
 *     const { calls: fetchCalls } = installFetchHarness(() => fetchResponder);
 *
 *     it('does the thing', () => {
 *       fetchResponder = () => jsonResponse({ ok: true });
 *       // ...
 *       expect(fetchCalls[0].url).toBe(...);
 *     });
 *
 * Why a getter instead of a setter on the harness: keeps the per-test
 * pattern (`fetchResponder = () => ...`) familiar. A setter forces every
 * existing test body to swap an assignment for a function call.
 */
export function installFetchHarness(getResponder: () => FetchResponder): FetchHarness {
  const calls: RecordedFetchCall[] = [];
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    calls.length = 0;
    originalFetch = global.fetch;
    global.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = init.headers as Record<string, string>;
        for (const k of Object.keys(h)) headers[k] = h[k];
      }
      let body: unknown;
      if (typeof init?.body === 'string') {
        try { body = JSON.parse(init.body); } catch { body = init.body; }
      }
      calls.push({ url: urlStr, method, headers, body });
      return getResponder()(urlStr, init);
    }) as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  return {
    get calls() {
      return calls;
    },
  };
}

/** JSON response with the right content-type header. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Plain-text error response. */
export function errorResponse(status: number, text = 'oops'): Response {
  return new Response(text, { status });
}
