import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, rmSync, existsSync } from 'fs';
import * as worktree from './worktree.js';

describe('Git Worktree Module', () => {
  describe('getWorktreeDir', () => {
    it('generates path in centralized worktrees directory', () => {
      const result = worktree.getWorktreeDir('/Users/anne/myproject', 'feature-branch');

      expect(result).toContain('.claude-threads/worktrees/');
      expect(result).toContain('feature-branch');
    });

    it('sanitizes repo path in directory name', () => {
      const result = worktree.getWorktreeDir('/Users/anne/my-project', 'main');

      // Should not have leading slash encoded (the leading slash is stripped)
      // Result: Users-anne-my-project (no leading dash)
      expect(result).toContain('Users-anne-my-project');
    });

    it('sanitizes branch name with slashes', () => {
      const result = worktree.getWorktreeDir('/repo', 'feature/my-feature');

      expect(result).toContain('feature-my-feature');
      // Note: The result path itself contains / because it's a full path
      // We're checking that the branch portion doesn't have slashes
      const basename = result.split('/').pop();
      expect(basename).not.toContain('/');
    });

    it('includes unique identifier for each call', () => {
      const result1 = worktree.getWorktreeDir('/repo', 'branch');
      const result2 = worktree.getWorktreeDir('/repo', 'branch');

      expect(result1).not.toBe(result2);
    });
  });

  describe('isValidWorktreePath', () => {
    it('returns true for paths in centralized worktrees directory', () => {
      const validPath = join(homedir(), '.claude-threads', 'worktrees', 'myrepo--branch-abc123');
      expect(worktree.isValidWorktreePath(validPath)).toBe(true);
    });

    it('returns false for paths outside centralized directory', () => {
      expect(worktree.isValidWorktreePath('/some/other/path')).toBe(false);
      expect(worktree.isValidWorktreePath('/home/user/project')).toBe(false);
      expect(worktree.isValidWorktreePath(join(homedir(), '.claude-threads'))).toBe(false);
    });
  });

  describe('getWorktreesDir', () => {
    it('returns path to centralized worktrees directory', () => {
      const result = worktree.getWorktreesDir();
      expect(result).toBe(join(homedir(), '.claude-threads', 'worktrees'));
    });
  });

  describe('WorktreeMetadata', () => {
    const testDir = join(homedir(), '.claude-threads-test-' + Date.now());
    const worktreePath = join(testDir, 'test-worktree');

    beforeEach(() => {
      mkdirSync(worktreePath, { recursive: true });
    });

    afterEach(() => {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('writes and reads metadata correctly', async () => {
      const metadata: worktree.WorktreeMetadata = {
        repoRoot: '/original/repo',
        branch: 'feature-branch',
        createdAt: '2024-01-01T00:00:00.000Z',
        lastActivityAt: '2024-01-01T12:00:00.000Z',
        sessionId: 'test-session-123',
      };

      await worktree.writeWorktreeMetadata(worktreePath, metadata);
      const read = await worktree.readWorktreeMetadata(worktreePath);

      expect(read).toEqual(metadata);
    });

    it('returns null for missing metadata', async () => {
      const result = await worktree.readWorktreeMetadata('/nonexistent/path');
      expect(result).toBeNull();
    });

    it('updates lastActivityAt timestamp', async () => {
      const initialMetadata: worktree.WorktreeMetadata = {
        repoRoot: '/repo',
        branch: 'branch',
        createdAt: '2024-01-01T00:00:00.000Z',
        lastActivityAt: '2024-01-01T00:00:00.000Z',
      };

      await worktree.writeWorktreeMetadata(worktreePath, initialMetadata);
      await worktree.updateWorktreeActivity(worktreePath, 'new-session-id');

      const updated = await worktree.readWorktreeMetadata(worktreePath);
      expect(updated).not.toBeNull();
      expect(updated!.lastActivityAt).not.toBe('2024-01-01T00:00:00.000Z');
      expect(updated!.sessionId).toBe('new-session-id');
    });
  });

  describe('isValidBranchName', () => {
    it('accepts valid branch names', () => {
      expect(worktree.isValidBranchName('main')).toBe(true);
      expect(worktree.isValidBranchName('feature/my-feature')).toBe(true);
      expect(worktree.isValidBranchName('fix_bug_123')).toBe(true);
      expect(worktree.isValidBranchName('release-v1.0.0')).toBe(true);
    });

    it('rejects invalid branch names', () => {
      expect(worktree.isValidBranchName('')).toBe(false);
      expect(worktree.isValidBranchName('/feature')).toBe(false);
      expect(worktree.isValidBranchName('feature/')).toBe(false);
      expect(worktree.isValidBranchName('feature..branch')).toBe(false);
      expect(worktree.isValidBranchName('branch.lock')).toBe(false);
      expect(worktree.isValidBranchName('@')).toBe(false);
      expect(worktree.isValidBranchName('-feature')).toBe(false);
    });
  });
});
