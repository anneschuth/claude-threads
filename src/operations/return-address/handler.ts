/**
 * Return-address delivery — the bot answers the requester, not the agent.
 *
 * Hooks (wired in session/lifecycle.ts and operations/events/handler.ts):
 * - captureReturnAddress(): on every incoming user message; if it carries a
 *   "reply to me in this thread: <permalink>" directive, resolve and store
 *   the target on the session.
 * - noteEvent(): synchronous bookkeeping — remembers the turn's final
 *   assistant message, and notices when the agent delivered to the target
 *   itself (then we stay out of the way).
 * - onTurnComplete(): (re)arms a quiescence timer on every `result`. When the
 *   session finally goes quiet, the bot posts the final message to the target.
 * - cancelReturnDelivery(): clears the timer when the session ends.
 *
 * Why the bot and not the agent: delivering is a tool call, and an agent deep
 * in a 40-minute review forgets to make it. Its answer then lives only in its
 * own thread and the requester never sees it. Prompts do not fix forgetting;
 * moving the responsibility into code does.
 */

import { createLogger } from '../../utils/logger.js';
import { createSessionLog } from '../../utils/session-log.js';
import { post } from '../post-helpers/index.js';
import type { Session } from '../../session/types.js';
import type { SessionContext } from '../session-context/index.js';
import type { ClaudeEvent } from '../../claude/cli.js';
import { findReturnAddressUrl } from './parser.js';
import {
  createReturnDeliveryState,
  type ReturnDeliveryState,
  type ReturnAddress,
} from './types.js';

const log = createLogger('return-addr');
const sessionLog = createSessionLog(log);

/**
 * How long the session must stay quiet before we deliver. Long enough that a
 * multi-turn task (agent works, arbiter nudges, agent continues) delivers once
 * at the end rather than after every turn; short enough that the requester
 * isn't left waiting.
 */
export const QUIESCENCE_MS = 90_000;

/** Effective quiescence delay — config override wins (tests use a tiny value). */
function quiescenceMs(ctx: SessionContext): number {
  return ctx.config.returnDeliveryQuiescenceMs ?? QUIESCENCE_MS;
}

/** Delivery attempts before giving up and telling the humans. */
export const MAX_DELIVERY_ATTEMPTS = 3;

/**
 * Tool names that post a message somewhere. Kept in sync in spirit with the
 * arbiter's list, but here it only decides "did the agent already answer the
 * requester itself" — a false negative just means we deliver a duplicate-ish
 * message, a false positive means the requester gets nothing. So this is
 * matched together with the root id, never on the name alone.
 */
const DELIVERY_TOOL_RE =
  /^(send_dm|send_message|post_message|post_in_thread|reply_in_thread|post_reply|create_post|post_to_channel|send_channel_message|send_direct_message)$/;

/** Input keys different MCP servers use for "the thread to post into". */
const ROOT_ID_KEYS = ['root_id', 'rootId', 'thread_ts', 'threadTs', 'thread_id', 'threadId', 'parent_id'];

/** Get (lazily creating) the return-delivery state for a session. */
export function getReturnDeliveryState(session: Session): ReturnDeliveryState {
  if (!session.returnDelivery) {
    session.returnDelivery = createReturnDeliveryState();
  }
  return session.returnDelivery;
}

function enabled(ctx: SessionContext): boolean {
  return ctx.config.returnDeliveryEnabled !== false;
}

/**
 * Persist only while the session is still registered — an async continuation
 * can outlive a !stop, and a late write would resurrect a killed session.
 */
function persistIfActive(session: Session, ctx: SessionContext): void {
  if (!ctx.state.sessions.has(session.sessionId)) return;
  ctx.ops.persistSession(session);
}

// ---------------------------------------------------------------------------
// Capture (on incoming user messages)
// ---------------------------------------------------------------------------

/**
 * Extract and resolve a reply-to address from an incoming message.
 * Fire-and-forget: never blocks message handling, failures are silent.
 */
