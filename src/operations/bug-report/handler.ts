/**
 * Bug Reporting Module
 *
 * Collects session context and creates GitHub issues for bug reports.
 * Supports both !bug command and bug reaction on error messages.
 */

import { execSync, execFileSync } from 'child_process';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Redactor } from '@redactpii/node';
import { coerce, lt } from 'semver';

// Create a single redactor instance with aggressive mode for enhanced PII detection
// Aggressive mode catches obfuscated patterns like "user [at] example [dot] com"
const piiRedactor = new Redactor({ aggressive: true });
import { VERSION } from '../../version.js';
import { getClaudeCliVersion } from '../../claude/version-check.js';
import { getLogFilePath, readRecentLogEntries, type LogEntry } from '../../persistence/thread-logger.js';
import type { Session } from '../../session/types.js';
import type { PlatformFile } from '../../platform/types.js';
import type { PendingBugReport } from '../executors/types.js';

// Re-export for external use via bug-report/index.ts
export type { PendingBugReport };

// =============================================================================
// Screenshots
// =============================================================================

/** First `gh` release with `gh issue create --attach`. */
const GH_MIN_ATTACH_VERSION = '2.99.0';

/** GitHub's limit for an image attached to an issue. */
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

/** Repository permissions that may attach a file, as `gh` itself checks them. */
const ATTACH_PERMISSIONS = ['ADMIN', 'MAINTAIN', 'WRITE'];

/**
 * Screenshots saved to disk for `gh issue create --attach`.
 */
export interface SavedScreenshots {
  paths: string[];
  /** How many could not be downloaded or written. */
  failed: number;
  cleanup: () => void;
}

/**
 * Split attached files into the screenshots that can go along with the issue
 * and a human-readable reason for each one that cannot.
 */
export function selectScreenshots(
  files: PlatformFile[],
  target: BugReportTarget
): { screenshots: PlatformFile[]; skipped: string[] } {
  const screenshots: PlatformFile[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (!file.mimeType.startsWith('image/')) {
      skipped.push(`${file.name}: not an image`);
    } else if (file.size > MAX_SCREENSHOT_BYTES) {
      skipped.push(`${file.name}: larger than 10 MB`);
    } else if (!target.canAttach) {
      skipped.push(`${file.name}: ${target.attachBlocker}`);
    } else {
      screenshots.push(file);
    }
  }

  return { screenshots, skipped };
}

/**
 * Download screenshots into a private temp directory.
 * Continues even if some downloads fail.
 *
 * Runs on approval, not at preview time: nothing leaves the chat platform
 * until someone has seen where it is going and said yes.
 */
export async function saveScreenshots(
  files: PlatformFile[],
  downloadFile: ((fileId: string) => Promise<Buffer>) | undefined
): Promise<SavedScreenshots> {
  if (files.length === 0) {
    return { paths: [], failed: 0, cleanup: () => {} };
  }

  const dir = mkdtempSync(join(tmpdir(), 'bug-screenshots-'));
  const paths: string[] = [];
  let failed = 0;

  for (const [index, file] of files.entries()) {
    try {
      if (!downloadFile) throw new Error('Platform cannot download files');
      const buffer = await downloadFile(file.id);
      // The name is ours: it goes on a command line, and `#` separates a path
      // from its alt text in `--attach`.
      const extension = (file.extension ?? file.mimeType.split('/')[1] ?? '').replace(/^\./, '').toLowerCase();
      const path = join(dir, `screenshot-${index + 1}.${/^[a-z0-9]+$/.test(extension) ? extension : 'png'}`);
      writeFileSync(path, buffer, { mode: 0o600 });
      paths.push(path);
    } catch {
      failed++;
    }
  }

  return {
    paths,
    failed,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    },
  };
}

/**
 * Note for the issue body when screenshots were shared but did not make it.
 */
function omittedScreenshotsNote(count: number): string {
  return `${count} screenshot(s) were shared in the chat thread but are not attached to this issue.`;
}

