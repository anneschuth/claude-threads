/**
 * Worktree Integration Tests
 *
 * Tests git worktree prompts and handling by creating a real
 * temporary git repository for testing.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import { MattermostTestApi } from '../fixtures/mattermost/api-helpers.js';
import {
  initTestContext,
  startSession,
  waitForPostMatching,
  waitForSessionActive,
  addReaction,
  sendFollowUp,
  getThreadPosts,
  type TestSessionContext,
} from '../helpers/session-helpers.js';
import { startTestBot, type TestBot } from '../helpers/bot-starter.js';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

// Skip if not running integration tests
const SKIP = !process.env.INTEGRATION_TEST;

// Temp directory for test git repos
const TEST_REPO_BASE = '/tmp/claude-threads-worktree-test';

/**
 * Create a temp git repo with initial commit
 */
function createTempGitRepo(name: string): string {
  const repoPath = join(TEST_REPO_BASE, name, Date.now().toString());
  mkdirSync(repoPath, { recursive: true });

  // Initialize git repo
  execSync('git init', { cwd: repoPath, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: repoPath, stdio: 'pipe' });

  // Create initial commit (worktrees require at least one commit)
  writeFileSync(join(repoPath, 'README.md'), '# Test Repo\n');
  execSync('git add .', { cwd: repoPath, stdio: 'pipe' });
  execSync('git commit -m "Initial commit"', { cwd: repoPath, stdio: 'pipe' });

  return repoPath;
}

/**
 * Add uncommitted changes to repo
 */
function addUncommittedChanges(repoPath: string): void {
  writeFileSync(join(repoPath, 'uncommitted.txt'), 'uncommitted changes');
}

/**
 * Clean up temp repos
 */
function cleanupTempRepos(): void {
  if (existsSync(TEST_REPO_BASE)) {
    rmSync(TEST_REPO_BASE, { recursive: true, force: true });
  }
}

describe.skipIf(SKIP)('Worktree Prompts', () => {
  let config: ReturnType<typeof loadConfig>;
  let ctx: TestSessionContext;
  let adminApi: MattermostTestApi;
  let bot: TestBot;
  let testRepoPath: string;
  const testThreadIds: string[] = [];

  beforeAll(async () => {
    config = loadConfig();
    adminApi = new MattermostTestApi(config.mattermost.url, config.mattermost.admin.token!);
    ctx = initTestContext();
    cleanupTempRepos();
  });

  afterAll(async () => {
    // Clean up test threads
    for (const threadId of testThreadIds) {
      try {
        await adminApi.deletePost(threadId);
      } catch {
        // Ignore cleanup errors
      }
    }
    // Clean up temp repos
    cleanupTempRepos();
  });

  beforeEach(async () => {
    // Create fresh test repo for each test
    testRepoPath = createTempGitRepo('worktree-test');
  });

  afterEach(async () => {
    if (bot) {
      await bot.stop();
    }
  });

  describe('Worktree Prompt on Uncommitted Changes', () => {
    it('should prompt for worktree when repo has uncommitted changes', async () => {
      // Add uncommitted changes
      addUncommittedChanges(testRepoPath);

      // Start bot with worktree mode = prompt and using test repo as working dir
      bot = await startTestBot({
        scenario: 'persistent-session',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
        workingDir: testRepoPath,
        clearPersistedSessions: true,
        worktreeMode: 'prompt', // Enable worktree prompts
      });

      // Start a session
      const rootPost = await startSession(ctx, 'Help with this code', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // Wait for worktree prompt (mentions uncommitted changes or worktree)
      const worktreePrompt = await waitForPostMatching(ctx, rootPost.id, /uncommitted|worktree|branch name/i, {
        timeout: 10000,
      });

      expect(worktreePrompt).toBeDefined();
      expect(worktreePrompt.message).toMatch(/uncommitted|worktree/i);
    });

    it('should skip worktree when user reacts with ❌', async () => {
      // Add uncommitted changes
      addUncommittedChanges(testRepoPath);

      bot = await startTestBot({
        scenario: 'persistent-session',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
        workingDir: testRepoPath,
        clearPersistedSessions: true,
        worktreeMode: 'prompt', // Enable worktree prompts
      });

      // Start a session
      const rootPost = await startSession(ctx, 'Continue without worktree', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // Wait for worktree prompt
      const worktreePrompt = await waitForPostMatching(ctx, rootPost.id, /uncommitted|worktree|branch name/i, {
        timeout: 10000,
      });

      expect(worktreePrompt).toBeDefined();

      // React with ❌ to skip worktree
      await addReaction(ctx, worktreePrompt.id, 'x');

      // Session should become active after skipping
      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

      // Verify session is active
      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);
    });

    it('should create worktree when user provides branch name', async () => {
      // Add uncommitted changes
      addUncommittedChanges(testRepoPath);

      bot = await startTestBot({
        scenario: 'persistent-session',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
        workingDir: testRepoPath,
        clearPersistedSessions: true,
        worktreeMode: 'prompt', // Enable worktree prompts
      });

      // Start a session
      const rootPost = await startSession(ctx, 'Create worktree for me', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // Wait for worktree prompt
      const worktreePrompt = await waitForPostMatching(ctx, rootPost.id, /uncommitted|worktree|branch name/i, {
        timeout: 10000,
      });

      expect(worktreePrompt).toBeDefined();

      // Reply with a branch name
      const branchName = `test-branch-${Date.now()}`;
      await sendFollowUp(ctx, rootPost.id, branchName);

      // Wait for worktree creation confirmation or session to become active
      // The bot should either create the worktree and start, or post an error
      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

      // Session should be active after providing branch name
      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);

      // Optionally verify worktree was created by checking for confirmation message
      const allPosts = await getThreadPosts(ctx, rootPost.id);
      const botPosts = allPosts.filter((p) => p.user_id === ctx.botUserId);
      // Should have worktree prompt + possibly confirmation/session header
      expect(botPosts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Worktree Mode Off', () => {
    it('should not prompt for worktree when mode is off', async () => {
      // Add uncommitted changes
      addUncommittedChanges(testRepoPath);

      // Start bot with worktree mode off
      bot = await startTestBot({
        scenario: 'persistent-session',
        skipPermissions: true,
        debug: process.env.DEBUG === '1',
        workingDir: testRepoPath,
        clearPersistedSessions: true,
        worktreeMode: 'off', // Explicitly disable worktree prompts
      });

      // Start a session
      const rootPost = await startSession(ctx, 'Simple request', config.mattermost.bot.username);
      testThreadIds.push(rootPost.id);

      // With worktree mode off, session should start without worktree prompt
      // Wait for session to become active
      await waitForSessionActive(bot.sessionManager, rootPost.id, { timeout: 10000 });

      // Verify session is active (not blocked by worktree prompt)
      expect(bot.sessionManager.isInSessionThread(rootPost.id)).toBe(true);

      // Verify no worktree prompt was posted
      const allPosts = await getThreadPosts(ctx, rootPost.id);
      const botPosts = allPosts.filter((p) => p.user_id === ctx.botUserId);
      const worktreePromptPosts = botPosts.filter((p) =>
        /uncommitted changes|create a worktree|branch name/i.test(p.message)
      );

      // Should NOT have worktree prompt when mode is off
      expect(worktreePromptPosts.length).toBe(0);
    });
  });
});
