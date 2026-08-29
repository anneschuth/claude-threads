/**
 * Tests for git worktree helpers.
 *
 * Focus: `isValidBranchName`, the security gate that keeps user-supplied
 * branch names from reaching `git worktree add` as flags (leading `-`) or —
 * on Windows, where the spawn wrapper runs git with `shell:true` — as cmd.exe
 * command-injection payloads (shell metacharacters).
 */

import { describe, expect, test } from 'bun:test';
import { isValidBranchName } from './worktree.js';

describe('isValidBranchName', () => {
  test('accepts ordinary branch names', () => {
    for (const name of ['main', 'feature/login', 'fix-123', 'release_1.2', 'user/anne/wip']) {
      expect(isValidBranchName(name)).toBe(true);
    }
  });

  test('rejects empty and git-illegal names', () => {
    for (const name of ['', '/leading', 'trailing/', 'has space', 'a..b', 'x.lock', '@', 'a@{b', 'ques?', 'sta*r', 'til~de', 'car^et', 'col:on']) {
      expect(isValidBranchName(name)).toBe(false);
    }
  });

  test('rejects leading dash (git flag injection)', () => {
    for (const name of ['-branch', '--force', '--detach', '-b']) {
      expect(isValidBranchName(name)).toBe(false);
    }
  });

  test('rejects shell metacharacters (Windows shell:true command injection)', () => {
    // Each of these is legal in a git ref name but dangerous under cmd.exe.
    for (const name of [
      'buildfix&calc.exe',
      'a|b',
      'a;b',
      'a$(whoami)',
      'a`id`',
      'a>b',
      'a<b',
      'a(b)',
      'a{b}',
      'a!b',
      "a'b",
      'a"b',
      'a#b',
      'a%PATH%',
    ]) {
      expect(isValidBranchName(name)).toBe(false);
    }
  });
});
