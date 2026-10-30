/**
 * Bug Report Module Tests
 */

import { describe, test, expect, mock } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'fs';
import {
  sanitizePath,
  sanitizeText,
  generateIssueTitle,
  formatIssueBody,
  trackEvent,
  getRecentEvents,
  formatBugPreview,
  checkGitHubCli,
  inspectBugReportTarget,
  createGitHubIssue,
  selectScreenshots,
  saveScreenshots,
  withOmittedScreenshots,
  type BugReportContext,
  type BugReportTarget,
  type GhExec,
  type RecentEvent,
} from './handler.js';
import type { Session } from '../../session/types.js';
import type { PlatformFile } from '../../platform/types.js';

// =============================================================================
// sanitizePath tests
// =============================================================================

describe('sanitizePath', () => {
  test('replaces /Users/username with ~', () => {
    expect(sanitizePath('/Users/anne/project')).toBe('~/project');
    expect(sanitizePath('/Users/john.doe/work/repo')).toBe('~/work/repo');
  });

  test('replaces /home/username with ~', () => {
    expect(sanitizePath('/home/anne/project')).toBe('~/project');
    expect(sanitizePath('/home/user123/code')).toBe('~/code');
  });

  test('replaces Windows paths', () => {
    // Windows paths get ~ but backslash to forward slash conversion happens separately
    expect(sanitizePath('C:\\Users\\Anne\\project')).toBe('~\\project');
  });

  test('redacts sensitive subdirectories', () => {
    // The 'tokens' directory is redacted but 'secret' in filename is also caught
    expect(sanitizePath('/Users/anne/tokens/config.json')).toBe('~/[REDACTED]/config.json');
    expect(sanitizePath('/home/user/credentials/key.pem')).toBe('~/[REDACTED]/key.pem');
    expect(sanitizePath('/var/secrets/api.key')).toBe('/var/[REDACTED]/api.key');
  });

  test('handles paths without home directory', () => {
    expect(sanitizePath('/var/log/app.log')).toBe('/var/log/app.log');
    expect(sanitizePath('/tmp/test')).toBe('/tmp/test');
  });
});

// =============================================================================
// sanitizeText tests
// =============================================================================

describe('sanitizeText', () => {
  test('redacts Slack tokens', () => {
    expect(sanitizeText('token: xoxb-123-456-abc')).toBe('token: [SLACK_TOKEN]');
    expect(sanitizeText('xoxp-test-token')).toBe('[SLACK_TOKEN]');
    expect(sanitizeText('xapp-1-abc123')).toBe('[SLACK_TOKEN]');
  });

  test('redacts GitHub tokens', () => {
    expect(sanitizeText('ghp_abc123xyz')).toBe('[GITHUB_TOKEN]');
    expect(sanitizeText('gho_organization_token')).toBe('[GITHUB_TOKEN]');
    expect(sanitizeText('github_pat_abc123')).toBe('[GITHUB_TOKEN]');
  });

  test('redacts Stripe keys', () => {
    expect(sanitizeText('sk_live_abc123')).toBe('[STRIPE_KEY]');
    expect(sanitizeText('sk_test_xyz789')).toBe('[STRIPE_KEY]');
    expect(sanitizeText('pk_live_abc123')).toBe('[STRIPE_KEY]');
  });

  test('redacts AWS keys', () => {
    expect(sanitizeText('AKIAIOSFODNN7EXAMPLE')).toBe('[AWS_KEY]');
  });

  test('replaces home directory paths in text', () => {
    expect(sanitizeText('Error in /Users/anne/project/file.ts')).toBe('Error in ~/project/file.ts');
    expect(sanitizeText('Path: /home/user/code')).toBe('Path: ~/code');
  });

  test('handles text without sensitive content', () => {
    expect(sanitizeText('Normal error message')).toBe('Normal error message');
    expect(sanitizeText('File not found: test.txt')).toBe('File not found: test.txt');
  });

  test('handles multiple sensitive items', () => {
    const text = 'Token xoxb-123 at /Users/anne/project/config';
    const result = sanitizeText(text);
    expect(result).toBe('Token [SLACK_TOKEN] at ~/project/config');
  });

  // Tests for @redactpii/node integration (PII redaction)
  test('redacts email addresses', () => {
    const result = sanitizeText('Contact me at john.doe@example.com');
    expect(result).not.toContain('john.doe@example.com');
    expect(result).toContain('EMAIL_ADDRESS'); // @redactpii format
  });

  test('redacts phone numbers', () => {
    const result = sanitizeText('Call me at (555) 123-4567');
    expect(result).not.toContain('555');
    expect(result).not.toContain('123-4567');
  });

  test('redacts credit card numbers', () => {
    const result = sanitizeText('Card: 4111-1111-1111-1111');
    expect(result).not.toContain('4111');
    expect(result).toContain('CREDIT_CARD'); // @redactpii format
  });

  test('redacts SSNs', () => {
    const result = sanitizeText('SSN: 123-45-6789');
    expect(result).not.toContain('123-45-6789');
  });

  test('redacts obfuscated emails in aggressive mode', () => {
    // Aggressive mode catches patterns like "user [at] example [dot] com"
    const result = sanitizeText('Email: user [at] example [dot] com');
    expect(result).not.toContain('user [at] example');
  });

  test('redacts names in greetings', () => {
    const result = sanitizeText('Hello John Smith, how can I help?');
    // Note: Name redaction may or may not trigger depending on pattern
    // The important thing is that if it contains a name pattern, it gets redacted
    expect(result).not.toMatch(/Hello\s+John\s+Smith/);
  });

  test('handles combined technical secrets and PII', () => {
    const text = 'API key sk-ant-12345 belongs to john@example.com at /Users/anne/project';
    const result = sanitizeText(text);
    expect(result).not.toContain('sk-ant-12345');
    expect(result).not.toContain('john@example.com');
    expect(result).not.toContain('/Users/anne');
    expect(result).toContain('[ANTHROPIC_KEY]');
    expect(result).toContain('EMAIL_ADDRESS');
    expect(result).toContain('~/project');
  });
});

