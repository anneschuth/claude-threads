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

import type { DeliveryTarget } from '../platform/types.js';

/** One reachable teammate bot. */
export interface Teammate {
  /** Mention name, without '@'. Matched case-insensitively. */
  name: string;
  /** The teammate's OWN channel — where to reach them from anywhere else. */
  channelId: string;
}

/** Where a handoff to a teammate lands. Always a thread — see resolveTeammateRoute. */
export interface TeammateRoute {
  target: DeliveryTarget;
  /**
   * Always 'thread'. Kept as a field because logs and the send_to_teammate
   * response report it, and a future second kind should have to declare itself
   * rather than appear by omission.
   */
  kind: 'thread';
  teammate: Teammate;
}

/** Why a teammate could not be reached, for callers that must explain it. */
export type UnreachableReason = 'unknown' | 'not-here';

/** Find a teammate by mention name. Tolerates a leading '@' and any case. */
export function findTeammate(registry: Teammate[], name: string): Teammate | undefined {
  const wanted = name.trim().replace(/^@/, '').toLowerCase();
  if (!wanted) return undefined;
  return registry.find((t) => t.name.toLowerCase() === wanted);
}

/**
 * Decide where a message to `name` goes. One answer only: THIS thread.
 *
 * Cross-bot work lives in threads and nowhere else. Posting into a teammate's
 * channel used to be the "cold contact" path, and every time it fired it made
 * things worse: it opens a SECOND thread for a conversation that already has
 * one, the reply comes back in that new thread, and the two halves drift apart —
 * which is the problem shared channels were introduced to end. Observed on
 * 2026-07-29: krang pinged rocksteady correctly in his own thread, rocksteady
 * came, and then krang pinged him AGAIN at channel level in ~ai-dev-rocksteady,
 * duplicating the thread for no gain.
 *
 * So there is no channel route. `presentHere` lists the teammates that hold
 * sessions in the CURRENT channel — per-platform config, because it is a
 * property of the channel, not of the bot — and a teammate who is not among them
 * cannot be reached from here at all. Callers get null and must say so rather
 * than post somewhere plausible.
 *
 * Use `unreachableReason` to tell "no such teammate" from "not in this channel".
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
  if (!isPresentHere(teammate, opts.presentHere)) return null;

  // No thread to land in (channel-level context) means no route: posting at
  // channel level is exactly what this function refuses to do.
  if (!opts.currentChannelId || !opts.currentThreadId) return null;

  return {
    kind: 'thread',
    teammate,
    target: { channelId: opts.currentChannelId, rootId: opts.currentThreadId },
  };
}

function isPresentHere(teammate: Teammate, presentHere: string[]): boolean {
  return presentHere.some(
    (n) => n.trim().replace(/^@/, '').toLowerCase() === teammate.name.toLowerCase(),
  );
}

/**
 * Why `resolveTeammateRoute` returned null. Lets a caller answer the agent with
 * something actionable instead of a bare failure.
 */
export function unreachableReason(
  name: string,
  opts: { registry: Teammate[]; presentHere: string[] },
): UnreachableReason {
  const teammate = findTeammate(opts.registry, name);
  if (!teammate) return 'unknown';
  return isPresentHere(teammate, opts.presentHere) ? 'unknown' : 'not-here';
}

/**
 * Compose the message body for a handoff: the mention plus the text, nothing
 * else. Code owns the mention because it is what wakes their session.
 *
 * No backlink any more. It existed for the channel route — "reply to me over
 * there" — and the handoff now always lands in the thread both bots are already
 * standing in, where a link to that same thread reads as the counterpart's
 * thread and sends the reply into a dead end.
 */
export function buildHandoffMessage(route: TeammateRoute, text: string): string {
  return `@${route.teammate.name} ${text}`;
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
