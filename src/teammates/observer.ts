/**
 * Handoff observability, from the bot process.
 *
 * `send_to_teammate` lives in the MCP child, whose stderr is consumed by the
 * agent CLI and never reaches the unit's journal — so a handoff left no trace
 * in `journalctl -u claude-threads` at all, and the only evidence it worked was
 * the text appearing in chat. Debugging the next failure would have been blind.
 *
 * So the bot logs it itself, off the event stream it already watches. The route
 * is recomputed here through the same shared rule the tool uses, which means a
 * disagreement between intent and outcome shows up instead of hiding.
 */

import { createLogger } from '../utils/logger.js';
import { createSessionLog } from '../utils/session-log.js';
import { resolveTeammateRoute } from './registry.js';
import type { Session } from '../session/types.js';
import type { ClaudeEvent } from '../claude/cli.js';

const log = createLogger('teammates');
const sessionLog = createSessionLog(log);

/** Short tool name, matched after stripping any `mcp__<server>__` prefix. */
const HANDOFF_TOOL = 'send_to_teammate';

/**
 * In-flight handoffs per session (tool_use_id → what we expect).
 * Purely observational, so a WeakMap keyed by Session — no field on Session to
 * persist or clean up, and entries vanish with the session object.
 */
const pending = new WeakMap<Session, Map<string, { teammate: string; kind: string }>>();

function pendingFor(session: Session): Map<string, { teammate: string; kind: string }> {
  let m = pending.get(session);
  if (!m) {
    m = new Map();
    pending.set(session, m);
  }
  return m;
}

function shortToolName(name: string): string {
  return name.startsWith('mcp__') ? name.split('__').slice(2).join('__') : name;
}

/** Log handoffs as they happen. Never throws — observability must not break a turn. */
export function noteEvent(session: Session, event: ClaudeEvent): void {
  try {
    if (event.type === 'tool_use') {
      const tool = event.tool_use as { id?: string; name?: string; input?: unknown } | undefined;
      if (!tool?.id || !tool.name || shortToolName(tool.name) !== HANDOFF_TOOL) return;

      const input = (tool.input ?? {}) as { teammate?: unknown };
      const teammate = typeof input.teammate === 'string' ? input.teammate : '(unnamed)';

      const mcp = session.platform.getMcpConfig?.();
      const route = resolveTeammateRoute(teammate, {
        registry: mcp?.teammates ?? [],
        presentHere: mcp?.teammatesPresent ?? [],
        currentChannelId: mcp?.channelId ?? '',
        currentThreadId: session.threadId,
      });

      const kind = route?.kind ?? 'unknown';
      pendingFor(session).set(tool.id, { teammate, kind });
      sessionLog(session).info(
        route
          ? `🤝 Handing off to @${route.teammate.name} via ${kind}`
          : `🤝 Handing off to "${teammate}" — not in the teammate registry`
      );
      return;
    }

    if (event.type === 'tool_result') {
      const result = event.tool_result as { tool_use_id?: string; is_error?: boolean } | undefined;
      if (!result?.tool_use_id) return;
      const inFlight = pendingFor(session).get(result.tool_use_id);
      if (!inFlight) return;
      pendingFor(session).delete(result.tool_use_id);

      if (result.is_error) {
        sessionLog(session).warn(`🤝 Handoff to @${inFlight.teammate} failed`);
      } else {
        sessionLog(session).info(`🤝 Handed off to @${inFlight.teammate} via ${inFlight.kind}`);
      }
    }
  } catch (err) {
    log.debug(`Handoff logging failed: ${err}`);
  }
}
