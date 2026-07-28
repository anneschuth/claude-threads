/**
 * Teammate registry and handoff routing.
 *
 * A fleet of bots reaches each other in one of two shapes, and until now each
 * caller decided which on its own — the cross-bot prompt protocol picked
 * "their channel", the docs ping hardcoded it, and the shared-channel rule
 * said "this thread". Same decision, three implementations, guaranteed to
 * drift apart. This module is the single rule.
 *
 * Pure: imported by the MCP child (send_to_teammate) and by the main process
 * (docs ping), so neither can route differently from the other.
 */

import { buildReturnAddressMarker } from '../operations/return-address/parser.js';
import type { DeliveryTarget } from '../platform/types.js';

/** One reachable teammate bot. */
export interface Teammate {
  /** Mention name, without '@'. Matched case-insensitively. */
  name: string;
  /** The teammate's OWN channel — where to reach them from anywhere else. */
  channelId: string;
}

/** Where a handoff to a teammate should land, plus why. */
export interface TeammateRoute {
  target: DeliveryTarget;
  /**
   * 'thread' — the teammate holds sessions in this very channel, so the whole
   * exchange stays in one thread and needs no backlink.
   * 'channel' — cold contact in their own channel; the message must carry a
   * link back to our thread or the reply has nowhere to go.
   */
  kind: 'thread' | 'channel';
  teammate: Teammate;
}

/** Find a teammate by mention name. Tolerates a leading '@' and any case. */
export function findTeammate(registry: Teammate[], name: string): Teammate | undefined {
  const wanted = name.trim().replace(/^@/, '').toLowerCase();
  if (!wanted) return undefined;
  return registry.find((t) => t.name.toLowerCase() === wanted);
}

/**
 * Decide where a message to `name` goes.
 *
 * The rule, in one line: a teammate who listens in this channel is answered in
 * this thread; anyone else gets their own channel.
 *
 * `presentHere` lists teammates that hold sessions in the CURRENT channel —
 * per-platform config, because it's a property of the channel, not of the bot.
 *
 * Returns null when the name isn't a known teammate, so callers can say so
 * instead of silently posting somewhere plausible.
 */
export function resolveTeammateRoute(
  name: string,
  opts: {
    registry: Teammate[];
    presentHere: string[];
    currentChannelId: string;
    currentThreadId: string;
  },
): TeammateRoute | null {
  const teammate = findTeammate(opts.registry, name);
  if (!teammate) return null;

  const isHere = opts.presentHere.some(
    (n) => n.trim().replace(/^@/, '').toLowerCase() === teammate.name.toLowerCase(),
  );

  // Without a thread to reply in, "same channel" would post at channel level
  // and start a thread the teammate can't tie back to anything — fall back.
  if (isHere && opts.currentChannelId && opts.currentThreadId) {
    return {
      kind: 'thread',
      teammate,
      target: { channelId: opts.currentChannelId, rootId: opts.currentThreadId },
    };
  }

  return {
    kind: 'channel',
    teammate,
    target: { channelId: teammate.channelId, rootId: '' },
  };
}

/**
 * Compose the message body for a handoff. Code owns this, not the agent: the
 * backlink is exactly what used to be forgotten (and what a PreToolUse hook
 * had to police), and in-thread handoffs must NOT carry one — a link to the
 * thread you are already posting in reads as the counterpart's thread and
 * sends the reply into a dead end.
 */
export function buildHandoffMessage(
  route: TeammateRoute,
  text: string,
  ownThreadLink: string,
): string {
  const mention = `@${route.teammate.name}`;
  if (route.kind === 'thread') return `${mention} ${text}`;
  // No link available (platforms whose permalink the MCP child can't build):
  // omit the whole directive rather than emit a dangling "reply in thread:".
  if (!ownThreadLink) return `${mention} ${text}`;
  return `${mention} ${text}\n\n---\n${buildReturnAddressMarker(ownThreadLink)}`;
}

/** Parse the registry handed to the MCP child as JSON. Never throws. */
export function parseTeammateRegistry(raw: string | undefined): Teammate[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      const e = entry as { name?: unknown; channelId?: unknown };
      return typeof e.name === 'string' && e.name.trim()
        && typeof e.channelId === 'string' && e.channelId.trim()
        ? [{ name: e.name.trim(), channelId: e.channelId.trim() }]
        : [];
    });
  } catch {
    return [];
  }
}
