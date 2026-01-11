/**
 * Tests for the unified command registry
 */

import { describe, it, expect } from 'bun:test';
import {
  COMMAND_REGISTRY,
  REACTION_REGISTRY,
  getCommandsByCategory,
  getUserHelpCommands,
  getClaudeExecutableCommands,
  getClaudeAvoidCommands,
  getCommand,
  getReactionsByContext,
  buildClaudeAllowedCommandsSet,
} from './registry.js';

describe('COMMAND_REGISTRY', () => {
  it('contains expected commands', () => {
    const commandNames = COMMAND_REGISTRY.map(c => c.command);

    // Session control
    expect(commandNames).toContain('stop');
    expect(commandNames).toContain('escape');
    expect(commandNames).toContain('approve');

    // Worktree
    expect(commandNames).toContain('worktree');

    // Collaboration
    expect(commandNames).toContain('invite');
    expect(commandNames).toContain('kick');

    // Settings
    expect(commandNames).toContain('cd');
    expect(commandNames).toContain('permissions');

    // System
    expect(commandNames).toContain('update');
    expect(commandNames).toContain('kill');
    expect(commandNames).toContain('bug');
  });

  it('has valid categories for all commands', () => {
    const validCategories = ['session', 'worktree', 'collaboration', 'settings', 'system', 'passthrough'];

    for (const cmd of COMMAND_REGISTRY) {
      expect(validCategories).toContain(cmd.category);
    }
  });

  it('has valid audience for all commands', () => {
    const validAudiences = ['user', 'claude', 'both'];

    for (const cmd of COMMAND_REGISTRY) {
      expect(validAudiences).toContain(cmd.audience);
    }
  });
});

describe('REACTION_REGISTRY', () => {
  it('contains expected reactions', () => {
    const emojis = REACTION_REGISTRY.map(r => r.emoji);

    expect(emojis).toContain('👍');
    expect(emojis).toContain('👎');
    expect(emojis).toContain('✅');
    expect(emojis).toContain('⏸️');
    expect(emojis).toContain('❌');
    expect(emojis).toContain('🛑');
  });

  it('has valid contexts for all reactions', () => {
    const validContexts = ['approval', 'session', 'both'];

    for (const reaction of REACTION_REGISTRY) {
      expect(validContexts).toContain(reaction.context);
    }
  });
});

describe('getCommandsByCategory', () => {
  it('returns session commands', () => {
    const sessionCommands = getCommandsByCategory('session');
    const names = sessionCommands.map(c => c.command);

    expect(names).toContain('stop');
    expect(names).toContain('escape');
    expect(names).toContain('approve');
  });

  it('returns worktree commands', () => {
    const worktreeCommands = getCommandsByCategory('worktree');
    const names = worktreeCommands.map(c => c.command);

    expect(names).toContain('worktree');
  });

  it('returns empty array for unknown category', () => {
    const unknown = getCommandsByCategory('unknown' as any);
    expect(unknown).toHaveLength(0);
  });
});

describe('getUserHelpCommands', () => {
  it('excludes passthrough commands', () => {
    const helpCommands = getUserHelpCommands();
    const categories = helpCommands.map(c => c.category);

    expect(categories).not.toContain('passthrough');
  });

  it('includes user and both audience commands', () => {
    const helpCommands = getUserHelpCommands();

    for (const cmd of helpCommands) {
      expect(['user', 'both']).toContain(cmd.audience);
    }
  });
});

describe('getClaudeExecutableCommands', () => {
  it('returns commands Claude can execute', () => {
    const claudeCommands = getClaudeExecutableCommands();
    const names = claudeCommands.map(c => c.command);

    // These should be executable by Claude
    expect(names).toContain('cd');
    expect(names).toContain('worktree');
  });

  it('excludes commands marked as "do not use"', () => {
    const claudeCommands = getClaudeExecutableCommands();
    const names = claudeCommands.map(c => c.command);

    // These should NOT be in the executable list
    expect(names).not.toContain('stop');
    expect(names).not.toContain('escape');
  });
});

describe('getClaudeAvoidCommands', () => {
  it('returns commands Claude should avoid', () => {
    const avoidCommands = getClaudeAvoidCommands();
    const names = avoidCommands.map(c => c.command);

    // These should be in the avoid list
    expect(names).toContain('stop');
    expect(names).toContain('escape');
    expect(names).toContain('invite');
    expect(names).toContain('kick');
    expect(names).toContain('permissions');
  });

  it('includes reason for each command', () => {
    const avoidCommands = getClaudeAvoidCommands();

    for (const cmd of avoidCommands) {
      expect(cmd.reason).toBeTruthy();
      expect(typeof cmd.reason).toBe('string');
    }
  });
});

describe('getCommand', () => {
  it('returns command by name', () => {
    const cmd = getCommand('stop');
    expect(cmd).toBeDefined();
    expect(cmd?.command).toBe('stop');
  });

  it('returns undefined for unknown command', () => {
    const cmd = getCommand('unknown');
    expect(cmd).toBeUndefined();
  });
});

describe('getReactionsByContext', () => {
  it('returns approval reactions', () => {
    const approvalReactions = getReactionsByContext('approval');
    const emojis = approvalReactions.map(r => r.emoji);

    expect(emojis).toContain('👍');
    expect(emojis).toContain('👎');
    expect(emojis).toContain('✅');
  });

  it('returns session reactions', () => {
    const sessionReactions = getReactionsByContext('session');
    const emojis = sessionReactions.map(r => r.emoji);

    expect(emojis).toContain('⏸️');
    expect(emojis).toContain('❌');
    expect(emojis).toContain('🛑');
  });
});

describe('buildClaudeAllowedCommandsSet', () => {
  it('returns a Set of allowed commands', () => {
    const allowed = buildClaudeAllowedCommandsSet();

    expect(allowed).toBeInstanceOf(Set);
    expect(allowed.size).toBeGreaterThan(0);
  });

  it('includes cd command', () => {
    const allowed = buildClaudeAllowedCommandsSet();
    expect(allowed.has('cd')).toBe(true);
  });

  it('includes worktree list subcommand', () => {
    const allowed = buildClaudeAllowedCommandsSet();
    expect(allowed.has('worktree list')).toBe(true);
  });

  it('includes bug command', () => {
    const allowed = buildClaudeAllowedCommandsSet();
    expect(allowed.has('bug')).toBe(true);
  });

  it('does not include user-only commands', () => {
    const allowed = buildClaudeAllowedCommandsSet();

    expect(allowed.has('stop')).toBe(false);
    expect(allowed.has('escape')).toBe(false);
    expect(allowed.has('invite')).toBe(false);
    expect(allowed.has('kick')).toBe(false);
    expect(allowed.has('kill')).toBe(false);
  });
});