export async function captureReturnAddress(
  session: Session,
  message: string,
  requester: string | undefined,
  ctx: SessionContext
): Promise<void> {
  if (!enabled(ctx)) return;

  const url = findReturnAddressUrl(message);
  if (!url) return;

  const platform = session.platform;
  if (!platform.resolveDeliveryTarget || !platform.deliverToThread) return;

  try {
    const target = await platform.resolveDeliveryTarget(url);
    if (!target) return;

    // Self-delivery guard: a link to THIS thread means "answer here", which
    // the session already does. Delivering would post our own answer back
    // into our own thread — noise at best, a feedback loop at worst.
    if (target.rootId === session.threadId) {
      log.debug(`Ignoring return address pointing at our own thread`);
      return;
    }

    const state = getReturnDeliveryState(session);
    if (state.address?.target.rootId === target.rootId) return; // unchanged

    const address: ReturnAddress = { target, requester: requester || 'there', permalink: url };
    state.address = address;
    state.attempts = 0;
    persistIfActive(session, ctx);
    sessionLog(session).info(
      `📬 Return address set: @${address.requester} → thread ${target.rootId.substring(0, 8)}`
    );
  } catch (err) {
    log.debug(`Return address resolution failed: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Event bookkeeping
// ---------------------------------------------------------------------------

/** Pull a thread root id out of an arbitrary tool input object. */
function extractRootId(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of ROOT_ID_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/**
 * Observe the event stream: remember the turn's final assistant message and
 * notice a delivery the agent made to our target itself.
 */
export function noteEvent(session: Session, event: ClaudeEvent): void {
  const state = getReturnDeliveryState(session);

  if (event.type === 'assistant') {
    const message = event.message as { content?: Array<{ type: string; text?: string }> } | undefined;
    // Join this message's text blocks; the LAST assistant message of the turn
    // is the answer. Earlier ones are running commentary between tool calls.
    const text = (message?.content ?? [])
      .filter((b) => b.type === 'text' && b.text?.trim())
      .map((b) => b.text as string)
      .join('\n\n')
      .trim();
    if (text) state.lastFinalText = text;
    return;
  }

  const targetRoot = state.address?.target.rootId;
  if (!targetRoot) return;

  if (event.type === 'tool_use') {
    const tool = event.tool_use as { id?: string; name?: string; input?: unknown } | undefined;
    if (!tool?.id || !tool.name) return;
    const shortName = tool.name.startsWith('mcp__')
      ? tool.name.split('__').slice(2).join('__')
      : tool.name;
    if (!DELIVERY_TOOL_RE.test(shortName)) return;
    if (extractRootId(tool.input) !== targetRoot) return;
    // Attempt only — a rejected post must not suppress our delivery.
    state.pendingAgentDeliveries.set(tool.id, targetRoot);
    return;
  }

  if (event.type === 'tool_result') {
    const result = event.tool_result as { tool_use_id?: string; is_error?: boolean } | undefined;
    if (!result?.tool_use_id) return;
    const rootId = state.pendingAgentDeliveries.get(result.tool_use_id);
    if (!rootId) return;
    state.pendingAgentDeliveries.delete(result.tool_use_id);
    if (result.is_error) return;
    if (!state.deliveredRootIds.includes(rootId)) {
      state.deliveredRootIds.push(rootId);
      sessionLog(session).info(`📬 Agent delivered to the requester itself — standing down`);
    }
  }
}

// ---------------------------------------------------------------------------
// Quiescence delivery
// ---------------------------------------------------------------------------

/** True when there is still an undelivered answer owed to a requester. */
export function deliveryPending(state: ReturnDeliveryState): boolean {
  const address = state.address;
  if (!address) return false;
  if (state.deliveredRootIds.includes(address.target.rootId)) return false;
  return true;
}

/**
 * Called on every `result` event: (re)arm the quiescence timer. Each turn
 * pushes the deadline out, so a task that runs for ten turns delivers once,
 * after the last one.
 */
export function onTurnComplete(session: Session, ctx: SessionContext): void {
  if (!enabled(ctx)) return;
  const state = getReturnDeliveryState(session);
  if (!deliveryPending(state)) return;

  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = undefined;
    void deliver(session, ctx).catch((err) => log.debug(`Return delivery failed: ${err}`));
  }, quiescenceMs(ctx));
  // Don't hold the process open just for a pending delivery.
  state.timer.unref?.();
}

/** Clear the pending timer — call when the session ends or is killed. */
export function cancelReturnDelivery(session: Session): void {
  const state = session.returnDelivery;
  if (state?.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }
}

/** Build the message posted into the requester's thread. */
export function buildDeliveryMessage(session: Session, address: ReturnAddress, text: string): string {
  const backLink = session.platform.getThreadLink(session.threadId);
  return (
    `@${address.requester} ${text}\n\n` +
    `---\nОтвечай мне в тред: ${backLink}`
  );
}

async function deliver(session: Session, ctx: SessionContext): Promise<void> {
  const state = getReturnDeliveryState(session);
  const address = state.address;

  if (!enabled(ctx) || !address) return;
  if (!deliveryPending(state)) return;
  // The session moved on (new work started) — re-arm rather than deliver a
  // half-finished answer; onTurnComplete will fire again.
  if (session.isProcessing) return;
  if (!ctx.state.sessions.has(session.sessionId)) return;

  const text = state.lastFinalText?.trim();
  if (!text) return;

  const platform = session.platform;
  if (!platform.deliverToThread) return;

  state.attempts++;
  try {
    await platform.deliverToThread(address.target, buildDeliveryMessage(session, address, text));
    state.deliveredRootIds.push(address.target.rootId);
    persistIfActive(session, ctx);
    sessionLog(session).info(`📬 Delivered the answer to @${address.requester}`);

    const fmt = platform.getFormatter();
    await post(
      session,
      'info',
      `📬 ${fmt.formatItalic(`Ответ доставлен в тред @${address.requester}`)}`
    );
  } catch (err) {
    persistIfActive(session, ctx);
    if (state.attempts < MAX_DELIVERY_ATTEMPTS) {
      sessionLog(session).warn(
        `📬 Delivery attempt ${state.attempts}/${MAX_DELIVERY_ATTEMPTS} failed, retrying: ${err}`
      );
      state.timer = setTimeout(() => {
        state.timer = undefined;
        void deliver(session, ctx).catch((e) => log.debug(`Return delivery retry failed: ${e}`));
      }, quiescenceMs(ctx));
      state.timer.unref?.();
      return;
    }
    sessionLog(session).warn(`📬 Gave up delivering to @${address.requester}: ${err}`);
    const fmt = platform.getFormatter();
    await post(
      session,
      'warning',
      `📬 ${fmt.formatBold('Не удалось доставить ответ')} в тред @${address.requester} ` +
      `(${MAX_DELIVERY_ATTEMPTS} попытки). Тред: ${address.permalink}`
    );
  }
}