// =============================================================================
// generateIssueTitle tests
// =============================================================================

describe('generateIssueTitle', () => {
  test('returns short descriptions unchanged', () => {
    expect(generateIssueTitle('Bug in login')).toBe('Bug in login');
    expect(generateIssueTitle('Session crashed')).toBe('Session crashed');
  });

  test('truncates long descriptions', () => {
    const longDesc = 'A'.repeat(100);
    const result = generateIssueTitle(longDesc);
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result.endsWith('...')).toBe(true);
  });

  test('normalizes whitespace', () => {
    expect(generateIssueTitle('Bug   with  spaces')).toBe('Bug with spaces');
    expect(generateIssueTitle('  trimmed  ')).toBe('trimmed');
  });
});

// =============================================================================
// trackEvent and getRecentEvents tests
// =============================================================================

describe('trackEvent', () => {
  test('adds events to session', () => {
    const session = { recentEvents: [] } as unknown as Session;

    trackEvent(session, 'tool_use', 'Read');
    expect(session.recentEvents.length).toBe(1);
    expect(session.recentEvents[0].type).toBe('tool_use');
    expect(session.recentEvents[0].summary).toBe('Read');
  });

  test('initializes recentEvents if undefined', () => {
    const session = {} as unknown as Session;

    trackEvent(session, 'error', 'Something failed');
    expect(session.recentEvents).toBeDefined();
    expect(session.recentEvents.length).toBe(1);
  });

  test('limits to 10 events', () => {
    const session = { recentEvents: [] } as unknown as Session;

    for (let i = 0; i < 15; i++) {
      trackEvent(session, 'tool_use', `Tool ${i}`);
    }

    expect(session.recentEvents.length).toBe(10);
    // Should have the most recent events (5-14)
    expect(session.recentEvents[0].summary).toBe('Tool 5');
    expect(session.recentEvents[9].summary).toBe('Tool 14');
  });

  test('truncates long summaries', () => {
    const session = { recentEvents: [] } as unknown as Session;
    const longSummary = 'A'.repeat(150);

    trackEvent(session, 'error', longSummary);
    expect(session.recentEvents[0].summary.length).toBe(100);
  });
});

describe('getRecentEvents', () => {
  test('returns events from session', () => {
    const events: RecentEvent[] = [
      { type: 'tool_use', timestamp: Date.now(), summary: 'Test' }
    ];
    const session = { recentEvents: events } as unknown as Session;

    expect(getRecentEvents(session)).toEqual(events);
  });

  test('returns empty array if no events', () => {
    const session = {} as unknown as Session;
    expect(getRecentEvents(session)).toEqual([]);
  });
});

