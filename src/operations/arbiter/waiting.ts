/**
 * Arbiter — human-wait watchdog.
 *
 * The original arbiter deliberately stood down whenever a genuine interactive
 * prompt was pending: "a human should answer this". In a channel nobody is
 * watching, that is indistinguishable from the task dying. The fleet's most
 * common failure is exactly this — a bot finishes the work, asks
 * "Кинуть на ревью?", and the thread goes quiet forever.
 *
 * So the wait gets a clock. After `waitTimeoutMs` of no human:
 *  - a judge decides whether the prompt genuinely needs a person;
 *  - if it doesn't, the arbiter answers it (announced in the thread, and
 *    reversible — the humans can always say otherwise afterwards);
 *  - if it does, the humans get pinged, repeatedly, with backoff.
 *
 * Deciding wrongly costs a revert. Not deciding costs the whole task.
 */

import { quickQuery } from '../../claude/quick-query.js';
import { createLogger } from '../../utils/logger.js';
import { createSessionLog } from '../../utils/session-log.js';
import { post } from '../post-helpers/index.js';
import type { Session } from '../../session/types.js';
import type { SessionContext } from '../session-context/index.js';
import { getArbiterState } from './handler.js';
import type { ArbiterWaitingState, WaitingKind } from './types.js';

const log = createLogger('arbiter');
const sessionLog = createSessionLog(log);

/** How long a human gets before the arbiter steps in. */
export const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60_000;

/** Gap between escalation pings (doubles each time). */
export const DEFAULT_ESCALATE_INTERVAL_MS = 30 * 60_000;

/** Escalation pings before the arbiter stops nagging. */
export const DEFAULT_MAX_ESCALATIONS = 3;

/** Judge timeout — a bit longer than the Haiku checks, this one is Sonnet. */
const JUDGE_TIMEOUT_MS = 30_000;

/** Max prompt text fed to the judge. */
const MAX_PROMPT_TEXT = 1200;

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

interface WaitingPolicy {
  autoAnswer: boolean;
  waitTimeoutMs: number;
  escalateIntervalMs: number;
  maxEscalations: number;
  escalateTo?: string[];
  judgeModel: 'haiku' | 'sonnet' | 'opus';
}

export function resolvePolicy(ctx: SessionContext): WaitingPolicy {
  const p = ctx.config.arbiterPolicy ?? {};
  return {
    autoAnswer: p.autoAnswer !== false,
    waitTimeoutMs: p.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
    escalateIntervalMs: p.escalateIntervalMs ?? DEFAULT_ESCALATE_INTERVAL_MS,
    maxEscalations: p.maxEscalations ?? DEFAULT_MAX_ESCALATIONS,
    escalateTo: p.escalateTo,
    judgeModel: p.judgeModel ?? 'sonnet',
  };
}

// ---------------------------------------------------------------------------
// Detecting what we're waiting on
// ---------------------------------------------------------------------------

/** A prompt the session is currently parked on, if any. Exported for tests. */
export interface PendingPrompt {
  kind: WaitingKind;
  signature: string;
  /** Human-readable rendering of the prompt, fed to the judge and the ping. */
  text: string;
  /** Post to act on (question/approval kinds). */
  postId?: string;
  /** Options offered, for 'question'. */
  options?: Array<{ label: string; description: string }>;
}

/**
 * What, if anything, is this session waiting on a human for?
 * `stalledText` is the turn's final message when the stall check judged it
 * `wait_for_human` — there's no interactive prompt then, only prose.
 */
