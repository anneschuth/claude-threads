/**
 * Bug Reporting Module
 *
 * Collects session context and creates GitHub issues for bug reports.
 * Supports both !bug command and bug reaction on error messages.
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Redactor } from '@redactpii/node';

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
// Image Upload (Catbox.moe)
// =============================================================================

const CATBOX_API_URL = 'https://catbox.moe/user/api.php';

/**
 * Result of uploading an image to Catbox.moe
 */
export interface ImageUploadResult {
  success: boolean;
  url?: string;
  error?: string;
  originalFile: PlatformFile;
}

/**
 * Upload an image buffer to Catbox.moe for permanent hosting.
 * Returns the URL of the uploaded image.
 */
export async function uploadImageToCatbox(
  imageBuffer: Buffer,
  filename: string
): Promise<string> {
  // Create form data with the image
  // Convert Buffer to ArrayBuffer for Blob compatibility
  const arrayBuffer = imageBuffer.buffer.slice(
    imageBuffer.byteOffset,
    imageBuffer.byteOffset + imageBuffer.byteLength
  ) as ArrayBuffer;
  const formData = new FormData();
  formData.append('reqtype', 'fileupload');
  formData.append('fileToUpload', new Blob([arrayBuffer]), filename);

  const response = await fetch(CATBOX_API_URL, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Catbox upload failed: ${response.status} ${response.statusText}`);
  }

  const responseText = await response.text();

  // Catbox returns the URL directly as plain text on success
  // On error, it returns an error message
  if (responseText.startsWith('https://')) {
    return responseText.trim();
  }

  throw new Error(`Catbox upload failed: ${responseText}`);
}

/**
 * Upload multiple images and return results.
 * Continues even if some uploads fail.
 */
export async function uploadImages(
  files: PlatformFile[],
  downloadFile: (fileId: string) => Promise<Buffer>
): Promise<ImageUploadResult[]> {
  const results: ImageUploadResult[] = [];

  for (const file of files) {
    // Only process image files
    if (!file.mimeType.startsWith('image/')) {
      results.push({
        success: false,
        error: 'Not an image file',
        originalFile: file,
      });
      continue;
    }

    try {
      const buffer = await downloadFile(file.id);
      const url = await uploadImageToCatbox(buffer, file.name);
      results.push({
        success: true,
        url,
        originalFile: file,
      });
    } catch (err) {
      results.push({
        success: false,
        error: err instanceof Error ? err.message : String(err),
        originalFile: file,
      });
    }
  }

  return results;
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

/** GitHub repository for bug reports */
const GITHUB_REPO = 'anneschuth/claude-threads';

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

    if (!this.usernameMap.has(username)) {
      this.counter++;
      this.usernameMap.set(username, `User${this.counter}`);
    }
    return this.usernameMap.get(username)!;
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
  imageUrls: string[] = []
): string {
  const sections: string[] = [];

  // Description
  sections.push(`## Description\n\n${sanitizeText(userDescription)}`);

  // Screenshots/images if any
  if (imageUrls.length > 0) {
    const imageSection = imageUrls.map((url, i) =>
      `![Screenshot ${i + 1}](${url})`
    ).join('\n\n');
    sections.push(`## Screenshots\n\n${imageSection}`);
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

/**
 * Escape a string for use in shell commands
 */
function escapeShell(str: string): string {
  return str.replace(/"/g, '\\"');
}

/**
 * Check if GitHub CLI is installed and authenticated
 */
export function checkGitHubCli(): { installed: boolean; authenticated: boolean; error?: string } {
  try {
    // Check if gh is installed
    execSync('gh --version', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return {
      installed: false,
      authenticated: false,
      error: 'GitHub CLI not installed. Install it with: `brew install gh` or see https://cli.github.com',
    };
  }

  try {
    // Check if authenticated
    execSync('gh auth status', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
 * Create a GitHub issue using the gh CLI.
 * Returns the issue URL on success, throws on failure.
 *
 * Note: Images should be uploaded to Catbox.moe first and their URLs
 * embedded in the body markdown before calling this function.
 */
export async function createGitHubIssue(
  title: string,
  body: string,
  workingDir: string
): Promise<string> {
  // Check gh CLI first
  const ghStatus = checkGitHubCli();
  if (!ghStatus.installed || !ghStatus.authenticated) {
    throw new Error(ghStatus.error);
  }

  // Write body to temp file to avoid shell escaping issues
  const bodyFile = join(tmpdir(), `bug-body-${Date.now()}.md`);

  try {
    writeFileSync(bodyFile, body, 'utf-8');

    // Create the issue
    const cmd = `gh issue create --repo "${GITHUB_REPO}" --title "${escapeShell(title)}" --body-file "${bodyFile}"`;

    const result = execSync(cmd, {
      cwd: workingDir,
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return result.trim();
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
  imageUrls: string[],
  imageErrors: string[],
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

  // Show image upload status
  if (imageUrls.length > 0 || imageErrors.length > 0) {
    lines.push('');
    lines.push(formatter.formatBold('Screenshots:'));
    if (imageUrls.length > 0) {
      lines.push(formatter.formatListItem(`✅ ${imageUrls.length} image(s) uploaded successfully`));
    }
    if (imageErrors.length > 0) {
      lines.push(formatter.formatListItem(`⚠️ ${imageErrors.length} image(s) failed: ${imageErrors[0]}`));
    }
  }

  lines.push('');
  lines.push(`React ${formatter.formatCode('👍')} to create GitHub issue or ${formatter.formatCode('👎')} to cancel`);

  return lines.join('\n');
}
