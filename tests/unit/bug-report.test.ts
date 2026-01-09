/**
 * Unit tests for bug-report.ts
 *
 * Tests sanitization, formatting, and issue generation.
 */

import { describe, it, expect } from 'bun:test';
import {
  sanitizePath,
  sanitizeText,
  generateIssueTitle,
  formatIssueBody,
  trackEvent,
  getRecentEvents,
  type BugReportContext,
  type RecentEvent,
} from '../../src/session/bug-report.js';
import type { Session } from '../../src/session/types.js';

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'test-platform:test-thread',
    platformId: 'test-platform',
    threadId: 'test-thread',
    claudeSessionId: '12345678-1234-1234-1234-123456789012',
    startedBy: 'testuser',
    startedAt: new Date('2024-01-15T10:00:00Z'),
    lastActivityAt: new Date('2024-01-15T10:30:00Z'),
    workingDir: '/Users/testuser/projects/myapp',
    recentEvents: [],
    ...overrides,
  } as Session;
}

function createMockContext(overrides: Partial<BugReportContext> = {}): BugReportContext {
  return {
    version: '0.49.0',
    claudeCliVersion: '2.0.76',
    platform: 'Test Platform',
    platformType: 'mattermost',
    nodeVersion: 'v20.10.0',
    osVersion: 'darwin arm64',
    sessionId: 'test-platform:test-thread',
    claudeSessionId: '12345678-1234-1234-1234-123456789012',
    workingDir: '~/projects/myapp',
    branch: 'main',
    recentEvents: [],
    ...overrides,
  };
}

// =============================================================================
// sanitizePath Tests
// =============================================================================

describe('sanitizePath', () => {
  it('should replace /Users/username with ~', () => {
    expect(sanitizePath('/Users/anne/project')).toBe('~/project');
    expect(sanitizePath('/Users/john.doe/work/repo')).toBe('~/work/repo');
  });

  it('should replace /home/username with ~', () => {
    expect(sanitizePath('/home/ubuntu/app')).toBe('~/app');
    expect(sanitizePath('/home/developer/code')).toBe('~/code');
  });

  it('should handle Windows paths', () => {
    expect(sanitizePath('C:\\Users\\Admin\\project')).toBe('~\\project');
  });

  it('should redact sensitive directory names', () => {
    // The sanitizer redacts both the sensitive dir and anything after it that looks sensitive
    expect(sanitizePath('/Users/anne/tokens/secret')).toBe('~/[REDACTED]/[REDACTED]');
    expect(sanitizePath('/home/user/secrets/api')).toBe('~/[REDACTED]/api');
    expect(sanitizePath('/Users/anne/credentials/key')).toBe('~/[REDACTED]/key');
  });

  it('should handle paths without user directories', () => {
    expect(sanitizePath('/var/log/app.log')).toBe('/var/log/app.log');
    expect(sanitizePath('/tmp/test')).toBe('/tmp/test');
  });

  it('should handle relative paths', () => {
    expect(sanitizePath('./src/index.ts')).toBe('./src/index.ts');
    expect(sanitizePath('../config')).toBe('../config');
  });
});

// =============================================================================
// sanitizeText Tests
// =============================================================================

