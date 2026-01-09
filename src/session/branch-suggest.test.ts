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
import { parseBranchSuggestions } from './branch-suggest.js';

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
