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

function fakeStore(emails: Record<string, Record<string, string>>) {
  return {
    get(platformId: string, username: string): string | undefined {
      return emails[platformId]?.[username];
    },
  };
}

describe('resolveCollaborators', () => {
  it('returns empty when only the owner is in the set', async () => {
    const platform = fakePlatform({});
    const store = fakeStore({});
    const result = await resolveCollaborators(platform, 'mm', 'alice', ['alice'], store);
    expect(result).toEqual([]);
  });

  it('skips the owner', async () => {
    const platform = fakePlatform({
      bob: { id: 'b', username: 'bob', displayName: 'Bob B' },
    });
    const store = fakeStore({ mm: { bob: '111+bob@users.noreply.github.com' } });
    const result = await resolveCollaborators(platform, 'mm', 'alice', ['alice', 'bob'], store);
    expect(result).toEqual([{ username: 'bob', name: 'Bob B', email: '111+bob@users.noreply.github.com' }]);
  });

  it('skips collaborators without a registered noreply email (privacy)', async () => {
    // We never read the platform email — it would leak to the chat thread
    // and the local Claude history. Bob has no registration → no co-author.
    const platform = fakePlatform({
      bob: { id: 'b', username: 'bob', displayName: 'Bob B', email: 'bob@example.com' },
      carol: { id: 'c', username: 'carol' },
    });
    const store = fakeStore({ mm: { carol: '222+carol@users.noreply.github.com' } });
    const result = await resolveCollaborators(platform, 'mm', 'alice', ['alice', 'bob', 'carol'], store);
    expect(result).toEqual([
      { username: 'carol', name: 'carol', email: '222+carol@users.noreply.github.com' },
    ]);
  });

  it('keeps the user even when the platform display-name lookup fails', async () => {
    // Display name lookup failures are best-effort: we still tag the
    // co-author, falling back to username for the human-readable part.
    const platform = {
      platformType: 'mattermost',
      displayName: 'Test',
      getThreadLink: (id: string) => `https://example.com/${id}`,
      async getUserByUsername(_: string): Promise<PlatformUser | null> {
        throw new Error('flaky API');
      },
    };
    const store = fakeStore({ mm: { carol: '222+carol@users.noreply.github.com' } });
    const result = await resolveCollaborators(platform, 'mm', 'alice', ['alice', 'carol'], store);
    expect(result).toEqual([{ username: 'carol', name: 'carol', email: '222+carol@users.noreply.github.com' }]);
  });

  it('isolates registrations per platform (same username on two platforms)', async () => {
    const platform = fakePlatform({
      bob: { id: 'b', username: 'bob', displayName: 'Bob B' },
    });
    const store = fakeStore({
      mm: { bob: '111+bob@users.noreply.github.com' },
      slack: { bob: '999+bob@users.noreply.github.com' },
    });
    const onMm = await resolveCollaborators(platform, 'mm', 'alice', ['alice', 'bob'], store);
    const onSlack = await resolveCollaborators(platform, 'slack', 'alice', ['alice', 'bob'], store);
    expect(onMm[0].email).toBe('111+bob@users.noreply.github.com');
    expect(onSlack[0].email).toBe('999+bob@users.noreply.github.com');
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
    const platform = fakePlatform({});
    const prompt = await buildAppendSystemPrompt(
      platform,
      'mm',
      '/repo',
      't1',
      'alice',
      ['alice'],
      'STATIC_PROMPT_BODY',
      fakeStore({}),
    );
    expect(prompt).toContain('STATIC_PROMPT_BODY');
    expect(prompt).toContain('"Collaborators updated"');
    expect(prompt).toContain('Co-Authored-By:');
    expect(prompt).not.toContain('## Git commit attribution');
  });

  it('includes resolved collaborators when registered in the store', async () => {
    const platform = fakePlatform({
      bob: { id: 'b', username: 'bob', displayName: 'Bob B' },
    });
    const prompt = await buildAppendSystemPrompt(
      platform,
      'mm',
      '/repo',
      't1',
      'alice',
      ['alice', 'bob'],
      'STATIC',
      fakeStore({ mm: { bob: '111+bob@users.noreply.github.com' } }),
    );
    expect(prompt).toContain('- Bob B <111+bob@users.noreply.github.com>');
  });

  it('omits the session-context line when omitSessionContext is set (worktree respawn case)', async () => {
    const platform = fakePlatform({});
    const prompt = await buildAppendSystemPrompt(
      platform,
      'mm',
      '/repo',
      't1',
      'alice',
      ['alice'],
      'STATIC',
      fakeStore({}),
      { omitSessionContext: true },
    );
    expect(prompt).not.toContain('**Platform:**');
    expect(prompt).not.toContain('**Working Directory:**');
    expect(prompt).toContain('STATIC');
    expect(prompt).toContain('"Collaborators updated"');
  });

  it('survives a legacy persisted session that lacks sessionAllowedUsers entries', async () => {
    const platform = fakePlatform({});
    const prompt = await buildAppendSystemPrompt(
      platform,
      'mm',
      '/repo',
      't1',
      'alice',
      ['alice'],
      'STATIC',
      fakeStore({}),
    );
    expect(prompt).toContain('STATIC');
    expect(prompt).toContain('"Collaborators updated"');
  });

  it('does not leak platform email even when the platform exposes one (privacy)', async () => {
    // Regression-defender: an earlier version read `user.email` from the
    // platform API and put it into Co-Authored-By trailers. That leaked
    // private addresses into the chat thread and into the local Claude
    // conversation history. The store-only path must NEVER tag a user
    // whose entry is absent, regardless of the platform reply.
    const platform = fakePlatform({
      bob: { id: 'b', username: 'bob', displayName: 'Bob B', email: 'bob@private.example.com' },
    });
    const prompt = await buildAppendSystemPrompt(
      platform,
      'mm',
      '/repo',
      't1',
      'alice',
      ['alice', 'bob'],
      'STATIC',
      fakeStore({}), // bob has not registered
    );
    expect(prompt).not.toContain('bob@private.example.com');
    expect(prompt).not.toContain('- Bob B');
  });
});

