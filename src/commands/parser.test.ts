/**
 * Tests for command parser module
 */

import { describe, test, expect } from 'bun:test';
import {
  parseCommand,
  parseClaudeCommand,
  isClaudeAllowedCommand,
  removeCommandFromText,
  CLAUDE_ALLOWED_COMMANDS,
} from './parser.js';

describe('parseCommand', () => {
  describe('session control commands', () => {
    test('parses !stop', () => {
      const result = parseCommand('!stop');
      expect(result).toEqual({ command: 'stop', args: undefined, match: '!stop' });
    });

    test('parses !cancel as stop', () => {
      const result = parseCommand('!cancel');
      expect(result).toEqual({ command: 'stop', args: undefined, match: '!cancel' });
    });

    test('parses !escape', () => {
      const result = parseCommand('!escape');
      expect(result).toEqual({ command: 'escape', args: undefined, match: '!escape' });
    });

    test('parses !interrupt as escape', () => {
      const result = parseCommand('!interrupt');
      expect(result).toEqual({ command: 'escape', args: undefined, match: '!interrupt' });
    });

    test('parses !approve', () => {
      const result = parseCommand('!approve');
      expect(result).toEqual({ command: 'approve', args: undefined, match: '!approve' });
    });

    test('parses !yes as approve', () => {
      const result = parseCommand('!yes');
      expect(result).toEqual({ command: 'approve', args: undefined, match: '!yes' });
    });

    test('parses !help', () => {
      const result = parseCommand('!help');
      expect(result).toEqual({ command: 'help', args: undefined, match: '!help' });
    });

    test('parses !kill', () => {
      const result = parseCommand('!kill');
      expect(result).toEqual({ command: 'kill', args: undefined, match: '!kill' });
    });
  });

  describe('directory commands', () => {
    test('parses !cd with absolute path', () => {
      const result = parseCommand('!cd /path/to/dir');
      expect(result).toEqual({ command: 'cd', args: '/path/to/dir', match: '!cd /path/to/dir' });
    });

    test('parses !cd with tilde path', () => {
      const result = parseCommand('!cd ~/projects');
      expect(result).toEqual({ command: 'cd', args: '~/projects', match: '!cd ~/projects' });
    });

    test('parses !cd with relative path', () => {
      const result = parseCommand('!cd ../other');
      expect(result).toEqual({ command: 'cd', args: '../other', match: '!cd ../other' });
    });
  });

  describe('user management commands', () => {
    test('parses !invite with @mention', () => {
      const result = parseCommand('!invite @alice');
      expect(result).toEqual({ command: 'invite', args: 'alice', match: '!invite @alice' });
    });

    test('parses !invite without @', () => {
      const result = parseCommand('!invite bob');
      expect(result).toEqual({ command: 'invite', args: 'bob', match: '!invite bob' });
    });

    test('parses !kick with @mention', () => {
      const result = parseCommand('!kick @charlie');
      expect(result).toEqual({ command: 'kick', args: 'charlie', match: '!kick @charlie' });
    });
  });

  describe('permission commands', () => {
    test('parses !permissions interactive', () => {
      const result = parseCommand('!permissions interactive');
      expect(result).toEqual({ command: 'permissions', args: 'interactive', match: '!permissions interactive' });
    });

    test('parses !permission interactive (singular)', () => {
      const result = parseCommand('!permission interactive');
      expect(result).toEqual({ command: 'permissions', args: 'interactive', match: '!permission interactive' });
    });

    test('parses !permissions auto', () => {
      const result = parseCommand('!permissions auto');
      expect(result).toEqual({ command: 'permissions', args: 'auto', match: '!permissions auto' });
    });
  });

  describe('update commands', () => {
    test('parses !update', () => {
      const result = parseCommand('!update');
      expect(result).toEqual({ command: 'update', args: undefined, match: '!update' });
    });

    test('parses !update now', () => {
      const result = parseCommand('!update now');
      expect(result).toEqual({ command: 'update', args: 'now', match: '!update now' });
    });

    test('parses !update defer', () => {
      const result = parseCommand('!update defer');
      expect(result).toEqual({ command: 'update', args: 'defer', match: '!update defer' });
    });
  });

  describe('worktree commands', () => {
    test('parses !worktree branch-name', () => {
      const result = parseCommand('!worktree feature/new');
      expect(result).toEqual({ command: 'worktree', args: 'feature/new', match: '!worktree feature/new' });
    });

    test('parses !worktree list', () => {
      const result = parseCommand('!worktree list');
      expect(result).toEqual({ command: 'worktree', args: 'list', match: '!worktree list' });
    });

    test('parses !worktree switch branch', () => {
      const result = parseCommand('!worktree switch main');
      expect(result).toEqual({ command: 'worktree', args: 'switch main', match: '!worktree switch main' });
    });
  });

  describe('Claude Code passthrough commands', () => {
    test('parses !context', () => {
      const result = parseCommand('!context');
      expect(result).toEqual({ command: 'context', args: undefined, match: '!context' });
    });

    test('parses !cost', () => {
      const result = parseCommand('!cost');
      expect(result).toEqual({ command: 'cost', args: undefined, match: '!cost' });
    });

    test('parses !compact', () => {
      const result = parseCommand('!compact');
      expect(result).toEqual({ command: 'compact', args: undefined, match: '!compact' });
    });
  });

  describe('non-commands', () => {
    test('returns null for regular text', () => {
      expect(parseCommand('hello world')).toBeNull();
    });

    test('returns null for text with ! in middle', () => {
      expect(parseCommand('use !cd to change dirs')).toBeNull();
    });

    test('returns null for unknown command', () => {
      expect(parseCommand('!unknown')).toBeNull();
    });
  });
});

