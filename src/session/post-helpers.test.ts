import { describe, it, expect } from 'bun:test';
import {
  formatBold,
} from './post-helpers.js';
import {
  mockFormatter as mattermostFormatter,
  slackMockFormatter as slackFormatter,
} from '../test-utils/mock-formatter.js';

// Note: Most post-helpers functions require a Session object with a platform client.
// Since they're thin wrappers around platform.createPost(), we focus on testing
// the formatting utilities that don't require mocking the platform.

describe('formatBold', () => {
  it('formats label only (Mattermost)', () => {
    expect(formatBold(mattermostFormatter, 'Session cancelled')).toBe('**Session cancelled**');
  });

  it('formats label with rest (Mattermost)', () => {
    expect(formatBold(mattermostFormatter, 'Session cancelled', 'by @user')).toBe('**Session cancelled** by @user');
  });

  it('handles empty rest (Mattermost)', () => {
    // Empty string is falsy, so formatBold treats it as no rest
    expect(formatBold(mattermostFormatter, 'Label', '')).toBe('**Label**');
  });

  it('formats label only (Slack)', () => {
    expect(formatBold(slackFormatter, 'Session cancelled')).toBe('*Session cancelled*');
  });

  it('formats label with rest (Slack)', () => {
    expect(formatBold(slackFormatter, 'Session cancelled', 'by @user')).toBe('*Session cancelled* by @user');
  });
});

// Integration tests for post helpers would require mocking PlatformClient
// which is better done in integration tests with the full SessionManager
describe('post helper functions', () => {
  it('exports all expected functions', async () => {
    const helpers = await import('./post-helpers.js');

    // Core post functions
    expect(typeof helpers.postInfo).toBe('function');
    expect(typeof helpers.postSuccess).toBe('function');
    expect(typeof helpers.postWarning).toBe('function');
    expect(typeof helpers.postError).toBe('function');
    expect(typeof helpers.postSecure).toBe('function');
    expect(typeof helpers.postCommand).toBe('function');
    expect(typeof helpers.postCancelled).toBe('function');
    expect(typeof helpers.postResume).toBe('function');
    expect(typeof helpers.postTimeout).toBe('function');
    expect(typeof helpers.postInterrupt).toBe('function');
    expect(typeof helpers.postWorktree).toBe('function');
    expect(typeof helpers.postContext).toBe('function');
    expect(typeof helpers.postUser).toBe('function');

    // Post with reactions
    expect(typeof helpers.postWithReactions).toBe('function');
    expect(typeof helpers.postApprovalPrompt).toBe('function');

    // Utility functions
    expect(typeof helpers.getPostId).toBe('function');
    expect(typeof helpers.postAndRegister).toBe('function');
    expect(typeof helpers.postWithReactionsAndRegister).toBe('function');
    expect(typeof helpers.formatBold).toBe('function');
    expect(typeof helpers.postBold).toBe('function');
  });
});
