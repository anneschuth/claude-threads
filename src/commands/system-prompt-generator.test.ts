/**
 * Tests for the system prompt generator
 */

import { describe, it, expect } from 'bun:test';
import {
  generateChatPlatformPrompt,
  buildSessionContext,
  buildCollaboratorContext,
  resolveCollaborators,
  formatCollaboratorListForChat,
  buildAppendSystemPrompt,
  type ResolvedCollaborator,
} from './system-prompt-generator.js';
import { VERSION } from '../version.js';
import type { PlatformUser } from '../platform/types.js';

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
  const mattermostPlatform = {
    platformType: 'mattermost',
    displayName: 'Test Server',
    getThreadLink: (threadId: string) => `https://chat.example.com/_redirect/pl/${threadId}`,
  };

  const slackPlatform = {
    platformType: 'slack',
    displayName: 'Workspace',
    getThreadLink: (threadId: string) => `https://slack.example.com/archives/C123/p${threadId}`,
  };

  it('formats platform and working directory', () => {
    const context = buildSessionContext(mattermostPlatform, '/home/user/project', 'thread-1');

    expect(context).toContain('Platform:');
    expect(context).toContain('Mattermost');
    expect(context).toContain('Test Server');
    expect(context).toContain('Working Directory:');
    expect(context).toContain('/home/user/project');
  });

  it('capitalizes platform type', () => {
    const context = buildSessionContext(slackPlatform, '/path', 'thread-1');

    expect(context).toContain('Slack');
    // The full string still contains lowercase 'slack' inside the URL —
    // assert that the *capitalized* form precedes the URL segment so the
    // intent of the assertion (label, not URL) is preserved.
    const labelSegment = context.split('|')[0];
    expect(labelSegment).toContain('Slack');
    expect(labelSegment).not.toMatch(/\bslack\b/);
  });

  it('includes the Thread permalink so Claude can reference the conversation', () => {
    // Regression-defender: the chat link is what lets Claude paste a
    // back-reference into MR/ticket descriptions it generates. Without
    // this segment that affordance is gone — Claude has no way to know
    // the thread URL.
    const captured: string[] = [];
    const platform = {
      platformType: 'mattermost',
      displayName: 'Team',
      getThreadLink: (threadId: string) => {
        captured.push(threadId);
        return `https://chat.example.com/_redirect/pl/${threadId}`;
      },
    };

    const context = buildSessionContext(platform, '/repo', 'thread-abc');

    expect(captured).toEqual(['thread-abc']);
    expect(context).toContain('**Thread:**');
    expect(context).toContain('https://chat.example.com/_redirect/pl/thread-abc');
  });
});

// ---------------------------------------------------------------------------
// Collaborator co-author attribution
// ---------------------------------------------------------------------------

function fakePlatform(users: Record<string, PlatformUser | null>) {
  return {
    platformType: 'mattermost',
    displayName: 'Test',
    getThreadLink: (id: string) => `https://example.com/${id}`,
    async getUserByUsername(username: string): Promise<PlatformUser | null> {
      return users[username] ?? null;
    },
  };
}

describe('resolveCollaborators', () => {
  it('returns empty when only the owner is in the set', async () => {
    const platform = fakePlatform({});
    const result = await resolveCollaborators(platform, 'alice', ['alice']);
    expect(result).toEqual([]);
  });

  it('skips the owner', async () => {
    const platform = fakePlatform({
      bob: { id: 'b', username: 'bob', displayName: 'Bob B', email: 'bob@example.com' },
    });
    const result = await resolveCollaborators(platform, 'alice', ['alice', 'bob']);
    expect(result).toEqual([{ username: 'bob', name: 'Bob B', email: 'bob@example.com' }]);
  });

  it('skips collaborators with no email (cannot form co-author trailer)', async () => {
    const platform = fakePlatform({
      bob: { id: 'b', username: 'bob', displayName: 'Bob B' }, // no email
      carol: { id: 'c', username: 'carol', email: 'carol@example.com' }, // no displayName
    });
    const result = await resolveCollaborators(platform, 'alice', ['alice', 'bob', 'carol']);
    expect(result).toEqual([
      { username: 'carol', name: 'carol', email: 'carol@example.com' },
    ]);
  });

  it('skips users that the platform does not know about', async () => {
    const platform = fakePlatform({}); // returns null for everyone
    const result = await resolveCollaborators(platform, 'alice', ['alice', 'ghost']);
    expect(result).toEqual([]);
  });

  it('survives a thrown lookup error and continues with the rest', async () => {
    const platform = {
      platformType: 'mattermost',
      displayName: 'Test',
      getThreadLink: (id: string) => `https://example.com/${id}`,
      async getUserByUsername(username: string): Promise<PlatformUser | null> {
        if (username === 'broken') throw new Error('flaky API');
        return { id: 'c', username, displayName: username, email: `${username}@x.com` };
      },
    };
    const result = await resolveCollaborators(platform, 'alice', ['alice', 'broken', 'carol']);
    expect(result).toEqual([{ username: 'carol', name: 'carol', email: 'carol@x.com' }]);
  });
});

