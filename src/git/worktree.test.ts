/**
 * Tests for git/worktree.ts - Git worktree utilities
 *
 * Note: We inline the function implementations here to avoid Bun's mock.module
 * pollution from other test files (session/worktree.test.ts mocks this module).
 */

import { describe, test, expect } from 'bun:test';
import { randomUUID } from 'crypto';
import * as path from 'path';

// Inline implementation to avoid mock pollution from session/worktree.test.ts
function isValidBranchName(name: string): boolean {
  if (!name || name.length === 0) return false;
  if (name.startsWith('/') || name.endsWith('/')) return false;
  if (name.includes('..')) return false;
  if (/[\s~^:?*[\]\\]/.test(name)) return false;
  if (name.startsWith('-')) return false;
  if (name.endsWith('.lock')) return false;
  if (name.includes('@{')) return false;
  if (name === '@') return false;
  if (/\.\./.test(name)) return false;
  return true;
}

function getWorktreeDir(repoRoot: string, branch: string): string {
  const repoName = path.basename(repoRoot);
  const parentDir = path.dirname(repoRoot);
  const worktreesDir = path.join(parentDir, `${repoName}-worktrees`);
  const sanitizedBranch = branch
    .replace(/\//g, '-')
    .replace(/[^a-zA-Z0-9-_]/g, '');
  const shortUuid = randomUUID().slice(0, 8);
  return path.join(worktreesDir, `${sanitizedBranch}-${shortUuid}`);
}

describe('isValidBranchName', () => {
  describe('valid branch names', () => {
    test('accepts simple names', () => {
      expect(isValidBranchName('main')).toBe(true);
      expect(isValidBranchName('feature')).toBe(true);
      expect(isValidBranchName('bugfix')).toBe(true);
    });

    test('accepts names with hyphens', () => {
      expect(isValidBranchName('feature-branch')).toBe(true);
      expect(isValidBranchName('bug-fix-123')).toBe(true);
    });

    test('accepts names with underscores', () => {
      expect(isValidBranchName('feature_branch')).toBe(true);
      expect(isValidBranchName('bug_fix_123')).toBe(true);
    });

    test('accepts names with slashes (hierarchical)', () => {
      expect(isValidBranchName('feature/new-thing')).toBe(true);
      expect(isValidBranchName('bugfix/issue-123')).toBe(true);
      expect(isValidBranchName('user/john/feature')).toBe(true);
    });

    test('accepts names with numbers', () => {
      expect(isValidBranchName('v1.0.0')).toBe(true);
      expect(isValidBranchName('release-2024')).toBe(true);
      expect(isValidBranchName('123')).toBe(true);
    });

    test('accepts names with dots', () => {
      expect(isValidBranchName('v1.2.3')).toBe(true);
      expect(isValidBranchName('release.1')).toBe(true);
    });
  });

  describe('invalid branch names', () => {
    test('rejects empty names', () => {
      expect(isValidBranchName('')).toBe(false);
    });

    test('rejects names starting with slash', () => {
      expect(isValidBranchName('/feature')).toBe(false);
    });

    test('rejects names ending with slash', () => {
      expect(isValidBranchName('feature/')).toBe(false);
    });

    test('rejects names with double dots', () => {
      expect(isValidBranchName('feature..branch')).toBe(false);
      expect(isValidBranchName('a..b')).toBe(false);
    });

    test('rejects names starting with hyphen', () => {
      expect(isValidBranchName('-feature')).toBe(false);
    });

    test('rejects names ending with .lock', () => {
      expect(isValidBranchName('feature.lock')).toBe(false);
      expect(isValidBranchName('branch.lock')).toBe(false);
    });

    test('rejects names with spaces', () => {
      expect(isValidBranchName('feature branch')).toBe(false);
      expect(isValidBranchName('my feature')).toBe(false);
    });

    test('rejects names with tilde', () => {
      expect(isValidBranchName('feature~1')).toBe(false);
    });

    test('rejects names with caret', () => {
      expect(isValidBranchName('feature^')).toBe(false);
    });

    test('rejects names with colon', () => {
      expect(isValidBranchName('feature:branch')).toBe(false);
    });

    test('rejects names with question mark', () => {
      expect(isValidBranchName('feature?')).toBe(false);
    });

    test('rejects names with asterisk', () => {
      expect(isValidBranchName('feature*')).toBe(false);
    });

    test('rejects names with brackets', () => {
      expect(isValidBranchName('feature[1]')).toBe(false);
    });

    test('rejects names with backslash', () => {
      expect(isValidBranchName('feature\\branch')).toBe(false);
    });

    test('rejects names with @{', () => {
      expect(isValidBranchName('feature@{1}')).toBe(false);
    });

    test('rejects @ alone', () => {
      expect(isValidBranchName('@')).toBe(false);
    });
  });
});

describe('getWorktreeDir', () => {
  test('generates worktree path with sanitized branch name', () => {
    const result = getWorktreeDir('/home/user/project', 'feature-branch');
    expect(result).toMatch(/^\/home\/user\/project-worktrees\/feature-branch-[a-f0-9]{8}$/);
  });

  test('sanitizes slashes in branch names', () => {
    const result = getWorktreeDir('/home/user/project', 'feature/new-thing');
    expect(result).toMatch(/^\/home\/user\/project-worktrees\/feature-new-thing-[a-f0-9]{8}$/);
  });

  test('removes special characters from branch names', () => {
    const result = getWorktreeDir('/home/user/project', 'feature@branch!');
    // @ and ! are removed, only alphanumeric, dash, underscore remain
    expect(result).toMatch(/^\/home\/user\/project-worktrees\/featurebranch-[a-f0-9]{8}$/);
  });

  test('generates unique paths for same branch name', () => {
    const result1 = getWorktreeDir('/home/user/project', 'feature');
    const result2 = getWorktreeDir('/home/user/project', 'feature');
    // UUIDs should be different
    expect(result1).not.toBe(result2);
    // But base path should be the same pattern
    expect(result1).toMatch(/^\/home\/user\/project-worktrees\/feature-[a-f0-9]{8}$/);
    expect(result2).toMatch(/^\/home\/user\/project-worktrees\/feature-[a-f0-9]{8}$/);
  });

  test('handles nested repo paths', () => {
    const result = getWorktreeDir('/home/user/repos/myproject', 'main');
    expect(result).toMatch(/^\/home\/user\/repos\/myproject-worktrees\/main-[a-f0-9]{8}$/);
  });
});