describe('parseClaudeCommand', () => {
  test('parses !cd at start of text', () => {
    const result = parseClaudeCommand('!cd /path/to/project');
    expect(result).toEqual({ command: 'cd', args: '/path/to/project', match: '!cd /path/to/project' });
  });

  test('parses !cd in middle of multiline text', () => {
    const text = 'I need to switch directories.\n\n!cd /new/path\n\nNow I can work.';
    const result = parseClaudeCommand(text);
    expect(result).toEqual({ command: 'cd', args: '/new/path', match: '!cd /new/path' });
  });

  test('parses !cd with tilde path', () => {
    const result = parseClaudeCommand('!cd ~/projects/myapp');
    expect(result).toEqual({ command: 'cd', args: '~/projects/myapp', match: '!cd ~/projects/myapp' });
  });

  test('returns null for !invite (not allowed for Claude)', () => {
    expect(parseClaudeCommand('!invite @bob')).toBeNull();
  });

  test('returns null for !kick (not allowed for Claude)', () => {
    expect(parseClaudeCommand('!kick @alice')).toBeNull();
  });

  test('returns null for !permissions (not allowed for Claude)', () => {
    expect(parseClaudeCommand('!permissions skip')).toBeNull();
  });

  test('returns null for !stop (not allowed for Claude)', () => {
    expect(parseClaudeCommand('!stop')).toBeNull();
  });

  test('returns null for !escape (not allowed for Claude)', () => {
    expect(parseClaudeCommand('!escape')).toBeNull();
  });

  test('returns null for !update (not allowed for Claude)', () => {
    expect(parseClaudeCommand('!update now')).toBeNull();
  });

  test('returns null for inline code containing !cd', () => {
    expect(parseClaudeCommand('Use `!cd /path` to change directories')).toBeNull();
  });

  test('returns null for !cd not on its own line', () => {
    expect(parseClaudeCommand('You can use !cd /path or other commands')).toBeNull();
  });

  test('parses !worktree list', () => {
    const result = parseClaudeCommand('!worktree list');
    expect(result).toEqual({ command: 'worktree list', args: undefined, match: '!worktree list' });
  });

  test('parses !worktree list in multiline text', () => {
    const text = 'Let me check the worktrees.\n\n!worktree list\n\nHere are the results.';
    const result = parseClaudeCommand(text);
    expect(result).toEqual({ command: 'worktree list', args: undefined, match: '!worktree list' });
  });

  test('returns null for !worktree (not just list)', () => {
    // Other worktree subcommands are not allowed
    expect(parseClaudeCommand('!worktree feature-branch')).toBeNull();
  });
});

describe('isClaudeAllowedCommand', () => {
  test('cd is allowed', () => {
    expect(isClaudeAllowedCommand('cd')).toBe(true);
  });

  test('worktree list is allowed', () => {
    expect(isClaudeAllowedCommand('worktree list')).toBe(true);
  });

  test('invite is not allowed', () => {
    expect(isClaudeAllowedCommand('invite')).toBe(false);
  });

  test('kick is not allowed', () => {
    expect(isClaudeAllowedCommand('kick')).toBe(false);
  });

  test('permissions is not allowed', () => {
    expect(isClaudeAllowedCommand('permissions')).toBe(false);
  });

  test('stop is not allowed', () => {
    expect(isClaudeAllowedCommand('stop')).toBe(false);
  });

  test('escape is not allowed', () => {
    expect(isClaudeAllowedCommand('escape')).toBe(false);
  });

  test('kill is not allowed', () => {
    expect(isClaudeAllowedCommand('kill')).toBe(false);
  });
});

describe('removeCommandFromText', () => {
  test('removes command from start of text', () => {
    const parsed = { command: 'cd', args: '/path', match: '!cd /path' };
    expect(removeCommandFromText('!cd /path\n\nSome other text', parsed)).toBe('Some other text');
  });

  test('removes command from middle of text', () => {
    const parsed = { command: 'cd', args: '/path', match: '!cd /path' };
    expect(removeCommandFromText('Before\n\n!cd /path\n\nAfter', parsed)).toBe('Before\n\n\n\nAfter');
  });

  test('handles command as only content', () => {
    const parsed = { command: 'cd', args: '/path', match: '!cd /path' };
    expect(removeCommandFromText('!cd /path', parsed)).toBe('');
  });
});

describe('CLAUDE_ALLOWED_COMMANDS', () => {
  test('only contains safe commands', () => {
    // Safe commands that Claude can execute
    expect(CLAUDE_ALLOWED_COMMANDS.has('cd')).toBe(true);
    expect(CLAUDE_ALLOWED_COMMANDS.has('worktree list')).toBe(true);
    expect(CLAUDE_ALLOWED_COMMANDS.size).toBe(2);
  });
});
