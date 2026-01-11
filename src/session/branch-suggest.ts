/**
 * Branch name suggestions using Claude.
 *
 * Provides intelligent branch name suggestions based on the user's task description.
 * Uses the quick-query utility with Haiku for fast, low-cost suggestions.
 */

import { quickQuery } from '../claude/quick-query.js';
import { isValidBranchName } from '../git/worktree.js';
import { createLogger } from '../utils/logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const log = createLogger('branch');

/** Default timeout for branch suggestions (ms) */
const SUGGESTION_TIMEOUT = 15000;

/** Maximum number of suggestions to return */
const MAX_SUGGESTIONS = 3;

/**
 * Get the current git branch name.
 */
async function getCurrentBranch(workingDir: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: workingDir });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Get recent commit messages for context.
 */
async function getRecentCommits(workingDir: string, count: number = 5): Promise<string[]> {
  try {
    const { stdout } = await execAsync(`git log --oneline -${count}`, { cwd: workingDir });
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Build the prompt for branch name suggestions.
 * Exported for testing.
 */
export function buildSuggestionPrompt(
  userMessage: string,
  currentBranch: string | null,
  recentCommits: string[]
): string {
  let context = '';

  if (currentBranch) {
    context += `Current branch: ${currentBranch}\n`;
  }

  if (recentCommits.length > 0) {
    context += `Recent commits:\n${recentCommits.map(c => `  ${c}`).join('\n')}\n`;
  }

  return `Suggest exactly 3 git branch names for this task. Follow these rules:
- Use conventional prefixes: feat/, fix/, chore/, docs/, refactor/, test/
- Use kebab-case (lowercase with hyphens)
- Keep names short: 2-4 words after the prefix
- Make them descriptive of the task

${context}
Task: "${userMessage}"

Output ONLY the 3 branch names, one per line, nothing else.`;
}

/**
 * Parse and validate branch suggestions from Claude's response.
 * Exported for testing.
 */
export function parseBranchSuggestions(response: string): string[] {
  const lines = response
    .split('\n')
    .map(line => line.trim())
    // Remove any numbering, bullets, or markdown formatting
    .map(line => line.replace(/^[\d.\-*#]+\s*/, ''))
    // Remove backticks
    .map(line => line.replace(/`/g, ''))
    .filter(line => line.length > 0)
    // Validate as git branch names
    .filter(isValidBranchName);

  return lines.slice(0, MAX_SUGGESTIONS);
}

/**
 * Suggest branch names based on the user's task description.
 *
 * Uses Claude Haiku for fast, low-cost suggestions.
 * Returns empty array on any failure (silent fallback).
 *
 * @param workingDir - Git repository working directory
 * @param userMessage - The user's task description
 * @returns Array of suggested branch names (0-3 items)
 *
 * @example
 * const suggestions = await suggestBranchNames('/path/to/repo', 'add dark mode toggle');
 * // ['feat/add-dark-mode', 'feat/dark-mode-toggle', 'feature/implement-dark-mode']
 */
export async function suggestBranchNames(
  workingDir: string,
  userMessage: string
): Promise<string[]> {
  log.debug(`Suggesting branch names for: "${userMessage.substring(0, 50)}..."`);

  try {
    // Gather git context
    const [currentBranch, recentCommits] = await Promise.all([
      getCurrentBranch(workingDir),
      getRecentCommits(workingDir, 5),
    ]);

    // Build prompt
    const prompt = buildSuggestionPrompt(userMessage, currentBranch, recentCommits);

    // Query Claude
    const result = await quickQuery({
      prompt,
      model: 'haiku',
      timeout: SUGGESTION_TIMEOUT,
      workingDir,
    });

    if (!result.success || !result.response) {
      log.debug(`Branch suggestion failed: ${result.error || 'no response'}`);
      return [];
    }

    // Parse and validate
    const suggestions = parseBranchSuggestions(result.response);
    log.debug(`Got ${suggestions.length} branch suggestions: ${suggestions.join(', ')}`);

    return suggestions;
  } catch (err) {
    log.debug(`Branch suggestion error: ${err}`);
    return [];
  }
}
