/**
 * Tests for branch name suggestion parsing
 *
 * Note: These tests focus on the parseBranchSuggestions function.
 * Integration tests for the full suggestBranchNames flow would require
 * the Claude CLI, so they belong in the integration test suite.
 *
 * IMPORTANT: Some other test files mock the git/worktree module globally,
 * which affects isValidBranchName. These tests focus on parsing/formatting
 * behavior rather than strict validation (which is tested in git/worktree.test.ts).
 */

import { describe, expect, test } from 'bun:test';
import { parseBranchSuggestions, buildSuggestionPrompt } from './branch.js';

describe('parseBranchSuggestions', () => {
  test('parses simple branch names', () => {
    const response = 'feat/add-dark-mode\nfix/login-validation\nchore/update-deps';
    const suggestions = parseBranchSuggestions(response);

    expect(suggestions).toHaveLength(3);
    expect(suggestions).toContain('feat/add-dark-mode');
    expect(suggestions).toContain('fix/login-validation');
    expect(suggestions).toContain('chore/update-deps');
  });

  test('includes valid branches from mixed response', () => {
    // This test verifies that valid branches are extracted
    // Invalid branch filtering is tested in git/worktree.test.ts
    const response = 'feat/valid-branch\nfix/another-valid';
    const suggestions = parseBranchSuggestions(response);

    expect(suggestions).toContain('feat/valid-branch');
    expect(suggestions).toContain('fix/another-valid');
  });

  test('limits to 3 suggestions maximum', () => {
    const response = 'feat/one\nfeat/two\nfeat/three\nfeat/four\nfeat/five';
    const suggestions = parseBranchSuggestions(response);

    expect(suggestions).toHaveLength(3);
    expect(suggestions).toEqual(['feat/one', 'feat/two', 'feat/three']);
  });

  test('strips numbered list formatting', () => {
    const response = '1. feat/branch-one\n2. fix/branch-two\n3. chore/branch-three';
    const suggestions = parseBranchSuggestions(response);

    expect(suggestions).toContain('feat/branch-one');
    expect(suggestions).toContain('fix/branch-two');
    expect(suggestions).toContain('chore/branch-three');
  });

  test('strips bullet point formatting', () => {
    const response = '- feat/branch-one\n* fix/branch-two\n# chore/branch-three';
    const suggestions = parseBranchSuggestions(response);

    expect(suggestions).toContain('feat/branch-one');
    expect(suggestions).toContain('fix/branch-two');
    expect(suggestions).toContain('chore/branch-three');
  });

  test('strips backtick formatting', () => {
    const response = '`feat/branch-one`\n`fix/branch-two`\n`chore/branch-three`';
    const suggestions = parseBranchSuggestions(response);

    expect(suggestions).toContain('feat/branch-one');
    expect(suggestions).toContain('fix/branch-two');
    expect(suggestions).toContain('chore/branch-three');
  });

  test('handles mixed formatting', () => {
    const response = '1. `feat/branch-one`\n2. `fix/branch-two`\n3. `chore/branch-three`';
    const suggestions = parseBranchSuggestions(response);

    expect(suggestions).toContain('feat/branch-one');
    expect(suggestions).toContain('fix/branch-two');
    expect(suggestions).toContain('chore/branch-three');
  });

  test('handles empty response', () => {
    const suggestions = parseBranchSuggestions('');
    expect(suggestions).toEqual([]);
  });

  test('handles whitespace-only response', () => {
    const suggestions = parseBranchSuggestions('   \n  \n   ');
    expect(suggestions).toEqual([]);
  });

  test('trims whitespace from branch names', () => {
    const response = '  feat/branch-one  \n  fix/branch-two  ';
    const suggestions = parseBranchSuggestions(response);

    expect(suggestions).toContain('feat/branch-one');
    expect(suggestions).toContain('fix/branch-two');
  });

  test('processes dashes as markdown bullets', () => {
    // Leading dashes are stripped as markdown bullet formatting
    const response = '- feat/branch-one\n- fix/branch-two';
    const suggestions = parseBranchSuggestions(response);

    expect(suggestions).toContain('feat/branch-one');
    expect(suggestions).toContain('fix/branch-two');
  });

  test('handles various git-valid branch formats', () => {
    const response = 'feature/ABC-123-add-feature\nbugfix/fix_underscore\nrelease/v1.0.0';
    const suggestions = parseBranchSuggestions(response);

    expect(suggestions).toHaveLength(3);
    expect(suggestions).toContain('feature/ABC-123-add-feature');
    expect(suggestions).toContain('bugfix/fix_underscore');
    expect(suggestions).toContain('release/v1.0.0');
  });
});

describe('buildSuggestionPrompt', () => {
  test('builds prompt with all context', () => {
    const prompt = buildSuggestionPrompt(
      'add dark mode toggle',
      'main',
      ['abc123 Initial commit', 'def456 Add feature']
    );

    expect(prompt).toContain('add dark mode toggle');
    expect(prompt).toContain('Current branch: main');
    expect(prompt).toContain('abc123 Initial commit');
    expect(prompt).toContain('def456 Add feature');
    expect(prompt).toContain('feat/');
    expect(prompt).toContain('fix/');
  });

  test('builds prompt without current branch', () => {
    const prompt = buildSuggestionPrompt(
      'fix login bug',
      null,
      ['abc123 Some commit']
    );

    expect(prompt).toContain('fix login bug');
    expect(prompt).not.toContain('Current branch:');
    expect(prompt).toContain('abc123 Some commit');
  });

  test('builds prompt without recent commits', () => {
    const prompt = buildSuggestionPrompt(
      'add new feature',
      'develop',
      []
    );

    expect(prompt).toContain('add new feature');
    expect(prompt).toContain('Current branch: develop');
    expect(prompt).not.toContain('Recent commits:');
  });

  test('builds prompt with minimal context', () => {
    const prompt = buildSuggestionPrompt(
      'do something',
      null,
      []
    );

    expect(prompt).toContain('do something');
    expect(prompt).toContain('Output ONLY the 3 branch names');
    expect(prompt).not.toContain('Current branch:');
    expect(prompt).not.toContain('Recent commits:');
  });

  test('includes branching conventions in prompt', () => {
    const prompt = buildSuggestionPrompt('test', null, []);

    expect(prompt).toContain('feat/');
    expect(prompt).toContain('fix/');
    expect(prompt).toContain('chore/');
    expect(prompt).toContain('docs/');
    expect(prompt).toContain('refactor/');
    expect(prompt).toContain('test/');
    expect(prompt).toContain('kebab-case');
  });
});