// =============================================================================
// formatIssueBody tests
// =============================================================================

describe('formatIssueBody', () => {
  const mockContext: BugReportContext = {
    version: '0.49.0',
    claudeCliVersion: '2.0.76',
    platform: 'Test Platform',
    platformType: 'mattermost',
    nodeVersion: 'v20.0.0',
    osVersion: 'darwin arm64',
    sessionId: 'test:thread-123',
    claudeSessionId: 'uuid-12345678-abcd',
    workingDir: '~/project',
    branch: 'main',
    worktreeBranch: undefined,
    usageStats: {
      model: 'claude-sonnet-4-20250514',
      contextPercent: 25,
      cost: '0.05',
    },
    recentEvents: [
      { type: 'tool_use', timestamp: Date.now(), summary: 'Read' },
      { type: 'tool_use', timestamp: Date.now(), summary: 'Edit' },
    ],
    errorContext: undefined,
  };

  test('includes description section', () => {
    const body = formatIssueBody(mockContext, 'Test bug description');
    expect(body).toContain('## Description');
    expect(body).toContain('Test bug description');
  });

  test('includes environment section', () => {
    const body = formatIssueBody(mockContext, 'Test');
    expect(body).toContain('## Environment');
    expect(body).toContain('v0.49.0');
    expect(body).toContain('2.0.76');
    expect(body).toContain('mattermost');
  });

  test('includes session context section', () => {
    const body = formatIssueBody(mockContext, 'Test');
    expect(body).toContain('## Session Context');
    expect(body).toContain('uuid-123'); // First 8 chars of session ID
    expect(body).toContain('~/project');
    expect(body).toContain('main');
  });

  test('includes usage stats when available', () => {
    const body = formatIssueBody(mockContext, 'Test');
    expect(body).toContain('## Usage Stats');
    expect(body).toContain('claude-sonnet-4-20250514');
    expect(body).toContain('25%');
    expect(body).toContain('$0.05');
  });

  test('includes recent events', () => {
    const body = formatIssueBody(mockContext, 'Test');
    expect(body).toContain('## Recent Events');
    expect(body).toContain('tool_use');
    expect(body).toContain('Read');
  });

  test('includes error details when present', () => {
    const contextWithError: BugReportContext = {
      ...mockContext,
      errorContext: {
        postId: 'post-123',
        message: 'Permission denied: cannot write to file',
        timestamp: new Date('2024-01-01T12:00:00Z'),
      },
    };
    const body = formatIssueBody(contextWithError, 'Test');
    expect(body).toContain('## Error Details');
    expect(body).toContain('Permission denied');
  });

  test('sanitizes description text', () => {
    const body = formatIssueBody(mockContext, 'Error with xoxb-secret-token');
    expect(body).not.toContain('xoxb-secret-token');
    expect(body).toContain('[SLACK_TOKEN]');
  });

  test('includes footer', () => {
    const body = formatIssueBody(mockContext, 'Test');
    expect(body).toContain('Reported via claude-threads bug report feature');
  });
});

// =============================================================================
// formatBugPreview tests
// =============================================================================

