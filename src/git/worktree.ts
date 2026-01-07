import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fs from 'fs/promises';
import { homedir } from 'os';
import { createLogger } from '../utils/logger.js';

const log = createLogger('git-worktree');

/** Centralized worktree location for easy cleanup */
const WORKTREES_DIR = path.join(homedir(), '.claude-threads', 'worktrees');

/**
 * Metadata stored alongside each worktree for cleanup tracking
 */
export interface WorktreeMetadata {
  repoRoot: string;           // Original repo path
  branch: string;             // Branch name
  createdAt: string;          // ISO date
  lastActivityAt: string;     // ISO date - updated on session activity
  sessionId?: string;         // Current session using this worktree (if any)
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  isMain: boolean;
  isBare: boolean;
}

/**
 * Execute a git command and return stdout
 */
async function execGit(args: string[], cwd: string): Promise<string> {
  const cmd = `git ${args.join(' ')}`;
  log.debug(`Executing: ${cmd}`);

  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        log.debug(`${cmd} → success`);
        resolve(stdout.trim());
      } else {
        log.debug(`${cmd} → failed (code=${code}): ${stderr.substring(0, 100) || stdout.substring(0, 100)}`);
        reject(new Error(`git ${args.join(' ')} failed: ${stderr || stdout}`));
      }
    });

    proc.on('error', (err) => {
      log.warn(`${cmd} → error: ${err}`);
      reject(err);
    });
  });
}

/**
 * Check if a directory is inside a git repository
 */
export async function isGitRepository(dir: string): Promise<boolean> {
  try {
    await execGit(['rev-parse', '--git-dir'], dir);
    return true;
  } catch (err) {
    log.debug(`Not a git repository: ${dir} (${err})`);
    return false;
  }
}

/**
 * Get the root directory of the git repository
 */
export async function getRepositoryRoot(dir: string): Promise<string> {
  return execGit(['rev-parse', '--show-toplevel'], dir);
}

/**
 * Get the current branch name for a directory
 * Returns null if not on a branch (detached HEAD) or not in a git repo
 */
export async function getCurrentBranch(dir: string): Promise<string | null> {
  try {
    const branch = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
    // If HEAD is detached, git returns "HEAD"
    return branch === 'HEAD' ? null : branch;
  } catch {
    return null;
  }
}

/**
 * Get the default branch name (main or master)
 */
export async function getDefaultBranch(repoRoot: string): Promise<string> {
  try {
    // First try to get from origin/HEAD
    const remoteHead = await execGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoRoot);
    return remoteHead.replace('origin/', '');
  } catch {
    // Fall back to checking for main or master
    try {
      await execGit(['rev-parse', '--verify', 'main'], repoRoot);
      return 'main';
    } catch {
      try {
        await execGit(['rev-parse', '--verify', 'master'], repoRoot);
        return 'master';
      } catch {
        return 'main'; // Default fallback
      }
    }
  }
}

/**
 * Check if a branch has been merged into the default branch (main/master)
 * Returns true if the branch's HEAD is an ancestor of the default branch
 */
export async function isBranchMerged(repoRoot: string, branchName: string): Promise<boolean> {
  try {
    const defaultBranch = await getDefaultBranch(repoRoot);

    // Skip if checking the default branch itself
    if (branchName === defaultBranch) {
      return false;
    }

    // Fetch to ensure we have latest refs (ignore errors - might be offline)
    await execGit(['fetch', 'origin', defaultBranch], repoRoot).catch(() => {});

    // Check if branch commit is ancestor of default branch
    // merge-base --is-ancestor exits 0 if ancestor, 1 if not
    await execGit(['merge-base', '--is-ancestor', branchName, `origin/${defaultBranch}`], repoRoot);
    return true;
  } catch {
    // Not merged or error checking
    return false;
  }
}

/**
 * Check if there are uncommitted changes (staged or unstaged)
 */
export async function hasUncommittedChanges(dir: string): Promise<boolean> {
  try {
    // Check for staged changes
    const staged = await execGit(['diff', '--cached', '--quiet'], dir).catch(() => 'changes');
    if (staged === 'changes') return true;

    // Check for unstaged changes
    const unstaged = await execGit(['diff', '--quiet'], dir).catch(() => 'changes');
    if (unstaged === 'changes') return true;

    // Check for untracked files
    const untracked = await execGit(['ls-files', '--others', '--exclude-standard'], dir);
    return untracked.length > 0;
  } catch {
    return false;
  }
}

/**
 * List all worktrees for a repository
 */
