/**
 * Tests for the system prompt generator
 */

import { describe, it, expect } from 'bun:test';
import {
  generateChatPlatformPrompt,
  buildSessionContext,
} from './system-prompt-generator.js';
import { VERSION } from '../version.js';

describe('generateChatPlatformPrompt', () => {
  it('generates a non-empty prompt', () => {
    const prompt = generateChatPlatformPrompt();

    expect(prompt).toBeTruthy();
    expect(prompt.length).toBeGreaterThan(500);
  });

  it('includes version information', () => {
    const prompt = generateChatPlatformPrompt();

    expect(prompt).toContain('Claude Threads Version:');
    expect(prompt).toContain(VERSION);
  });

  it('includes How This Works section', () => {
    const prompt = generateChatPlatformPrompt();

    expect(prompt).toContain('## How This Works');
    expect(prompt).toContain('Claude Code running as a bot');
  });

  it('includes Permissions & Interactions section', () => {
    const prompt = generateChatPlatformPrompt();

    expect(prompt).toContain('## Permissions & Interactions');
    expect(prompt).toContain('Permission requests');
  });

  it('includes User Commands section', () => {
    const prompt = generateChatPlatformPrompt();

    expect(prompt).toContain('## User Commands');
    expect(prompt).toContain('`!stop`');
    expect(prompt).toContain('`!escape`');
    expect(prompt).toContain('`!approve`');
    expect(prompt).toContain('`!invite @user`');
    expect(prompt).toContain('`!kick @user`');
    expect(prompt).toContain('`!cd');
    expect(prompt).toContain('`!permissions');
    expect(prompt).toContain('`!update`');
  });

  it('includes Commands You Can Execute section', () => {
    const prompt = generateChatPlatformPrompt();

    expect(prompt).toContain('## Commands You Can Execute');
    expect(prompt).toContain('`!worktree list`');
    expect(prompt).toContain('`!cd');
  });

  it('includes Commands Claude should NOT use', () => {
    const prompt = generateChatPlatformPrompt();

    expect(prompt).toContain('Commands you should NOT use');
    expect(prompt).toContain('`!stop`');
    expect(prompt).toContain('`!escape`');
  });

  it('warns about !cd spawning new instance', () => {
    const prompt = generateChatPlatformPrompt();

    expect(prompt).toContain('WARNING');
    expect(prompt).toContain("won't remember this conversation");
  });
});

describe('buildSessionContext', () => {
  it('formats platform and working directory', () => {
    const context = buildSessionContext(
      { platformType: 'mattermost', displayName: 'Test Server' },
      '/home/user/project'
    );

    expect(context).toContain('Platform:');
    expect(context).toContain('Mattermost');
    expect(context).toContain('Test Server');
    expect(context).toContain('Working Directory:');
    expect(context).toContain('/home/user/project');
  });

  it('capitalizes platform type', () => {
    const context = buildSessionContext(
      { platformType: 'slack', displayName: 'Workspace' },
      '/path'
    );

    expect(context).toContain('Slack');
    expect(context).not.toContain('slack');
  });
});