export function detectPendingPrompt(
  session: Session,
  stalledText?: string
): PendingPrompt | null {
  const mm = session.messageManager;

  const questionSet = mm?.getPendingQuestionSet?.();
  if (questionSet) {
    const current = questionSet.questions[questionSet.currentIndex];
    if (current && questionSet.currentPostId) {
      return {
        kind: 'question',
        // Index included: answering question 1 of 3 leaves us waiting on a
        // NEW prompt, which must restart the clock rather than inherit it.
        signature: `q:${questionSet.toolUseId}:${questionSet.currentIndex}`,
        text: `${current.header}: ${current.question}`,
        postId: questionSet.currentPostId,
        options: current.options,
      };
    }
  }

  const approval = mm?.getPendingApproval?.();
  if (approval) {
    return {
      kind: 'approval',
      signature: `a:${approval.postId}`,
      text: approval.type === 'plan'
        ? 'Агент ждёт одобрения плана.'
        : 'Агент ждёт одобрения действия.',
      postId: approval.postId,
    };
  }

  if (stalledText?.trim()) {
    return {
      kind: 'text',
      // Length + tail keeps the signature stable across identical re-asks
      // without storing the whole message.
      signature: `t:${stalledText.length}:${stalledText.slice(-64)}`,
      text: stalledText.slice(-MAX_PROMPT_TEXT),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Arming / disarming
// ---------------------------------------------------------------------------

/** Clear any pending wait timer. Call on session end. */
export function cancelWaiting(session: Session): void {
  const waiting = session.arbiter?.waiting;
  if (waiting?.timer) {
    clearTimeout(waiting.timer);
    waiting.timer = undefined;
  }
  if (session.arbiter) session.arbiter.waiting = undefined;
}

/**
 * Reconcile the waiting state after a turn: arm a timer for a new prompt,
 * leave an existing one alone, drop it when nothing is pending any more.
 */
export function noteWaiting(
  session: Session,
  ctx: SessionContext,
  stalledText: string | undefined
): void {
  if (ctx.config.arbiterEnabled === false) return;

  const state = getArbiterState(session);
  const prompt = detectPendingPrompt(session, stalledText);

  if (!prompt) {
    cancelWaiting(session);
    return;
  }

  const existing = state.waiting;
  if (existing && existing.signature === prompt.signature && existing.timer) {
    return; // already counting down on this exact prompt
  }

  cancelWaiting(session);

  const policy = resolvePolicy(ctx);
  const waiting: ArbiterWaitingState = {
    kind: prompt.kind,
    signature: prompt.signature,
    text: prompt.text,
    messageCountAtArm: session.messageCount,
    since: Date.now(),
    escalations: 0,
    autoAnswered: false,
  };
  waiting.timer = setTimeout(() => {
    waiting.timer = undefined;
    void resolveWaiting(session, ctx).catch((err) => log.debug(`Wait resolution failed: ${err}`));
  }, policy.waitTimeoutMs);
  waiting.timer.unref?.();

  state.waiting = waiting;
  sessionLog(session).info(
    `⚖️ Waiting on a human (${prompt.kind}) — arbiter steps in after ${Math.round(policy.waitTimeoutMs / 60000)}min`
  );
}

// ---------------------------------------------------------------------------
// The judge
// ---------------------------------------------------------------------------

/** Judge verdict: can the arbiter settle this without a human? */
export interface JudgeVerdict {
  decide: boolean;
  /** For 'question': index of the option to pick. */
  optionIndex?: number;
  /** For 'approval': whether to approve. */
  approve?: boolean;
  /** One-line justification, shown in the thread. */
  reason: string;
}

export function buildJudgePrompt(prompt: PendingPrompt, originalTask: string | undefined): string {
  const options = prompt.options
    ? prompt.options.map((o, i) => `${i}. ${o.label} — ${o.description}`).join('\n')
    : '(нет вариантов — это не выбор из списка)';

  return `An autonomous coding agent is blocked waiting for a human, and no human has responded. You decide whether this genuinely requires a person, or whether it is the agent being over-cautious about something it could just do.

Original task:
"""
${(originalTask ?? '(unknown)').substring(0, 600)}
"""

What the agent is asking:
"""
${prompt.text}
"""

Options offered:
${options}

Answer on the human's behalf ("decide": true) when the choice is routine and reversible: sending work for review, opening an MR, picking between technically equivalent options, continuing work already agreed on, applying an obvious fix, choosing the agent's own clearly-better recommendation.

Require a human ("decide": false) ONLY for: destructive or irreversible production actions, spending money, external communication on the company's behalf, missing access or credentials, or a genuine product decision whose cost of being wrong is high.

When in doubt about reversibility, require a human. Otherwise prefer deciding — the thread may be unattended, and a stalled task helps nobody.

Respond with ONLY a JSON object, no other text:
{"decide": true|false, "optionIndex": <0-based index, only for a list of options>, "approve": true|false, "reason": "<one short sentence, in Russian>"}`;
}

/** Parse the judge response. Exported for tests. */
export function parseJudgeVerdict(response: string, optionCount: number): JudgeVerdict | null {
  const match = response.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    if (typeof parsed.decide !== 'boolean') return null;

    const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
      ? parsed.reason.trim().substring(0, 200)
      : 'решение не требует человека';

    if (!parsed.decide) return { decide: false, reason };

    const verdict: JudgeVerdict = { decide: true, reason };
    if (typeof parsed.optionIndex === 'number' && Number.isInteger(parsed.optionIndex)) {
      // An out-of-range index would silently no-op in handleQuestionAnswer,
      // leaving the session parked with the clock already spent.
      if (optionCount > 0 && (parsed.optionIndex < 0 || parsed.optionIndex >= optionCount)) return null;
      verdict.optionIndex = parsed.optionIndex;
    }
    if (typeof parsed.approve === 'boolean') verdict.approve = parsed.approve;

    // Deciding a list of options without saying which one is not a decision.
    if (optionCount > 0 && verdict.optionIndex === undefined) return null;
    return verdict;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Still parked on the same prompt we armed the timer for? Exported for tests. */
export function stillWaitingOnSame(session: Session, waiting: ArbiterWaitingState): boolean {
  // Somebody spoke — human or teammate bot. Either way the wait is over.
  if (session.messageCount !== waiting.messageCountAtArm) return false;
  // The agent picked work back up (an arbiter nudge, a queued prompt).
  if (session.isProcessing) return false;

  // A prose stall has no interactive prompt to re-read; the two checks above
  // are all the evidence there is.
  if (waiting.kind === 'text') return true;

  return detectPendingPrompt(session)?.signature === waiting.signature;
}

async function resolveWaiting(session: Session, ctx: SessionContext): Promise<void> {
  const state = session.arbiter;
  const waiting = state?.waiting;
  if (!state || !waiting) return;
  if (ctx.config.arbiterEnabled === false) return;
  if (!ctx.state.sessions.has(session.sessionId)) return;
  if (!session.claude.isRunning()) return;

  if (!stillWaitingOnSame(session, waiting)) {
    sessionLog(session).info(`⚖️ Human answered while we waited — standing down`);
    cancelWaiting(session);
    return;
  }

  const policy = resolvePolicy(ctx);
  // Re-derive so we act on the live postId; fall back to the snapshot taken
  // when the wait was armed (the only source for a prose stall).
  const prompt: PendingPrompt = detectPendingPrompt(session) ?? {
    kind: waiting.kind,
    signature: waiting.signature,
    text: waiting.text,
  };

  // Judge once per prompt: neither the question nor the task changes between
  // escalation pings, so a re-run would buy the same verdict for another
  // Sonnet call.
  if (policy.autoAnswer && !waiting.autoAnswered && !waiting.judgedNeedsHuman) {
    const verdict = await judge(session, ctx, prompt, policy);
    if (verdict?.decide) {
      const applied = await applyDecision(session, ctx, prompt, verdict);
      if (applied) {
        waiting.autoAnswered = true;
        cancelWaiting(session);
        return;
      }
      // Couldn't apply it (the prompt moved under us) — fall through to a
      // ping, but let a later attempt re-judge against the new prompt.
    } else if (verdict) {
      waiting.judgedNeedsHuman = true;
    }
  }

  await escalate(session, ctx, prompt, waiting, policy);
}

async function judge(
  session: Session,
  ctx: SessionContext,
  prompt: PendingPrompt,
  policy: WaitingPolicy
): Promise<JudgeVerdict | null> {
  const result = await quickQuery({
    prompt: buildJudgePrompt(prompt, session.firstPrompt),
    model: policy.judgeModel,
    timeout: JUDGE_TIMEOUT_MS,
  });
  if (!result.success || !result.response) return null;
  const verdict = parseJudgeVerdict(result.response, prompt.options?.length ?? 0);
  if (!verdict) log.debug(`Unusable judge verdict for session ${session.sessionId}`);
  // The world may have moved while the judge thought.
  if (!ctx.state.sessions.has(session.sessionId)) return null;
  return verdict;
}

/**
 * Act on a "decide" verdict. Returns false when the decision couldn't be
 * applied, so the caller falls back to escalation instead of silently
 * leaving the session parked.
 */
async function applyDecision(
  session: Session,
  ctx: SessionContext,
  prompt: PendingPrompt,
  verdict: JudgeVerdict
): Promise<boolean> {
  const mm = session.messageManager;
  const fmt = session.platform.getFormatter();

  try {
    if (prompt.kind === 'question' && prompt.postId && verdict.optionIndex !== undefined) {
      const ok = await mm?.handleQuestionAnswer(prompt.postId, verdict.optionIndex);
      if (!ok) return false;
      const label = prompt.options?.[verdict.optionIndex]?.label ?? `вариант ${verdict.optionIndex + 1}`;
      await announce(session, `выбрал «${label}» — ${verdict.reason}`, fmt);
      sessionLog(session).info(`⚖️ Auto-answered a question: ${label}`);
      return true;
    }

    if (prompt.kind === 'approval' && prompt.postId) {
      const approve = verdict.approve !== false;
      const ok = await mm?.handleApprovalResponse(prompt.postId, approve);
      if (!ok) return false;
      await announce(session, `${approve ? 'одобрил' : 'отклонил'} — ${verdict.reason}`, fmt);
      sessionLog(session).info(`⚖️ Auto-${approve ? 'approved' : 'rejected'} a pending approval`);
      return true;
    }

    if (prompt.kind === 'text') {
      // No prompt to answer — tell the agent to proceed on its own judgement.
      session.claude.sendMessage(
        '[Arbiter] Никто не ответил в треде. Решение за тобой: действуй по своей же рекомендации и доводи задачу до конца. ' +
        'Останавливайся только если это необратимо, стоит денег или у тебя нет доступа.'
      );
      session.isProcessing = true;
      session.lastActivityAt = new Date();
      ctx.ops.startTyping(session);
      await announce(session, `никто не ответил — попросил агента действовать самому (${verdict.reason})`, fmt);
      sessionLog(session).info(`⚖️ Told the agent to proceed on its own judgement`);
      return true;
    }
  } catch (err) {
    log.debug(`Applying arbiter decision failed: ${err}`);
    return false;
  }
  return false;
}

/** Post the arbiter's decision in the thread — always reversible by a human. */
async function announce(
  session: Session,
  what: string,
  fmt: ReturnType<Session['platform']['getFormatter']>
): Promise<void> {
  await post(
    session,
    'info',
    `⚖️ ${fmt.formatBold('Арбитр решил за вас:')} ${what}\n` +
    `${fmt.formatItalic('Не согласны — напишите в тред, откатим.')}`
  );
}

/** Who to ping. Configured targets win; otherwise whoever started the session. */
export function escalationTargets(session: Session, policy: WaitingPolicy): string[] {
  const configured = policy.escalateTo?.filter((t) => t.trim());
  if (configured?.length) return configured;
  return session.startedBy ? [session.startedBy] : [];
}

async function escalate(
  session: Session,
  ctx: SessionContext,
  prompt: PendingPrompt,
  waiting: ArbiterWaitingState,
  policy: WaitingPolicy
): Promise<void> {
  if (waiting.escalations >= policy.maxEscalations) {
    sessionLog(session).warn(`⚖️ Stopped escalating after ${policy.maxEscalations} pings`);
    cancelWaiting(session);
    return;
  }

  waiting.escalations++;
  const mentions = escalationTargets(session, policy).map((t) => `@${t.replace(/^@/, '')}`).join(' ');
  const waitedMin = Math.round((Date.now() - waiting.since) / 60_000);
  const fmt = session.platform.getFormatter();

  await post(
    session,
    'warning',
    `🔔 ${mentions} ${fmt.formatBold('агент ждёт ответа')} уже ${waitedMin} мин:\n` +
    `> ${prompt.text.split('\n').join('\n> ')}\n` +
    `${fmt.formatItalic(`Пинг ${waiting.escalations}/${policy.maxEscalations}.`)}`
  );
  sessionLog(session).warn(
    `⚖️ Escalated to humans (${waiting.escalations}/${policy.maxEscalations}) after ${waitedMin}min`
  );

  // Back off: each ping waits twice as long as the previous gap.
  const delay = policy.escalateIntervalMs * Math.pow(2, waiting.escalations - 1);
  waiting.timer = setTimeout(() => {
    waiting.timer = undefined;
    void resolveWaiting(session, ctx).catch((err) => log.debug(`Wait re-check failed: ${err}`));
  }, delay);
  waiting.timer.unref?.();
}
