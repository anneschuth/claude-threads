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
import { VERSION } from '../version.js';
import { getClaudeCliVersion } from '../claude/version-check.js';
import type { Session } from './types.js';
import type { PlatformFile } from '../platform/types.js';

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
 * Pending bug report awaiting user approval
 */
export interface PendingBugReport {
  postId: string;
  title: string;
  body: string;
  userDescription: string;
  /** URLs of uploaded images (to Catbox.moe) */
  imageUrls: string[];
  /** Upload errors for any failed images */
  imageErrors: string[];
  errorContext?: ErrorContext;
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
 * Sanitize text to remove potential secrets.
 * - API keys (sk_..., xoxb-..., ghp_..., etc.)
 * - Tokens
 * - Full paths with usernames
 */
export function sanitizeText(text: string): string {
  return text
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
    // Generic API keys (long alphanumeric strings that look like keys)
    .replace(/['"]?[a-zA-Z_]*(?:api[_-]?key|secret|token|password|credential)['":]?\s*['"]?[\w-]{20,}['"]?/gi, '[REDACTED_KEY]')
    // Home directory paths
    .replace(/\/Users\/[\w.-]+/g, '~')
    .replace(/\/home\/[\w.-]+/g, '~')
    .replace(/C:\\Users\\[\w.-]+/gi, '~');
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

  return {
    // Environment
    version: VERSION,
    claudeCliVersion: getClaudeCliVersion(),
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
| Worktree | ${context.worktreeBranch || 'N/A'} |`);

  // Usage stats if available
  if (context.usageStats) {
    sections.push(`## Usage Stats

- **Model:** ${context.usageStats.model}
- **Context:** ${context.usageStats.contextPercent}%
- **Cost:** $${context.usageStats.cost}`);
  }

  // Recent events
  sections.push(`## Recent Events

\`\`\`
${formatRecentEvents(context.recentEvents)}
\`\`\``);

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