describe('sanitizeText', () => {
  describe('Slack tokens', () => {
    it('should redact xoxb tokens', () => {
      expect(sanitizeText('Token: xoxb-123-456-abcdef')).toBe('Token: [SLACK_TOKEN]');
    });

    it('should redact xoxp tokens', () => {
      expect(sanitizeText('User token: xoxp-999-888-777')).toBe('User token: [SLACK_TOKEN]');
    });

    it('should redact xapp tokens', () => {
      expect(sanitizeText('App: xapp-1-A123-456')).toBe('App: [SLACK_TOKEN]');
    });
  });

  describe('GitHub tokens', () => {
    it('should redact ghp tokens', () => {
      expect(sanitizeText('ghp_abc123xyz789')).toBe('[GITHUB_TOKEN]');
    });

    it('should redact gho tokens', () => {
      expect(sanitizeText('OAuth: gho_secret123')).toBe('OAuth: [GITHUB_TOKEN]');
    });

    it('should redact github_pat tokens', () => {
      expect(sanitizeText('PAT: github_pat_longtokenvalue')).toBe('PAT: [GITHUB_TOKEN]');
    });
  });

  describe('Stripe keys', () => {
    it('should redact live keys', () => {
      expect(sanitizeText('sk_live_abc123xyz')).toBe('[STRIPE_KEY]');
      expect(sanitizeText('pk_live_abc123xyz')).toBe('[STRIPE_KEY]');
    });

    it('should redact test keys', () => {
      expect(sanitizeText('sk_test_abc123xyz')).toBe('[STRIPE_KEY]');
      expect(sanitizeText('pk_test_abc123xyz')).toBe('[STRIPE_KEY]');
    });
  });

  describe('AWS keys', () => {
    it('should redact AWS access keys', () => {
      expect(sanitizeText('Key: AKIAIOSFODNN7EXAMPLE')).toBe('Key: [AWS_KEY]');
    });
  });

  describe('Home directory paths', () => {
    it('should sanitize home directory paths in text', () => {
      expect(sanitizeText('Error in /Users/anne/project/file.ts')).toBe('Error in ~/project/file.ts');
      expect(sanitizeText('Path: /home/developer/app')).toBe('Path: ~/app');
    });
  });

  describe('Mixed content', () => {
    it('should handle multiple secrets in one string', () => {
      const text = 'Token xoxb-123-456 and key ghp_abc123xyz in /Users/anne/config';
      const sanitized = sanitizeText(text);
      expect(sanitized).toContain('[SLACK_TOKEN]');
      expect(sanitized).toContain('[GITHUB_TOKEN]');
      expect(sanitized).toContain('~/config');
      expect(sanitized).not.toContain('xoxb');
      expect(sanitized).not.toContain('ghp_');
      expect(sanitized).not.toContain('/Users/anne');
    });
  });

  describe('Safe text', () => {
    it('should not modify text without secrets', () => {
      const text = 'This is a normal error message about file.ts';
      expect(sanitizeText(text)).toBe(text);
    });
  });
});

// =============================================================================
// generateIssueTitle Tests
// =============================================================================

describe('generateIssueTitle', () => {
  it('should return short descriptions unchanged', () => {
    expect(generateIssueTitle('Session crashed')).toBe('Session crashed');
  });

  it('should truncate long descriptions', () => {
    const longDescription = 'A'.repeat(200);
    const title = generateIssueTitle(longDescription);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith('...')).toBe(true);
  });

  it('should normalize whitespace', () => {
    expect(generateIssueTitle('  Multiple   spaces   here  ')).toBe('Multiple spaces here');
    expect(generateIssueTitle('Line\nbreak')).toBe('Line break');
  });

  it('should handle exact boundary length', () => {
    const exactLength = 'A'.repeat(80);
    expect(generateIssueTitle(exactLength)).toBe(exactLength);
  });

  it('should truncate at 77 chars and add ...', () => {
    const slightlyOver = 'A'.repeat(81);
    const title = generateIssueTitle(slightlyOver);
    expect(title.length).toBe(80);
    expect(title).toBe('A'.repeat(77) + '...');
  });
});

// =============================================================================
// trackEvent / getRecentEvents Tests
// =============================================================================