export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  const output = await execGit(['worktree', 'list', '--porcelain'], repoRoot);
  const worktrees: WorktreeInfo[] = [];

  if (!output) return worktrees;

  // Parse porcelain output
  // Format:
  // worktree /path/to/worktree
  // HEAD <commit>
  // branch refs/heads/branch-name
  // <blank line>
  const blocks = output.split('\n\n').filter(Boolean);

  for (const block of blocks) {
    const lines = block.split('\n');
    const worktree: Partial<WorktreeInfo> = {};

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        worktree.path = line.slice(9);
      } else if (line.startsWith('HEAD ')) {
        worktree.commit = line.slice(5);
      } else if (line.startsWith('branch ')) {
        // refs/heads/branch-name -> branch-name
        worktree.branch = line.slice(7).replace('refs/heads/', '');
      } else if (line === 'bare') {
        worktree.isBare = true;
      } else if (line === 'detached') {
        worktree.branch = '(detached)';
      }
    }

    if (worktree.path) {
      worktrees.push({
        path: worktree.path,
        branch: worktree.branch || '(unknown)',
        commit: worktree.commit || '',
        isMain: worktrees.length === 0, // First worktree is the main one
        isBare: worktree.isBare || false,
      });
    }
  }

  return worktrees;
}

/**
 * Check if a branch exists (local or remote)
 */
