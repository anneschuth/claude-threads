/**
 * Bug Report Module Tests
 */

import { describe, test, expect } from 'bun:test';
import {
  sanitizePath,
  sanitizeText,
  generateIssueTitle,
  formatIssueBody,
  trackEvent,
  getRecentEvents,
  formatBugPreview,
  checkGitHubCli,
  uploadImages,
  type BugReportContext,
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
    const preview = formatBugPreview('Test title', 'Test desc', mockContext, [], [], mockFormatter);
    expect(preview).toContain('**Title:**');
    expect(preview).toContain('Test title');
  });

  test('includes description as blockquote', () => {
    const preview = formatBugPreview('Title', 'Bug description', mockContext, [], [], mockFormatter);
    expect(preview).toContain('> Bug description');
  });

  test('includes environment info', () => {
    const preview = formatBugPreview('Title', 'Desc', mockContext, [], [], mockFormatter);
    expect(preview).toContain('v0.49.0');
    expect(preview).toContain('2.0.76');
    expect(preview).toContain('mattermost');
    expect(preview).toContain('main');
  });

  test('includes approval instructions', () => {
    const preview = formatBugPreview('Title', 'Desc', mockContext, [], [], mockFormatter);
    expect(preview).toContain('👍');
    expect(preview).toContain('👎');
    expect(preview).toContain('GitHub issue');
    expect(preview).toContain('cancel');
  });

  test('shows uploaded images count', () => {
    const preview = formatBugPreview('Title', 'Desc', mockContext, ['https://files.catbox.moe/abc.png'], [], mockFormatter);
    expect(preview).toContain('Screenshots');
    expect(preview).toContain('1 image(s) uploaded');
  });

  test('shows image upload errors', () => {
    const preview = formatBugPreview('Title', 'Desc', mockContext, [], ['screenshot.png: Upload failed'], mockFormatter);
    expect(preview).toContain('Screenshots');
    expect(preview).toContain('1 image(s) failed');
  });
});

// =============================================================================
// checkGitHubCli tests
// =============================================================================

describe('checkGitHubCli', () => {
  test('returns result object with expected properties', () => {
    const result = checkGitHubCli();
    expect(result).toHaveProperty('installed');
    expect(result).toHaveProperty('authenticated');
    expect(typeof result.installed).toBe('boolean');
    expect(typeof result.authenticated).toBe('boolean');
  });

  test('provides error message when not installed', () => {
    const result = checkGitHubCli();
    if (!result.installed) {
      expect(result.error).toBeDefined();
      expect(result.error).toContain('GitHub CLI');
    }
  });
});

// =============================================================================
// uploadImages tests
// =============================================================================

describe('uploadImages', () => {
  test('filters non-image files', async () => {
    const files: PlatformFile[] = [
      { id: '1', name: 'doc.pdf', size: 1000, mimeType: 'application/pdf' },
      { id: '2', name: 'text.txt', size: 100, mimeType: 'text/plain' },
    ];

    const mockDownload = async (_id: string) => Buffer.from('test');
    const results = await uploadImages(files, mockDownload);

    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe('Not an image file');
    expect(results[1].success).toBe(false);
    expect(results[1].error).toBe('Not an image file');
  });

  test('handles download errors gracefully', async () => {
    const files: PlatformFile[] = [
      { id: '1', name: 'image.png', size: 1000, mimeType: 'image/png' },
    ];

    const mockDownload = async (_id: string): Promise<Buffer> => {
      throw new Error('Download failed');
    };
    const results = await uploadImages(files, mockDownload);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('Download failed');
    expect(results[0].originalFile.name).toBe('image.png');
  });

  test('preserves original file info in results', async () => {
    const files: PlatformFile[] = [
      { id: 'file123', name: 'screenshot.jpg', size: 5000, mimeType: 'image/jpeg' },
    ];

    // This will fail because we can't actually upload, but it tests the structure
    const mockDownload = async (_id: string): Promise<Buffer> => {
      throw new Error('Mock error');
    };
    const results = await uploadImages(files, mockDownload);

    expect(results[0].originalFile.id).toBe('file123');
    expect(results[0].originalFile.name).toBe('screenshot.jpg');
    expect(results[0].originalFile.mimeType).toBe('image/jpeg');
  });
});

// =============================================================================
// formatIssueBody with images tests
// =============================================================================

describe('formatIssueBody with images', () => {
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

  test('includes screenshots section when images provided', () => {
    const body = formatIssueBody(mockContext, 'Bug description', ['https://files.catbox.moe/abc.png']);
    expect(body).toContain('## Screenshots');
    expect(body).toContain('![Screenshot 1](https://files.catbox.moe/abc.png)');
  });

  test('includes multiple screenshots', () => {
    const body = formatIssueBody(mockContext, 'Bug', [
      'https://files.catbox.moe/a.png',
      'https://files.catbox.moe/b.png',
    ]);
    expect(body).toContain('![Screenshot 1](https://files.catbox.moe/a.png)');
    expect(body).toContain('![Screenshot 2](https://files.catbox.moe/b.png)');
  });

  test('omits screenshots section when no images', () => {
    const body = formatIssueBody(mockContext, 'Bug description', []);
    expect(body).not.toContain('## Screenshots');
  });
});
