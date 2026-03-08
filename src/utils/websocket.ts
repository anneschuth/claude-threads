/**
 * WebSocket compatibility layer.
 *
 * Bun and Node.js 22+ expose WebSocket as a global. Older Node.js versions
 * (18-21) do not, so when the bundle is built with `--target node` the global
 * may be missing. In that case we fall back to the `ws` npm package which is
 * listed as a dependency for exactly this purpose.
 */

let WS: typeof WebSocket;

if (typeof globalThis.WebSocket !== 'undefined') {
  WS = globalThis.WebSocket;
} else {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const wsModule = require('ws');
  WS = (wsModule.default ?? wsModule) as typeof WebSocket;
}

export { WS as WebSocket };
