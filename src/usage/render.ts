/**
 * Rendering for `!usage` — the three quota windows Claude Code itself shows:
 * the five-hour session, the weekly all-models limit, and the weekly limit
 * scoped to one model.
 *
 * ⚠️ The scoped weekly limit is a SEPARATE bucket from the all-models one. A
 * seat can read 62% overall while sitting at 100% on its model-scoped week, so
 * both rows are always shown — reporting only the headline tells you that you
 * have headroom when you have none.
 */

export type UsageLimitKind = 'session' | 'weekly_all' | 'weekly_scoped';

export interface UsageLimit {
  kind: UsageLimitKind;
  /** Whole percent of the window consumed, as the API reports it. */
  percent: number;
  resetsAt: Date;
  /** Display name of the scoped model, for `weekly_scoped` only. */
  model?: string;
}

export interface ProfileUsage {
  profile: string;
  /**
   * The account this profile is logged in as. Shown in full: with several
   * seats on one machine the directory name says nothing about WHICH account
   * it is, and a partial address answers the question no better than none.
   */
  email?: string;
  /** Plan badge, e.g. "Max 20×" — which seat is four times the other matters. */
  plan?: string;
  limits?: UsageLimit[];
  /** Set instead of `limits` when this profile could not be read. */
  error?: string;
}

export interface RenderOptions {
  now?: Date;
  /** IANA zone; defaults to the host's. */
  timeZone?: string;
  barWidth?: number;
}

const DEFAULT_BAR_WIDTH = 24;
/** Fixed order, so two profiles are always comparable line by line. */
const KIND_ORDER: UsageLimitKind[] = ['session', 'weekly_all', 'weekly_scoped'];

function heading(limit: UsageLimit): string {
  switch (limit.kind) {
    case 'session':
      return 'Current session';
    case 'weekly_all':
      return 'Current week (all models)';
    case 'weekly_scoped':
      return `Current week (${limit.model ?? 'scoped'})`;
  }
}

/**
 * A bar that never lies at the edges: any non-zero usage shows at least one
 * filled cell, and anything short of 100% leaves at least one empty cell.
 * Plain rounding would render 1% as empty and 99% as full.
 */
export function bar(percent: number, width = DEFAULT_BAR_WIDTH): string {
  const clamped = Math.max(0, Math.min(100, percent));
  let filled = Math.round((clamped / 100) * width);
  if (clamped > 0 && filled === 0) filled = 1;
  if (clamped < 100 && filled === width) filled = width - 1;
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function parts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return out;
}

/**
 * "11:50pm" when the window resets later the same local day, "Sep 2 at 3am"
 * otherwise — a bare time on a different day is the kind of thing that reads
 * fine and means the wrong day. Minutes are dropped when they are :00, which
 * is what the weekly windows almost always are.
 */
export function formatReset(resetsAt: Date, now: Date, timeZone: string): string {
  const at = parts(resetsAt, timeZone);
  const today = parts(now, timeZone);

  const minutes = at.minute === '00' ? '' : `:${at.minute}`;
  const clock = `${at.hour}${minutes}${(at.dayPeriod ?? 'AM').toLowerCase()}`;

  const sameDay =
    at.year === today.year && at.month === today.month && at.day === today.day;

  return sameDay ? clock : `${at.month} ${at.day} at ${clock}`;
}

/** The three blocks for one profile, without any profile heading. */
export function renderUsage(limits: UsageLimit[], options: RenderOptions = {}): string {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const width = options.barWidth ?? DEFAULT_BAR_WIDTH;

  const ordered = KIND_ORDER.map((kind) => limits.find((l) => l.kind === kind)).filter(
    (l): l is UsageLimit => l !== undefined
  );

  return ordered
    .map((limit) =>
      [
        heading(limit),
        `${bar(limit.percent, width)} ${String(limit.percent).padStart(3)}% used`,
        `Resets ${formatReset(limit.resetsAt, now, timeZone)} (${timeZone})`,
      ].join('\n')
    )
    .join('\n\n');
}

/** One block per profile, failures included as failures. */
export function renderProfiles(profiles: ProfileUsage[], options: RenderOptions = {}): string {
  return profiles
    .map((p) => {
      // A profile that could not be read is reported, never dropped — a
      // missing row reads as "fine" and that is the one thing it is not.
      const body = p.error
        ? `⚠️ could not read usage: ${p.error}`
        : renderUsage(p.limits ?? [], options);
      // The email belongs on the failing rows too — "log in again" is useless
      // if you don't know which account you're logging in as.
      const detail = [p.email, p.plan].filter(Boolean).join(' · ');
      const header = detail ? `${p.profile} (${detail})` : p.profile;
      return `${header}\n${'─'.repeat(header.length)}\n${body}`;
    })
    .join('\n\n');
}