describe('formatBugPreview', () => {
  const publicTarget: BugReportTarget = { repo: 'owner/public', isPublic: true, canAttach: true };
  const privateTarget: BugReportTarget = { repo: 'owner/private', isPublic: false, canAttach: true };

  const mockFormatter = {
    formatBold: (text: string) => `**${text}**`,
    formatCode: (text: string) => `\`${text}\``,
    formatBlockquote: (text: string) => `> ${text}`,
    formatListItem: (text: string) => `- ${text}`,
  };

  const mockContext: BugReportContext = {
    version: '0.49.0',
    claudeCliVersion: '2.0.76',
    platform: 'Test',
    platformType: 'mattermost',
    nodeVersion: 'v20.0.0',
    osVersion: 'darwin arm64',
    sessionId: 'test:thread',
    claudeSessionId: 'uuid-12345678',
    workingDir: '~/project',
    branch: 'main',
    recentEvents: [],
  };

  test('includes title', () => {
    const preview = formatBugPreview('Test title', 'Test desc', mockContext, publicTarget, 0, [], mockFormatter);
    expect(preview).toContain('**Title:**');
    expect(preview).toContain('Test title');
  });

  test('includes description as blockquote', () => {
    const preview = formatBugPreview('Title', 'Bug description', mockContext, publicTarget, 0, [], mockFormatter);
    expect(preview).toContain('> Bug description');
  });

  test('includes environment info', () => {
    const preview = formatBugPreview('Title', 'Desc', mockContext, publicTarget, 0, [], mockFormatter);
    expect(preview).toContain('v0.49.0');
    expect(preview).toContain('2.0.76');
    expect(preview).toContain('mattermost');
    expect(preview).toContain('main');
  });

  test('includes approval instructions', () => {
    const preview = formatBugPreview('Title', 'Desc', mockContext, publicTarget, 0, [], mockFormatter);
    expect(preview).toContain('👍');
    expect(preview).toContain('👎');
    expect(preview).toContain('GitHub issue');
    expect(preview).toContain('cancel');
  });

  test('names the destination and says when it is public', () => {
    const publicPreview = formatBugPreview('Title', 'Desc', mockContext, publicTarget, 0, [], mockFormatter);
    expect(publicPreview).toContain('`owner/public`');
    expect(publicPreview).toContain('public: anyone can read it');

    const privatePreview = formatBugPreview('Title', 'Desc', mockContext, privateTarget, 0, [], mockFormatter);
    expect(privatePreview).toContain('`owner/private`');
    expect(privatePreview).not.toContain('public');
  });

  test('warns that a screenshot on a public repo cannot be removed', () => {
    const preview = formatBugPreview('Title', 'Desc', mockContext, publicTarget, 1, [], mockFormatter);
    expect(preview).toContain('1 image(s) will be attached');
    expect(preview).toContain('stay online permanently');
  });

  test('does not warn about permanence on a private repo', () => {
    const preview = formatBugPreview('Title', 'Desc', mockContext, privateTarget, 1, [], mockFormatter);
    expect(preview).toContain('1 image(s) will be attached');
    expect(preview).not.toContain('stay online permanently');
  });

  test('says which images stay behind and why', () => {
    const preview = formatBugPreview('Title', 'Desc', mockContext, publicTarget, 0, ['a.png: larger than 10 MB'], mockFormatter);
    expect(preview).toContain('Screenshots');
    expect(preview).toContain('1 image(s) not attached (a.png: larger than 10 MB)');
  });
});

// =============================================================================
// checkGitHubCli tests
// =============================================================================

describe('checkGitHubCli', () => {
  // Exec fakes are injected so tests never spawn real `gh` processes — the
  // real calls carry 5s subprocess timeouts that overrun bun's per-test
  // timeout on slow CI runners.
  test('reports installed and authenticated when both gh calls succeed', () => {
    const result = checkGitHubCli(() => '');
    expect(result).toEqual({ installed: true, authenticated: true });
  });

  test('reports not installed when gh --version fails', () => {
    const result = checkGitHubCli(() => {
      throw new Error('command not found: gh');
    });
    expect(result.installed).toBe(false);
    expect(result.authenticated).toBe(false);
    expect(result.error).toContain('GitHub CLI');
  });

  test('reports not authenticated when gh auth status fails', () => {
    const result = checkGitHubCli((args) => {
      if (args[0] === 'auth') throw new Error('not logged in');
      return '';
    });
    expect(result.installed).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.error).toContain('gh auth login');
  });
});

// =============================================================================
// inspectBugReportTarget tests
// =============================================================================

describe('inspectBugReportTarget', () => {
  const ghWith = (repo: { viewerPermission?: string; visibility?: string }, version = '2.103.3'): GhExec =>
    (args) => (args[0] === '--version' ? `gh version ${version} (2026-10-26)\n` : JSON.stringify(repo));

  test('can attach with write access on a new enough gh', () => {
    const target = inspectBugReportTarget('o/r', ghWith({ viewerPermission: 'WRITE', visibility: 'PRIVATE' }));
    expect(target).toEqual({ repo: 'o/r', isPublic: false, canAttach: true });
  });

  test('cannot attach without write access', () => {
    const target = inspectBugReportTarget('o/r', ghWith({ viewerPermission: 'READ', visibility: 'PUBLIC' }));
    expect(target.canAttach).toBe(false);
    expect(target.isPublic).toBe(true);
    expect(target.attachBlocker).toContain('write access');
  });

  test('cannot attach on a gh older than 2.99', () => {
    const target = inspectBugReportTarget('o/r', ghWith({ viewerPermission: 'ADMIN', visibility: 'PUBLIC' }, '2.98.0'));
    expect(target.canAttach).toBe(false);
    expect(target.attachBlocker).toContain('2.99.0');
  });

  test('leaves an empty permission to the endpoint, as gh does for an app installation', () => {
    const target = inspectBugReportTarget('o/r', ghWith({ viewerPermission: '', visibility: 'PUBLIC' }));
    expect(target.canAttach).toBe(true);
  });

  test('treats a repo it cannot read as public', () => {
    const target = inspectBugReportTarget('o/r', () => {
      throw new Error('Could not resolve to a Repository');
    });
    expect(target.isPublic).toBe(true);
    expect(target.canAttach).toBe(false);
  });
});

