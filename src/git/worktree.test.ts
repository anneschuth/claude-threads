import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as path from 'path';
import * as fs from 'fs/promises';
import { homedir } from 'os';
import {
  isValidBranchName,
  getWorktreeDir,
  isValidWorktreePath,
  getWorktreesDir,
  getMetadataPath,
  writeWorktreeMetadata,
  readWorktreeMetadata,
  updateWorktreeActivity,
  type WorktreeMetadata,
} from './worktree.js';

describe('git/worktree', () => {
  describe('isValidBranchName', () => {
    it('returns false for empty string', () => {
      expect(isValidBranchName('')).toBe(false);
    });

    it('returns false for branch names starting with slash', () => {
      expect(isValidBranchName('/branch')).toBe(false);
    });

    it('returns false for branch names ending with slash', () => {
      expect(isValidBranchName('branch/')).toBe(false);
    });

    it('returns false for branch names containing ..', () => {
      expect(isValidBranchName('branch..name')).toBe(false);
    });

    it('returns false for branch names with spaces', () => {
      expect(isValidBranchName('branch name')).toBe(false);
    });

    it('returns false for branch names starting with -', () => {
      expect(isValidBranchName('-branch')).toBe(false);
    });

    it('returns false for branch names ending with .lock', () => {
      expect(isValidBranchName('branch.lock')).toBe(false);
    });

    it('returns false for branch names containing @{', () => {
      expect(isValidBranchName('branch@{0}')).toBe(false);
    });

    it('returns false for @ alone', () => {
      expect(isValidBranchName('@')).toBe(false);
    });

    it('returns false for branch names with special characters', () => {
      expect(isValidBranchName('branch~name')).toBe(false);
      expect(isValidBranchName('branch^name')).toBe(false);
      expect(isValidBranchName('branch:name')).toBe(false);
      expect(isValidBranchName('branch?name')).toBe(false);
      expect(isValidBranchName('branch*name')).toBe(false);
      expect(isValidBranchName('branch[name')).toBe(false);
      expect(isValidBranchName('branch]name')).toBe(false);
      expect(isValidBranchName('branch\\name')).toBe(false);
    });

    it('returns true for valid branch names', () => {
      expect(isValidBranchName('main')).toBe(true);
      expect(isValidBranchName('feature/new-feature')).toBe(true);
      expect(isValidBranchName('fix/bug-123')).toBe(true);
      expect(isValidBranchName('release-1.0.0')).toBe(true);
      expect(isValidBranchName('my_branch')).toBe(true);
      expect(isValidBranchName('branch.name')).toBe(true);
    });
  });

  describe('getWorktreeDir', () => {
    it('generates a path in the centralized worktrees directory', () => {
      const dir = getWorktreeDir('/Users/test/myproject', 'feature/branch');

      expect(dir.startsWith(path.join(homedir(), '.claude-threads', 'worktrees'))).toBe(true);
    });

    it('encodes repository path in directory name', () => {
      const dir = getWorktreeDir('/Users/test/myproject', 'main');

      // The repo path should be encoded (/ -> -)
      expect(dir).toContain('Users-test-myproject');
    });

    it('sanitizes branch name for filesystem', () => {
      const dir = getWorktreeDir('/repo', 'feature/new-feature');

      // Slashes in branch names should be converted to hyphens
      expect(dir).toContain('feature-new-feature');
    });

    it('includes a UUID for uniqueness', () => {
      const dir1 = getWorktreeDir('/repo', 'main');
      const dir2 = getWorktreeDir('/repo', 'main');

      // Two calls should produce different paths due to UUID
      expect(dir1).not.toBe(dir2);
    });

    it('removes special characters from branch name', () => {
      const dir = getWorktreeDir('/repo', 'feature@special!chars');

      // Special chars should be stripped
      expect(dir).not.toContain('@');
      expect(dir).not.toContain('!');
    });
  });

  describe('isValidWorktreePath', () => {
    const worktreesDir = path.join(homedir(), '.claude-threads', 'worktrees');

    it('returns true for paths inside worktrees directory', () => {
      const validPath = path.join(worktreesDir, 'my-worktree');
      expect(isValidWorktreePath(validPath)).toBe(true);
    });

    it('returns false for paths outside worktrees directory', () => {
      expect(isValidWorktreePath('/tmp/some-path')).toBe(false);
      expect(isValidWorktreePath('/home/user/project')).toBe(false);
    });

    it('returns false for the worktrees directory itself', () => {
      // The directory itself is not a valid worktree path (needs to be inside it)
      expect(isValidWorktreePath(worktreesDir)).toBe(false);
    });

    it('returns false for parent directory traversal attempts', () => {
      const maliciousPath = path.join(worktreesDir, '..', 'evil');
      // After path normalization, this should be outside worktrees
      expect(isValidWorktreePath(maliciousPath)).toBe(false);
    });
  });

  describe('getWorktreesDir', () => {
    it('returns the centralized worktrees directory', () => {
      const dir = getWorktreesDir();
      expect(dir).toBe(path.join(homedir(), '.claude-threads', 'worktrees'));
    });
  });

  describe('getMetadataPath', () => {
    it('returns path to metadata file inside worktree', () => {
      const metaPath = getMetadataPath('/some/worktree/path');
      expect(metaPath).toBe('/some/worktree/path/.claude-threads-meta.json');
    });
  });

  describe('WorktreeMetadata operations', () => {
    let writeFileSpy: ReturnType<typeof spyOn>;
    let readFileSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      writeFileSpy = spyOn(fs, 'writeFile').mockResolvedValue(undefined);
      readFileSpy = spyOn(fs, 'readFile');
    });

    afterEach(() => {
      writeFileSpy.mockRestore();
      readFileSpy.mockRestore();
    });

    describe('writeWorktreeMetadata', () => {
      it('writes metadata to the correct path', async () => {
        const metadata: WorktreeMetadata = {
          repoRoot: '/repo',
          branch: 'main',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastActivityAt: '2026-01-01T00:00:00.000Z',
          sessionId: 'session-123',
        };

        await writeWorktreeMetadata('/some/worktree', metadata);

        expect(writeFileSpy).toHaveBeenCalledWith(
          '/some/worktree/.claude-threads-meta.json',
          expect.any(String),
          'utf-8'
        );
      });

      it('writes metadata as formatted JSON', async () => {
        const metadata: WorktreeMetadata = {
          repoRoot: '/repo',
          branch: 'main',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastActivityAt: '2026-01-01T00:00:00.000Z',
        };

        await writeWorktreeMetadata('/worktree', metadata);

        const writtenContent = (writeFileSpy.mock.calls[0] as unknown[])[1] as string;
        expect(JSON.parse(writtenContent)).toEqual(metadata);
      });

      it('handles write errors gracefully', async () => {
        writeFileSpy.mockRejectedValue(new Error('Write failed'));

        // Should not throw
        await expect(writeWorktreeMetadata('/worktree', {
          repoRoot: '/repo',
          branch: 'main',
          createdAt: '',
          lastActivityAt: '',
        })).resolves.toBeUndefined();
      });
    });

    describe('readWorktreeMetadata', () => {
      it('returns parsed metadata when file exists', async () => {
        const metadata: WorktreeMetadata = {
          repoRoot: '/repo',
          branch: 'feature',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastActivityAt: '2026-01-01T12:00:00.000Z',
          sessionId: 'session-456',
        };
        readFileSpy.mockResolvedValue(JSON.stringify(metadata));

        const result = await readWorktreeMetadata('/worktree');

        expect(result).toEqual(metadata);
      });

      it('returns null when file does not exist', async () => {
        readFileSpy.mockRejectedValue(new Error('ENOENT'));

        const result = await readWorktreeMetadata('/worktree');

        expect(result).toBeNull();
      });

      it('returns null when file contains invalid JSON', async () => {
        readFileSpy.mockResolvedValue('not valid json');

        const result = await readWorktreeMetadata('/worktree');

        expect(result).toBeNull();
      });
    });

    describe('updateWorktreeActivity', () => {
      it('updates lastActivityAt timestamp', async () => {
        const existingMetadata: WorktreeMetadata = {
          repoRoot: '/repo',
          branch: 'main',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastActivityAt: '2026-01-01T00:00:00.000Z',
        };
        readFileSpy.mockResolvedValue(JSON.stringify(existingMetadata));

        const beforeUpdate = Date.now();
        await updateWorktreeActivity('/worktree');

        expect(writeFileSpy).toHaveBeenCalled();
        const writtenContent = (writeFileSpy.mock.calls[0] as unknown[])[1] as string;
        const updatedMetadata = JSON.parse(writtenContent) as WorktreeMetadata;

        // Check that lastActivityAt was updated to a recent time
        const activityTime = new Date(updatedMetadata.lastActivityAt).getTime();
        expect(activityTime).toBeGreaterThanOrEqual(beforeUpdate);
      });

      it('updates sessionId when provided', async () => {
        const existingMetadata: WorktreeMetadata = {
          repoRoot: '/repo',
          branch: 'main',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastActivityAt: '2026-01-01T00:00:00.000Z',
        };
        readFileSpy.mockResolvedValue(JSON.stringify(existingMetadata));

        await updateWorktreeActivity('/worktree', 'new-session-id');

        const writtenContent = (writeFileSpy.mock.calls[0] as unknown[])[1] as string;
        const updatedMetadata = JSON.parse(writtenContent) as WorktreeMetadata;

        expect(updatedMetadata.sessionId).toBe('new-session-id');
      });

      it('does nothing when metadata file does not exist', async () => {
        readFileSpy.mockRejectedValue(new Error('ENOENT'));

        await updateWorktreeActivity('/worktree');

        expect(writeFileSpy).not.toHaveBeenCalled();
      });
    });
  });
});