async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    // Check local branches
    await execGit(['rev-parse', '--verify', `refs/heads/${branch}`], repoRoot);
    return true;
  } catch {
    try {
      // Check remote branches
      await execGit(['rev-parse', '--verify', `refs/remotes/origin/${branch}`], repoRoot);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Generate the worktree directory path.
 * Creates worktrees in centralized location: ~/.claude-threads/worktrees/{encoded-repo}--{branch}-{uuid}
 * This makes it easy to find and clean up orphaned worktrees.
 */
export function getWorktreeDir(repoRoot: string, branch: string): string {
  // Sanitize repo path for use in directory name
  // /Users/anne/myproject -> -Users-anne-myproject
  const repoName = repoRoot.replace(/\//g, '-').replace(/^-/, '');

  // Sanitize branch name for filesystem
  const sanitizedBranch = branch
    .replace(/\//g, '-')
    .replace(/[^a-zA-Z0-9-_]/g, '');

  const shortUuid = randomUUID().slice(0, 8);
  return path.join(WORKTREES_DIR, `${repoName}--${sanitizedBranch}-${shortUuid}`);
}

/**
 * Check if a worktree path is in the centralized worktrees directory.
 * Used to prevent accidentally deleting worktrees outside our control.
 */
export function isValidWorktreePath(worktreePath: string): boolean {
  // Must be inside ~/.claude-threads/worktrees/
  return worktreePath.startsWith(WORKTREES_DIR + path.sep);
}

/**
 * Get the centralized worktrees directory path.
 */
export function getWorktreesDir(): string {
  return WORKTREES_DIR;
}

/**
 * Create a new worktree for a branch
 * If the branch doesn't exist, creates it from the current HEAD
 */
export async function createWorktree(
  repoRoot: string,
  branch: string,
  targetDir: string
): Promise<string> {
  log.info(`Creating worktree for branch '${branch}' at ${targetDir}`);

  // Ensure the parent directory exists
  const parentDir = path.dirname(targetDir);
  log.debug(`Creating parent directory: ${parentDir}`);
  await fs.mkdir(parentDir, { recursive: true });

  // Check if branch exists
  const exists = await branchExists(repoRoot, branch);

  if (exists) {
    // Use existing branch
    log.debug(`Branch '${branch}' exists, adding worktree`);
    await execGit(['worktree', 'add', targetDir, branch], repoRoot);
  } else {
    // Create new branch from HEAD
    log.debug(`Branch '${branch}' does not exist, creating with worktree`);
    await execGit(['worktree', 'add', '-b', branch, targetDir], repoRoot);
  }

  log.info(`Worktree created successfully: ${targetDir}`);
  return targetDir;
}

/**
 * Remove a worktree
 */
export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  log.info(`Removing worktree: ${worktreePath}`);

  // First try to remove cleanly
  try {
    await execGit(['worktree', 'remove', worktreePath], repoRoot);
    log.debug('Worktree removed cleanly');
  } catch (err) {
    // If that fails, try force remove
    log.debug(`Clean remove failed (${err}), trying force remove`);
    await execGit(['worktree', 'remove', '--force', worktreePath], repoRoot);
  }

  // Prune any stale worktree references
  log.debug('Pruning stale worktree references');
  await execGit(['worktree', 'prune'], repoRoot);
  log.info('Worktree removed and pruned successfully');
}

/**
 * Find a worktree by branch name
 */
export async function findWorktreeByBranch(
  repoRoot: string,
  branch: string
): Promise<WorktreeInfo | null> {
  const worktrees = await listWorktrees(repoRoot);
  return worktrees.find((wt) => wt.branch === branch) || null;
}

/**
 * Validate a git branch name
 * Based on git-check-ref-format rules
 */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length === 0) return false;

  // Cannot start or end with /
  if (name.startsWith('/') || name.endsWith('/')) return false;

  // Cannot contain ..
  if (name.includes('..')) return false;

  // Cannot contain special characters
  if (/[\s~^:?*[\]\\]/.test(name)) return false;

  // Cannot start with -
  if (name.startsWith('-')) return false;

  // Cannot end with .lock
  if (name.endsWith('.lock')) return false;

  // Cannot contain @{
  if (name.includes('@{')) return false;

  // Cannot be @
  if (name === '@') return false;

  // Cannot contain consecutive dots
  if (/\.\./.test(name)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Worktree Metadata Management
// ---------------------------------------------------------------------------

const METADATA_FILENAME = '.claude-threads-meta.json';

/**
 * Get the path to the metadata file for a worktree
 */
export function getMetadataPath(worktreePath: string): string {
  return path.join(worktreePath, METADATA_FILENAME);
}

/**
 * Write metadata file for a worktree.
 * Called when creating a new worktree.
 */
export async function writeWorktreeMetadata(
  worktreePath: string,
  metadata: WorktreeMetadata
): Promise<void> {
  const metaPath = getMetadataPath(worktreePath);
  try {
    await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2), 'utf-8');
    log.debug(`Wrote worktree metadata: ${metaPath}`);
  } catch (err) {
    log.warn(`Failed to write worktree metadata: ${err}`);
  }
}

/**
 * Read metadata file for a worktree.
 * Returns null if metadata doesn't exist or is invalid.
 */
export async function readWorktreeMetadata(worktreePath: string): Promise<WorktreeMetadata | null> {
  const metaPath = getMetadataPath(worktreePath);
  try {
    const content = await fs.readFile(metaPath, 'utf-8');
    return JSON.parse(content) as WorktreeMetadata;
  } catch {
    return null;
  }
}

/**
 * Update the lastActivityAt timestamp in worktree metadata.
 * Called periodically to track worktree usage for age-based cleanup.
 */
export async function updateWorktreeActivity(
  worktreePath: string,
  sessionId?: string
): Promise<void> {
  const existing = await readWorktreeMetadata(worktreePath);
  if (!existing) return;

  existing.lastActivityAt = new Date().toISOString();
  if (sessionId !== undefined) {
    existing.sessionId = sessionId;
  }

  await writeWorktreeMetadata(worktreePath, existing);
}

// ---------------------------------------------------------------------------
// Git Status for System Prompt
// ---------------------------------------------------------------------------

/**
 * Git status information for system prompt context
 */
export interface GitStatusInfo {
  isGitRepo: boolean;
  branch: string | null;
  defaultBranch: string | null;
  hasUncommittedChanges: boolean;
  recentCommits: string[];  // Last 3-5 commit summaries
}

/**
 * Get comprehensive git status for a directory.
 * Used to provide context in the system prompt.
 */
export async function getGitStatus(dir: string): Promise<GitStatusInfo> {
  const result: GitStatusInfo = {
    isGitRepo: false,
    branch: null,
    defaultBranch: null,
    hasUncommittedChanges: false,
    recentCommits: [],
  };

  // Check if it's a git repo
  const isRepo = await isGitRepository(dir);
  if (!isRepo) return result;
  result.isGitRepo = true;

  // Get current branch
  result.branch = await getCurrentBranch(dir);

  // Get default branch
  try {
    const repoRoot = await getRepositoryRoot(dir);
    result.defaultBranch = await getDefaultBranch(repoRoot);
  } catch {
    // Ignore errors
  }

  // Check for uncommitted changes
  result.hasUncommittedChanges = await hasUncommittedChanges(dir);

  // Get recent commits (last 5)
  try {
    const commits = await execGit(
      ['log', '--oneline', '-5', '--format=%h %s'],
      dir
    );
    result.recentCommits = commits.split('\n').filter(Boolean);
  } catch {
    // Ignore errors - might be empty repo
  }

  return result;
}