// =============================================================================
// selectScreenshots tests
// =============================================================================

describe('selectScreenshots', () => {
  const canAttach: BugReportTarget = { repo: 'o/r', isPublic: true, canAttach: true };
  const png: PlatformFile = { id: '1', name: 'a.png', size: 1000, mimeType: 'image/png' };

  test('keeps images and explains the rest', () => {
    const pdf: PlatformFile = { id: '2', name: 'doc.pdf', size: 1000, mimeType: 'application/pdf' };
    const big: PlatformFile = { id: '3', name: 'big.png', size: 11 * 1024 * 1024, mimeType: 'image/png' };

    const { screenshots, skipped } = selectScreenshots([png, pdf, big], canAttach);

    expect(screenshots).toEqual([png]);
    expect(skipped).toEqual(['doc.pdf: not an image', 'big.png: larger than 10 MB']);
  });

  test('keeps nothing when the target cannot take attachments', () => {
    const { screenshots, skipped } = selectScreenshots([png], {
      ...canAttach,
      canAttach: false,
      attachBlocker: 'attaching needs write access to o/r',
    });

    expect(screenshots).toEqual([]);
    expect(skipped).toEqual(['a.png: attaching needs write access to o/r']);
  });
});

// =============================================================================
// saveScreenshots tests
// =============================================================================

describe('saveScreenshots', () => {
  test('writes owner-only files and removes them on cleanup', async () => {
    const saved = await saveScreenshots(
      [{ id: '1', name: 'my shot#1.png', size: 4, mimeType: 'image/png' }],
      async () => Buffer.from('data')
    );

    expect(saved.failed).toBe(0);
    expect(saved.paths).toHaveLength(1);
    // Not the uploaded name: it reaches a command line, and `#` starts alt text.
    expect(saved.paths[0]).toEndWith('/screenshot-1.png');
    expect(readFileSync(saved.paths[0], 'utf-8')).toBe('data');
    expect(statSync(saved.paths[0]).mode & 0o777).toBe(0o600);

    saved.cleanup();
    expect(existsSync(saved.paths[0])).toBe(false);
  });

  test('counts a failed download and keeps the rest', async () => {
    const saved = await saveScreenshots(
      [
        { id: 'bad', name: 'a.png', size: 1, mimeType: 'image/png' },
        { id: 'good', name: 'b.jpg', size: 1, mimeType: 'image/jpeg', extension: 'jpg' },
      ],
      async (id) => {
        if (id === 'bad') throw new Error('Download failed');
        return Buffer.from('data');
      }
    );

    expect(saved.failed).toBe(1);
    expect(saved.paths).toHaveLength(1);
    expect(saved.paths[0]).toEndWith('/screenshot-2.jpg');
    saved.cleanup();
  });

  test('counts everything as failed on a platform that cannot download', async () => {
    const saved = await saveScreenshots([{ id: '1', name: 'a.png', size: 1, mimeType: 'image/png' }], undefined);

    expect(saved.failed).toBe(1);
    expect(saved.paths).toEqual([]);
    saved.cleanup();
  });
});

// =============================================================================
// createGitHubIssue tests
// =============================================================================