describe('buildCollaboratorContext', () => {
  it('falls back to a single-line standby instruction when there are no collaborators', () => {
    // Solo sessions don't need the full rule yet — but the system prompt still
    // has to teach Claude the "Collaborators updated" thread convention,
    // otherwise a later !invite would post a notice Claude doesn't recognize.
    const section = buildCollaboratorContext([]);
    expect(section).toContain('"Collaborators updated"');
    expect(section).toContain('Co-Authored-By:');
    // Compactness: a few lines, not a full section with header.
    expect(section).not.toContain('## Git commit attribution');
    expect(section.split('\n').length).toBeLessThanOrEqual(2);
  });

  it('lists current collaborators in the Co-Authored-By format', () => {
    const collaborators: ResolvedCollaborator[] = [
      { username: 'bob', name: 'Bob B', email: 'bob@example.com' },
      { username: 'carol', name: 'Carol C', email: 'carol@example.com' },
    ];
    const section = buildCollaboratorContext(collaborators);
    expect(section).toContain('- Bob B <bob@example.com>');
    expect(section).toContain('- Carol C <carol@example.com>');
    expect(section).toContain('supersedes this one');
  });

  it('disambiguates who Claude must not co-author (owner is author, no bot, no AI) — full form', () => {
    // "yourself" was ambiguous — Claude could read it as the bot or as the
    // owner. Spell out both: owner is the implicit author; no bot/AI trailers.
    const section = buildCollaboratorContext([
      { username: 'bob', name: 'Bob', email: 'bob@example.com' },
    ]);
    expect(section).toMatch(/session\s+owner/);
    expect(section).toMatch(/implicit\s+author/);
    expect(section).toContain('the bot');
    expect(section).toContain('AI assistant');
  });

  it('disambiguates the standby one-liner too (same exclusion list)', () => {
    // The empty-state form is shown to solo sessions — it must give the
    // same exclusion guidance, not fall back to ambiguous "yourself".
    const section = buildCollaboratorContext([]);
    expect(section).toMatch(/session\s+owner/);
    expect(section).toMatch(/implicit\s+author/);
    expect(section).toContain('AI assistant');
    expect(section).not.toMatch(/\byourself\b/);
  });
});

describe('formatCollaboratorListForChat', () => {
  it('returns empty string for empty list (caller produces the "no co-authors" sentence)', () => {
    expect(formatCollaboratorListForChat([])).toBe('');
  });

  it('joins names + emails with comma+space', () => {
    const out = formatCollaboratorListForChat([
      { username: 'bob', name: 'Bob B', email: 'bob@x.com' },
      { username: 'carol', name: 'Carol', email: 'c@x.com' },
    ]);
    expect(out).toBe('Bob B <bob@x.com>, Carol <c@x.com>');
  });
});

describe('buildAppendSystemPrompt', () => {
  it('still teaches the "Collaborators updated" convention in solo sessions', async () => {
    // Even when there are no collaborators, Claude must know the convention —
    // otherwise a later !invite during this same session won't be honored.
    const platform = fakePlatform({});
    const prompt = await buildAppendSystemPrompt(
      platform,
      '/repo',
      't1',
      'alice',
      ['alice'],
      'STATIC_PROMPT_BODY',
    );
    expect(prompt).toContain('STATIC_PROMPT_BODY');
    expect(prompt).toContain('"Collaborators updated"');
    expect(prompt).toContain('Co-Authored-By:');
    // Don't dump the heavy section header in solo sessions.
    expect(prompt).not.toContain('## Git commit attribution');
  });

  it('includes resolved collaborators when there are any', async () => {
    const platform = fakePlatform({
      bob: { id: 'b', username: 'bob', displayName: 'Bob B', email: 'bob@x.com' },
    });
    const prompt = await buildAppendSystemPrompt(
      platform,
      '/repo',
      't1',
      'alice',
      ['alice', 'bob'],
      'STATIC',
    );
    expect(prompt).toContain('- Bob B <bob@x.com>');
  });

  it('omits the session-context line when omitSessionContext is set (worktree respawn case)', async () => {
    // Worktree respawn after Claude already has a title: the session-context
    // preamble is dropped to keep the prompt small, but the chat-platform
    // prompt and collaborator section MUST still be there.
    const platform = fakePlatform({});
    const prompt = await buildAppendSystemPrompt(
      platform,
      '/repo',
      't1',
      'alice',
      ['alice'],
      'STATIC',
      { omitSessionContext: true },
    );
    expect(prompt).not.toContain('**Platform:**');
    expect(prompt).not.toContain('**Working Directory:**');
    expect(prompt).toContain('STATIC');
    expect(prompt).toContain('"Collaborators updated"');
  });

  it('survives a legacy persisted session that lacks sessionAllowedUsers entries', async () => {
    // Backward-compat: lifecycle.resumeSession defaults to `[startedBy]` when
    // the persisted set is missing. Verify that the helper degrades gracefully
    // when called with just the owner (which is what that fallback yields).
    const platform = fakePlatform({});
    const prompt = await buildAppendSystemPrompt(
      platform,
      '/repo',
      't1',
      'alice',
      ['alice'], // legacy fallback shape: only the owner
      'STATIC',
    );
    expect(prompt).toContain('STATIC');
    // No exception, falls to the standby one-liner.
    expect(prompt).toContain('"Collaborators updated"');
  });
});