describe('trackEvent', () => {
  it('should add events to session', () => {
    const session = createMockSession();
    trackEvent(session, 'tool_use', 'Read file.ts');

    const events = getRecentEvents(session);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_use');
    expect(events[0].summary).toBe('Read file.ts');
  });

  it('should truncate long summaries', () => {
    const session = createMockSession();
    const longSummary = 'A'.repeat(200);
    trackEvent(session, 'tool_use', longSummary);

    const events = getRecentEvents(session);
    expect(events[0].summary.length).toBeLessThanOrEqual(100);
  });

  it('should limit to MAX_RECENT_EVENTS (10)', () => {
    const session = createMockSession();

    // Add 15 events
    for (let i = 0; i < 15; i++) {
      trackEvent(session, 'tool_use', `Event ${i}`);
    }

    const events = getRecentEvents(session);
    expect(events).toHaveLength(10);
    // Should have the last 10 events (5-14)
    expect(events[0].summary).toBe('Event 5');
    expect(events[9].summary).toBe('Event 14');
  });

  it('should add timestamp to events', () => {
    const session = createMockSession();
    const before = Date.now();
    trackEvent(session, 'error', 'Test error');
    const after = Date.now();

    const events = getRecentEvents(session);
    expect(events[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(events[0].timestamp).toBeLessThanOrEqual(after);
  });

  it('should initialize recentEvents if undefined', () => {
    const session = createMockSession();
    // @ts-expect-error - Testing undefined case
    session.recentEvents = undefined;

    trackEvent(session, 'test', 'Test event');

    expect(session.recentEvents).toBeDefined();
    expect(session.recentEvents).toHaveLength(1);
  });
});

describe('getRecentEvents', () => {
  it('should return empty array for new session', () => {
    const session = createMockSession();
    expect(getRecentEvents(session)).toEqual([]);
  });

  it('should return copy of events', () => {
    const session = createMockSession();
    trackEvent(session, 'test', 'Test event');

    const events1 = getRecentEvents(session);
    const events2 = getRecentEvents(session);

    // Should return same content
    expect(events1).toEqual(events2);
  });

  it('should handle undefined recentEvents', () => {
    const session = createMockSession();
    // @ts-expect-error - Testing undefined case
    session.recentEvents = undefined;

    expect(getRecentEvents(session)).toEqual([]);
  });
});

// =============================================================================
// formatIssueBody Tests
// =============================================================================

describe('formatIssueBody', () => {
  it('should include description section', () => {
    const context = createMockContext();
    const body = formatIssueBody(context, 'Session crashed on startup');

    expect(body).toContain('## Description');
    expect(body).toContain('Session crashed on startup');
  });

  it('should include environment section', () => {
    const context = createMockContext();
    const body = formatIssueBody(context, 'Test');

    expect(body).toContain('## Environment');
    expect(body).toContain('v0.49.0');
    expect(body).toContain('2.0.76');
    expect(body).toContain('mattermost');
    expect(body).toContain('v20.10.0');
  });

  it('should include session context section', () => {
    const context = createMockContext();
    const body = formatIssueBody(context, 'Test');

    expect(body).toContain('## Session Context');
    expect(body).toContain('12345678'); // First 8 chars of session ID
    expect(body).toContain('~/projects/myapp');
    expect(body).toContain('main');
  });

  it('should include usage stats if available', () => {
    const context = createMockContext({
      usageStats: {
        model: 'Opus 4.5',
        contextPercent: 45,
        cost: '0.12',
      },
    });
    const body = formatIssueBody(context, 'Test');

    expect(body).toContain('## Usage Stats');
    expect(body).toContain('Opus 4.5');
    expect(body).toContain('45%');
    expect(body).toContain('$0.12');
  });

  it('should include recent events section', () => {
    const events: RecentEvent[] = [
      { type: 'tool_use', timestamp: Date.now(), summary: 'Read config.ts' },
      { type: 'error', timestamp: Date.now(), summary: 'Permission denied' },
    ];
    const context = createMockContext({ recentEvents: events });
    const body = formatIssueBody(context, 'Test');

    expect(body).toContain('## Recent Events');
    expect(body).toContain('tool_use');
    expect(body).toContain('Read config.ts');
  });

  it('should include error details if present', () => {
    const context = createMockContext({
      errorContext: {
        postId: 'post123',
        message: 'Connection refused: ECONNREFUSED',
        timestamp: new Date('2024-01-15T10:30:00Z'),
      },
    });
    const body = formatIssueBody(context, 'Test');

    expect(body).toContain('## Error Details');
    expect(body).toContain('Connection refused');
    expect(body).toContain('ECONNREFUSED');
  });

  it('should sanitize user description', () => {
    const context = createMockContext();
    const body = formatIssueBody(context, 'Error with token xoxb-123-456');

    expect(body).toContain('[SLACK_TOKEN]');
    expect(body).not.toContain('xoxb-123-456');
  });

  it('should include footer', () => {
    const context = createMockContext();
    const body = formatIssueBody(context, 'Test');

    expect(body).toContain('Reported via claude-threads bug report feature');
  });

  it('should handle missing optional fields', () => {
    const context = createMockContext({
      branch: null,
      usageStats: undefined,
      errorContext: undefined,
    });
    const body = formatIssueBody(context, 'Test');

    expect(body).toContain('N/A'); // For branch
    expect(body).not.toContain('## Usage Stats');
    expect(body).not.toContain('## Error Details');
  });
});