describe('createGitHubIssue', () => {
  const issueUrl = 'https://github.com/o/r/issues/7';

  /** A gh whose `issue create` is `create`; everything else succeeds. */
  function fakeGh(create: (args: string[], body: string) => string) {
    return mock<GhExec>((args) => {
      if (args[0] !== 'issue') return '';
      return create(args, readFileSync(args[args.indexOf('--body-file') + 1], 'utf-8'));
    });
  }

  const createCalls = (exec: ReturnType<typeof fakeGh>) =>
    exec.mock.calls.map(([args]) => args).filter((args) => args[0] === 'issue');

  test('passes hostile text as one argument, so a shell can never read it', async () => {
    const title = 'crash $(touch /tmp/pwned) `id` "quoted"';
    const exec = fakeGh(() => `${issueUrl}\n`);

    const issue = await createGitHubIssue(title, 'body', '/tmp', { repo: 'o/r', exec });

    expect(issue).toEqual({ url: issueUrl, attachmentsIncomplete: false });
    const [args] = createCalls(exec);
    expect(args[args.indexOf('--title') + 1]).toBe(title);
    expect(args[args.indexOf('--repo') + 1]).toBe('o/r');
    expect(args).not.toContain('--attach');
  });

  test('attaches each screenshot with alt text', async () => {
    const exec = fakeGh(() => `${issueUrl}\n`);

    await createGitHubIssue('T', 'B', '/tmp', { repo: 'o/r', attachments: ['/t/a.png', '/t/b.png'], exec });

    const [args] = createCalls(exec);
    expect(args.filter((_, i) => args[i - 1] === '--attach')).toEqual(['/t/a.png#Screenshot 1', '/t/b.png#Screenshot 2']);
  });

  test('does not file twice when gh fails after creating the issue', async () => {
    // Part of the uploads succeeded: gh creates the issue, prints its URL and
    // exits non-zero. A retry here would be a duplicate public issue.
    const exec = fakeGh(() => {
      throw Object.assign(new Error('exit 1'), { stdout: `${issueUrl}\n`, stderr: 'could not upload' });
    });

    const issue = await createGitHubIssue('T', 'B', '/tmp', { repo: 'o/r', attachments: ['/t/a.png'], exec });

    expect(issue).toEqual({ url: issueUrl, attachmentsIncomplete: true });
    expect(createCalls(exec)).toHaveLength(1);
  });

  test('files without screenshots when gh could not upload any', async () => {
    // Nothing uploaded means gh refused before creating anything, so the
    // report is filed once more, without attachments, and says so.
    const bodies: string[] = [];
    const exec = fakeGh((args, body) => {
      bodies.push(body);
      if (args.includes('--attach')) {
        throw Object.assign(new Error('exit 1'), { stdout: '', stderr: 'requires write access' });
      }
      return `${issueUrl}\n`;
    });

    const issue = await createGitHubIssue('T', 'B', '/tmp', { repo: 'o/r', attachments: ['/t/a.png'], exec });

    expect(issue).toEqual({ url: issueUrl, attachmentsIncomplete: true });
    expect(createCalls(exec)).toHaveLength(2);
    expect(bodies[1]).toBe(withOmittedScreenshots('B', 1));
  });

  test('does not retry after a timeout, the issue may already exist', async () => {
    const exec = fakeGh(() => {
      throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', stdout: '' });
    });

    await expect(
      createGitHubIssue('T', 'B', '/tmp', { repo: 'o/r', attachments: ['/t/a.png'], exec })
    ).rejects.toThrow('timed out');
    expect(createCalls(exec)).toHaveLength(1);
  });

  test('still throws when a report without screenshots fails', async () => {
    const exec = fakeGh(() => {
      throw new Error('repository not found');
    });

    await expect(createGitHubIssue('T', 'B', '/tmp', { repo: 'o/r', exec })).rejects.toThrow('repository not found');
    expect(createCalls(exec)).toHaveLength(1);
  });
});

// =============================================================================
// formatIssueBody with screenshots tests
// =============================================================================

describe('formatIssueBody with screenshots', () => {
  const mockContext: BugReportContext = {
    version: '0.50.0',
    claudeCliVersion: '2.0.76',
    platform: 'Test',
    platformType: 'mattermost',
    nodeVersion: 'v20.0.0',
    osVersion: 'darwin arm64',
    sessionId: 'test:thread',
    claudeSessionId: 'uuid-12345678',
    workingDir: '~/project',
    branch: 'main',
    recentEvents: [],
  };

  test('mentions screenshots that could not be attached', () => {
    const body = formatIssueBody(mockContext, 'Bug description', 2);
    expect(body).toContain('## Screenshots');
    expect(body).toContain('2 screenshot(s) were shared in the chat thread');
  });

  test('omits the section when nothing was left behind', () => {
    const body = formatIssueBody(mockContext, 'Bug description');
    expect(body).not.toContain('## Screenshots');
  });
});