/**
 * Add the omitted-screenshots note to a body that has already been formatted.
 */
export function withOmittedScreenshots(body: string, count: number): string {
  return count > 0 ? `${body}\n\n${omittedScreenshotsNote(count)}` : body;
}

// =============================================================================
// Types
// =============================================================================

/**
 * Recent event for bug report context (circular buffer)
 */
export interface RecentEvent {
  type: string;
  timestamp: number;
  summary: string;
}

/**
 * Error context for bug reports triggered by error reaction
 */
export interface ErrorContext {
  postId: string;
  message: string;
  timestamp: Date;
}


/**
 * Bug report context - all information collected for the report
 */
export interface BugReportContext {
  // Environment
  version: string;
  claudeCliVersion: string | null;
  platform: string;
  platformType: string;
  nodeVersion: string;
  osVersion: string;

  // Session
  sessionId: string;
  claudeSessionId: string;
  workingDir: string;
  branch: string | null;
  worktreeBranch?: string;

  // Usage
  usageStats?: {
    model: string;
    contextPercent: number;
    cost: string;
  };

  // Recent activity
  recentEvents: RecentEvent[];

  // Audit log
  logFilePath?: string;
  recentLogEntries?: LogEntry[];

  // Error details (if triggered by error reaction)
  errorContext?: ErrorContext;
}

// =============================================================================
// Constants
// =============================================================================

/** Maximum number of recent events to track */
const MAX_RECENT_EVENTS = 10;

// =============================================================================
// Event Tracking
// =============================================================================

/**
 * Add an event to the session's recent events buffer.
 * Call this from events.ts for significant events.
 */
export function trackEvent(session: Session, type: string, summary: string): void {
  if (!session.recentEvents) {
    session.recentEvents = [];
  }

  session.recentEvents.push({
    type,
    timestamp: Date.now(),
    summary: summary.substring(0, 100), // Truncate long summaries
  });

  // Keep only last N events
  if (session.recentEvents.length > MAX_RECENT_EVENTS) {
    session.recentEvents.shift();
  }
}

/**
 * Get recent events from session for bug report.
 */
export function getRecentEvents(session: Session): RecentEvent[] {
  return session.recentEvents || [];
}

// =============================================================================
// Sanitization
// =============================================================================

/**
 * Sanitize paths to remove usernames and sensitive directories.
 * /Users/anne/project -> ~/project
 * /home/user/.config/tokens -> ~/.config/[REDACTED]
 */
export function sanitizePath(path: string): string {
  // Replace home directory patterns
  let sanitized = path
    .replace(/^\/Users\/[^/]+/, '~')
    .replace(/^\/home\/[^/]+/, '~')
    .replace(/^C:\\Users\\[^\\]+/i, '~');

  // Redact sensitive subdirectories
  sanitized = sanitized
    .replace(/\/(tokens?|secrets?|credentials?|\.env)/gi, '/[REDACTED]')
    .replace(/\\(tokens?|secrets?|credentials?|\.env)/gi, '\\[REDACTED]');

  return sanitized;
}

/**
 * Sanitize text to remove potential secrets and PII.
 *
 * Uses a two-layer approach:
 * 1. Custom regex patterns for technical secrets (API keys, tokens, etc.)
 * 2. @redactpii/node library for general PII (phone numbers, SSNs, credit cards, names)
 *
 * This hybrid approach ensures comprehensive coverage:
 * - Our patterns catch technical secrets that PII libraries may miss
 * - The PII library catches personal data that our patterns may miss
 */
export function sanitizeText(text: string): string {
  // Layer 1: Custom patterns for technical secrets
  let sanitized = text
    // Slack tokens
    .replace(/xoxb-[\w-]+/gi, '[SLACK_TOKEN]')
    .replace(/xoxp-[\w-]+/gi, '[SLACK_TOKEN]')
    .replace(/xapp-[\w-]+/gi, '[SLACK_TOKEN]')
    .replace(/xoxa-[\w-]+/gi, '[SLACK_TOKEN]')
    // GitHub tokens
    .replace(/ghp_[\w]+/gi, '[GITHUB_TOKEN]')
    .replace(/gho_[\w]+/gi, '[GITHUB_TOKEN]')
    .replace(/github_pat_[\w]+/gi, '[GITHUB_TOKEN]')
    // Stripe keys
    .replace(/sk_live_[\w]+/gi, '[STRIPE_KEY]')
    .replace(/sk_test_[\w]+/gi, '[STRIPE_KEY]')
    .replace(/pk_live_[\w]+/gi, '[STRIPE_KEY]')
    .replace(/pk_test_[\w]+/gi, '[STRIPE_KEY]')
    // AWS keys
    .replace(/AKIA[\w]{16}/g, '[AWS_KEY]')
    .replace(/aws_access_key_id\s*[=:]\s*['"]?[\w]+['"]?/gi, '[AWS_KEY]')
    .replace(/aws_secret_access_key\s*[=:]\s*['"]?[\w/+=]+['"]?/gi, '[AWS_SECRET]')
    // OpenAI / Anthropic API keys
    .replace(/sk-[a-zA-Z0-9]{20,}/g, '[API_KEY]')
    .replace(/sk-ant-[\w-]+/gi, '[ANTHROPIC_KEY]')
    // Bearer tokens
    .replace(/Bearer\s+[\w.-]+/gi, '[BEARER_TOKEN]')
    // Basic auth in URLs (user:pass@host)
    .replace(/:\/\/[^:]+:[^@]+@/g, '://[CREDENTIALS]@')
    // Note: Email addresses are handled by @redactpii/node (including obfuscated like "user [at] example [dot] com")
    // SSH private keys
    .replace(/-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g, '[SSH_PRIVATE_KEY]')
    // Database connection strings
    .replace(/(?:mongodb|postgres|mysql|redis):\/\/[^\s]+/gi, '[DATABASE_URL]')
    // Generic API keys (long alphanumeric strings that look like keys)
    .replace(/['"]?[a-zA-Z_]*(?:api[_-]?key|secret|token|password|credential|auth)['":]?\s*['"]?[\w-]{20,}['"]?/gi, '[REDACTED_KEY]')
    // JWT tokens (three base64 segments separated by dots)
    .replace(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g, '[JWT_TOKEN]')
    // Home directory paths
    .replace(/\/Users\/[\w.-]+/g, '~')
    .replace(/\/home\/[\w.-]+/g, '~')
    .replace(/C:\\Users\\[\w.-]+/gi, '~');

  // Layer 2: Use @redactpii/node for general PII (emails, phones, SSNs, credit cards, names)
  // This catches patterns our regex might miss, including obfuscated formats
  try {
    sanitized = piiRedactor.redact(sanitized);
  } catch {
    // If redaction fails for any reason, continue with what we have
    // This ensures we don't lose data due to library issues
  }

  return sanitized;
}

// =============================================================================
// Context Collection
// =============================================================================

/**
 * Get current git branch from working directory
 */
async function getCurrentBranch(workingDir: string): Promise<string | null> {
  try {
    const output = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: workingDir,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

/** Number of recent log entries to include in bug reports */
const BUG_REPORT_LOG_ENTRIES = 50;

/**
 * Collect all context needed for a bug report.
 */
export async function collectBugReportContext(
  session: Session,
  errorContext?: ErrorContext
): Promise<BugReportContext> {
  const branch = await getCurrentBranch(session.workingDir);

  // Format usage stats if available
  let usageStats: BugReportContext['usageStats'] | undefined;
  if (session.usageStats) {
    const stats = session.usageStats;
    const contextPercent = stats.contextWindowSize > 0
      ? Math.round((stats.contextTokens / stats.contextWindowSize) * 100)
      : 0;
    usageStats = {
      model: stats.modelDisplayName || stats.primaryModel,
      contextPercent,
      cost: stats.totalCostUSD.toFixed(2),
    };
  }

  // Get log file path and recent entries
  // Use sessionId (not threadId) to match where ThreadLogger stores logs
  const platformId = session.platformId;
  const sessionId = session.claudeSessionId;
  const logFilePath = sanitizePath(getLogFilePath(platformId, sessionId));
  const recentLogEntries = readRecentLogEntries(platformId, sessionId, BUG_REPORT_LOG_ENTRIES);

  return {
    // Environment
    version: VERSION,
    claudeCliVersion: getClaudeCliVersion().version ?? 'unknown',
    platform: session.platform.displayName,
    platformType: session.platform.platformType,
    nodeVersion: process.version,
    osVersion: `${process.platform} ${process.arch}`,

    // Session
    sessionId: session.sessionId,
    claudeSessionId: session.claudeSessionId,
    workingDir: sanitizePath(session.workingDir),
    branch,
    worktreeBranch: session.worktreeInfo?.branch,

    // Usage
    usageStats,

    // Recent activity
    recentEvents: getRecentEvents(session),

    // Audit log
    logFilePath,
    recentLogEntries,

    // Error context
    errorContext,
  };
}

// =============================================================================
// Issue Formatting
// =============================================================================

/**
 * Generate issue title from user description.
 * Truncates and cleans for use as GitHub issue title.
 */
export function generateIssueTitle(description: string): string {
  // Clean up the description
  let title = description
    .replace(/\s+/g, ' ')  // Normalize whitespace
    .trim();

  // Truncate to reasonable length for a title
  if (title.length > 80) {
    title = title.substring(0, 77) + '...';
  }

  return title;
}

/**
 * Format recent events as a readable log
 */
function formatRecentEvents(events: RecentEvent[]): string {
  if (events.length === 0) {
    return '_No recent events_';
  }

  return events
    .map(e => {
      const time = new Date(e.timestamp).toISOString().substring(11, 19);
      return `[${time}] ${e.type}: ${sanitizeText(e.summary)}`;
    })
    .join('\n');
}

/**
 * Anonymizer for usernames in bug reports.
 * Maps real usernames to generic labels (User1, User2, etc.)
 */
class UsernameAnonymizer {
  private usernameMap = new Map<string, string>();
  private counter = 0;

  anonymize(username: string | undefined): string {
    if (!username) return '[unknown]';

    const existing = this.usernameMap.get(username);
    if (existing) {
      return existing;
    }
    this.counter++;
    const anonymized = `User${this.counter}`;
    this.usernameMap.set(username, anonymized);
    return anonymized;
  }
}

/**
 * Format log entries for bug report (summarized and anonymized view)
 * - Usernames are replaced with User1, User2, etc.
 * - User message content is redacted (only shows "[message]")
 * - Command arguments that might contain usernames are anonymized
 */
function formatLogEntries(entries: LogEntry[]): string {
  if (entries.length === 0) {
    return '_No log entries available_';
  }

  const anonymizer = new UsernameAnonymizer();

  return entries
    .map(entry => {
      const time = new Date(entry.ts).toISOString().substring(11, 19);
      let summary: string;

      switch (entry.type) {
        case 'lifecycle':
          summary = `lifecycle:${entry.action}${entry.username ? ` by ${anonymizer.anonymize(entry.username)}` : ''}`;
          break;
        case 'user_message': {
          // Show sanitized preview of message (first 50 chars) - secrets are redacted by sanitizeText
          const msgPreview = entry.message
            ? sanitizeText(entry.message.slice(0, 50)) + (entry.message.length > 50 ? '...' : '')
            : '[empty]';
          summary = `${anonymizer.anonymize(entry.username)}: ${msgPreview}`;
          break;
        }
        case 'command': {
          // Anonymize usernames in command args (e.g., !invite @user, !kick @user)
          let args = entry.args || '';
          if (entry.command === 'invite' || entry.command === 'kick') {
            // The arg is a username - anonymize it
            args = args ? anonymizer.anonymize(args.replace('@', '')) : '';
          } else if (entry.command === 'cd') {
            // Sanitize paths
            args = args ? sanitizePath(args) : '';
          }
          summary = `command: !${entry.command}${args ? ' ' + args : ''} by ${anonymizer.anonymize(entry.username)}`;
          break;
        }
        case 'permission':
          summary = `permission:${entry.action}${entry.permission ? ` (${sanitizePath(entry.permission)})` : ''}${entry.username ? ` by ${anonymizer.anonymize(entry.username)}` : ''}`;
          break;
        case 'reaction':
          summary = `reaction:${entry.action} by ${anonymizer.anonymize(entry.username)}${entry.emoji ? ` (${entry.emoji})` : ''}`;
          break;
        case 'claude_event': {
          const eventType = entry.eventType;
          if (eventType === 'assistant') {
            // Show content type and size, but not actual content (could contain sensitive data)
            const msg = entry.event as { message?: { content?: Array<{ type: string; text?: string; name?: string; thinking?: string }> } };
            const content = msg.message?.content?.[0];
            if (content?.type === 'text') {
              const len = content.text?.length || 0;
              summary = `text (${len} chars)`;
            } else if (content?.type === 'tool_use') {
              // Show tool name (arguments could contain sensitive data)
              summary = `tool_use: ${content.name}`;
            } else if (content?.type === 'thinking') {
              const len = content.thinking?.length || 0;
              summary = `thinking (${len} chars)`;
            } else {
              summary = `assistant: [${content?.type || 'response'}]`;
            }
          } else if (eventType === 'user') {
            // Tool results - show status but not content
            const toolResult = entry.event as { message?: { content?: Array<{ type: string; is_error?: boolean }> } };
            const content = toolResult.message?.content?.[0];
            if (content?.is_error) {
              summary = `tool_result: error`;
            } else {
              summary = `tool_result: ok`;
            }
          } else if (eventType === 'system') {
            const sysEvent = entry.event as { subtype?: string };
            summary = `system: ${sysEvent.subtype || 'init'}`;
          } else if (eventType === 'result') {
            const resultEvent = entry.event as { cost_usd?: number; duration_ms?: number };
            const cost = resultEvent.cost_usd ? `$${resultEvent.cost_usd.toFixed(3)}` : '';
            const duration = resultEvent.duration_ms ? `${Math.round(resultEvent.duration_ms / 1000)}s` : '';
            summary = `result: completed${cost ? ` ${cost}` : ''}${duration ? ` [${duration}]` : ''}`;
          } else {
            summary = `claude: ${eventType}`;
          }
          break;
        }
        default: {
          // Exhaustive check - this handles any future log entry types
          const unknownEntry = entry as { type: string };
          summary = `${unknownEntry.type}`;
        }
      }

      return `[${time}] ${summary}`;
    })
    .join('\n');
}

/**
 * Format the bug report as a GitHub issue body.
 */
export function formatIssueBody(
  context: BugReportContext,
  userDescription: string,
  omittedScreenshots = 0
): string {
  const sections: string[] = [];

  // Description
  sections.push(`## Description\n\n${sanitizeText(userDescription)}`);

  // Attached screenshots are added by `gh` itself; only the ones left behind
  // need a mention, or the reader cannot know they exist.
  if (omittedScreenshots > 0) {
    sections.push(`## Screenshots\n\n${omittedScreenshotsNote(omittedScreenshots)}`);
  }

  // Environment table
  sections.push(`## Environment

| Property | Value |
|----------|-------|
| claude-threads | v${context.version} |
| Claude CLI | ${context.claudeCliVersion || 'unknown'} |
| Platform | ${context.platformType} (${context.platform}) |
| Node.js | ${context.nodeVersion} |
| OS | ${context.osVersion} |`);

  // Session context table
  sections.push(`## Session Context

| Property | Value |
|----------|-------|
| Session ID | \`${context.claudeSessionId.substring(0, 8)}\` |
| Working Dir | \`${context.workingDir}\` |
| Branch | ${context.branch || 'N/A'} |
| Worktree | ${context.worktreeBranch || 'N/A'} |
| Log File | \`${context.logFilePath || 'N/A'}\` |`);

  // Usage stats if available
  if (context.usageStats) {
    sections.push(`## Usage Stats

- **Model:** ${context.usageStats.model}
- **Context:** ${context.usageStats.contextPercent}%
- **Cost:** $${context.usageStats.cost}`);
  }

  // Recent events (in-memory buffer)
  sections.push(`## Recent Events (In-Memory)

\`\`\`
${formatRecentEvents(context.recentEvents)}
\`\`\``);

  // Audit log entries (from disk)
  if (context.recentLogEntries && context.recentLogEntries.length > 0) {
    sections.push(`## Audit Log (Last ${context.recentLogEntries.length} entries)

<details>
<summary>Click to expand log entries</summary>

\`\`\`
${formatLogEntries(context.recentLogEntries)}
\`\`\`

</details>`);
  }

  // Error details if present
  if (context.errorContext) {
    sections.push(`## Error Details

**Error message:**
\`\`\`
${sanitizeText(context.errorContext.message)}
\`\`\`

**Occurred at:** ${context.errorContext.timestamp.toISOString()}`);
  }

  // Footer
  sections.push('---\n_Reported via claude-threads bug report feature_');

  return sections.join('\n\n');
}

// =============================================================================
// Issue Creation
// =============================================================================

type GhOptions = {
  cwd?: string;
  encoding: 'utf-8';
  timeout: number;
  stdio: ['pipe', 'pipe', 'pipe'];
};

/**
 * Runs `gh` with an argument list and returns its stdout.
 *
 * An argument list rather than a command string: the title comes from whatever
 * someone typed after `!bug`, and in a shell string `$(...)` runs on this host.
 */
export type GhExec = (args: string[], options: GhOptions) => string;

const runGh: GhExec = (args, options) => execFileSync('gh', args, options);

const GH_CHECK_OPTIONS: GhOptions = {
  encoding: 'utf-8',
  timeout: 5000,
  stdio: ['pipe', 'pipe', 'pipe'],
};

/**
 * Check if GitHub CLI is installed and authenticated.
 *
 * `exec` is injectable so tests don't spawn real `gh` processes — the two
 * subprocess calls each carry a 5s timeout, which overruns bun's 5s per-test
 * budget on a slow CI runner (seen as a flaky timeout on main).
 */
export function checkGitHubCli(
  exec: GhExec = runGh
): { installed: boolean; authenticated: boolean; error?: string } {
  try {
    // Check if gh is installed
    exec(['--version'], GH_CHECK_OPTIONS);
  } catch {
    return {
      installed: false,
      authenticated: false,
      error: 'GitHub CLI not installed. Install it with: `brew install gh` or see https://cli.github.com',
    };
  }

  try {
    // Check if authenticated
    exec(['auth', 'status'], GH_CHECK_OPTIONS);
  } catch {
    return {
      installed: true,
      authenticated: false,
      error: 'Not logged into GitHub CLI. Run `gh auth login` to authenticate.',
    };
  }

  return { installed: true, authenticated: true };
}

/**
 * What the preview tells the reporter about where a report is going.
 */
export interface BugReportTarget {
  repo: string;
  /** Assumed true when GitHub cannot be asked: it is the warning that matters. */
  isPublic: boolean;
  canAttach: boolean;
  /** Why screenshots cannot be attached, when `canAttach` is false. */
  attachBlocker?: string;
}

/**
 * Look up the report target and whether this `gh` login can attach to it.
 *
 * Attaching needs write access. A reporter filing on someone else's repository
 * does not have it, so without this check the preview would promise screenshots
 * that `gh` then refuses.
 */
export function inspectBugReportTarget(repo: string, exec: GhExec = runGh): BugReportTarget {
  let visibility: string | undefined;
  let viewerPermission: string | undefined;

  try {
    const info = JSON.parse(exec(['repo', 'view', repo, '--json', 'viewerPermission,visibility'], GH_CHECK_OPTIONS));
    visibility = info.visibility;
    viewerPermission = info.viewerPermission;
  } catch {
    return { repo, isPublic: true, canAttach: false, attachBlocker: `could not read ${repo}` };
  }

  const isPublic = visibility !== 'PRIVATE' && visibility !== 'INTERNAL';

  // Empty for a GitHub App installation, which `gh` leaves to the endpoint too.
  if (viewerPermission && !ATTACH_PERMISSIONS.includes(viewerPermission)) {
    return { repo, isPublic, canAttach: false, attachBlocker: `attaching needs write access to ${repo}` };
  }

  let ghVersion: ReturnType<typeof coerce> = null;
  try {
    ghVersion = coerce(exec(['--version'], GH_CHECK_OPTIONS));
  } catch {
    // Unknown version: try the upload, createGitHubIssue recovers if it fails.
  }
  if (ghVersion && lt(ghVersion, GH_MIN_ATTACH_VERSION)) {
    return { repo, isPublic, canAttach: false, attachBlocker: `attaching needs gh ${GH_MIN_ATTACH_VERSION} or newer` };
  }

  return { repo, isPublic, canAttach: true };
}

/**
 * Result of filing an issue.
 */
export interface CreatedIssue {
  url: string;
  /** The issue exists, but not every screenshot made it onto it. */
  attachmentsIncomplete: boolean;
}

/**
 * Create a GitHub issue using the gh CLI.
 * Returns the issue URL on success, throws on failure.
 *
 * Failing to attach never costs the report. `gh` refuses before it creates
 * anything when it cannot upload at all (old version, no write access), so the
 * issue is then filed without screenshots. If an upload dies halfway the issue
 * already exists and `gh` exits non-zero with its URL on stdout; filing again
 * there would duplicate it.
 *
 * `exec` is injectable for the same reason it is on `checkGitHubCli`, and for
 * a sharper one: without it this function cannot be exercised at all without
 * filing a real issue on the real repository. The `bugReports: false` gate
 * above it can only be proven load-bearing by removing it and watching a test
 * go red — and with a hardcoded `execSync` that mutation posts publicly.
 * It did, three times in one afternoon (#581, #582, #583), which is what
 * #586 is about. Tests must pass a stub.
 */
export async function createGitHubIssue(
  title: string,
  body: string,
  workingDir: string,
  options: { repo: string; attachments?: string[]; exec?: GhExec }
): Promise<CreatedIssue> {
  const { repo, attachments = [], exec = runGh } = options;

  // Check gh CLI first, through the same injected command: a caller that
  // stubs the subprocess is stubbing the whole `gh` dependency, so the test
  // does not also depend on a real authenticated CLI on the runner.
  const ghStatus = checkGitHubCli(exec);
  if (!ghStatus.installed || !ghStatus.authenticated) {
    throw new Error(ghStatus.error);
  }

  // Write body to temp file: it is long and full of markdown
  const bodyFile = join(tmpdir(), `bug-body-${Date.now()}.md`);

  const create = (issueBody: string, paths: string[]): string => {
    writeFileSync(bodyFile, issueBody, 'utf-8');
    return exec(
      [
        'issue', 'create',
        '--repo', repo,
        '--title', title,
        '--body-file', bodyFile,
        ...paths.flatMap((path, index) => ['--attach', `${path}#Screenshot ${index + 1}`]),
      ],
      {
        cwd: workingDir,
        encoding: 'utf-8',
        timeout: paths.length > 0 ? 120000 : 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    ).trim();
  };

  try {
    try {
      return { url: create(body, attachments), attachmentsIncomplete: false };
    } catch (err) {
      if (attachments.length === 0) throw err;

      const failure = err as { stdout?: unknown; code?: unknown };
      const url = String(failure.stdout ?? '').match(/https:\/\/\S+\/issues\/\d+/)?.[0];
      if (url) return { url, attachmentsIncomplete: true };

      // Killed mid-run: the issue may exist, so filing again could duplicate it.
      if (failure.code === 'ETIMEDOUT') throw err;

      return {
        url: create(withOmittedScreenshots(body, attachments.length), []),
        attachmentsIncomplete: true,
      };
    }
  } finally {
    // Clean up temp file
    try {
      unlinkSync(bodyFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Format a preview of the bug report for user approval
 */
export function formatBugPreview(
  title: string,
  description: string,
  context: BugReportContext,
  target: BugReportTarget,
  screenshotCount: number,
  skippedScreenshots: string[],
  formatter: {
    formatBold: (text: string) => string;
    formatCode: (text: string) => string;
    formatBlockquote: (text: string) => string;
    formatListItem: (text: string) => string;
  }
): string {
  const lines: string[] = [];

  lines.push(`${formatter.formatBold('Bug Report Preview')}`);
  lines.push('');
  lines.push(`${formatter.formatBold('Title:')} ${title}`);
  lines.push('');
  lines.push(formatter.formatBlockquote(description));
  lines.push('');
  lines.push(formatter.formatBold('Environment:'));
  lines.push(formatter.formatListItem(`claude-threads v${context.version}`));
  lines.push(formatter.formatListItem(`Claude CLI ${context.claudeCliVersion || 'unknown'}`));
  lines.push(formatter.formatListItem(`Platform: ${context.platformType}`));
  lines.push(formatter.formatListItem(`Branch: ${context.branch || 'N/A'}`));

  if (context.usageStats) {
    lines.push('');
    lines.push(formatter.formatBold('Usage:'));
    lines.push(formatter.formatListItem(`Model: ${context.usageStats.model}`));
    lines.push(formatter.formatListItem(`Context: ${context.usageStats.contextPercent}%`));
  }

  if (context.recentEvents.length > 0) {
    lines.push('');
    lines.push(formatter.formatBold(`Recent Events (${context.recentEvents.length}):`));
    const lastFew = context.recentEvents.slice(-3);
    for (const event of lastFew) {
      lines.push(formatter.formatListItem(`${event.type}: ${event.summary.substring(0, 40)}...`));
    }
  }

  // What leaves this machine, and where it goes (#577)
  lines.push('');
  lines.push(formatter.formatBold('Destination:'));
  lines.push(formatter.formatListItem(
    `Issue on ${formatter.formatCode(target.repo)}${target.isPublic ? ' (public: anyone can read it)' : ''}`
  ));

  if (screenshotCount > 0 || skippedScreenshots.length > 0) {
    lines.push('');
    lines.push(formatter.formatBold('Screenshots:'));
    if (screenshotCount > 0) {
      lines.push(formatter.formatListItem(`📎 ${screenshotCount} image(s) will be attached when you approve`));
      if (target.isPublic) {
        lines.push(formatter.formatListItem(
          '⚠️ Attachments on a public repository stay online permanently, even if the issue is deleted. Check them for personal data first.'
        ));
      }
    }
    if (skippedScreenshots.length > 0) {
      lines.push(formatter.formatListItem(
        `⚠️ ${skippedScreenshots.length} image(s) not attached (${skippedScreenshots[0]}). Add them to the issue by hand if needed.`
      ));
    }
  }

  lines.push('');
  lines.push(`React ${formatter.formatCode('👍')} to create GitHub issue or ${formatter.formatCode('👎')} to cancel`);

  return lines.join('\n');
}
