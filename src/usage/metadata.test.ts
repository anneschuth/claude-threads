import { describe, it, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { metadataCandidates } from './client.js';

describe('metadataCandidates', () => {
  it('looks inside the config dir first — the CLAUDE_CONFIG_DIR layout', () => {
    // ~/.claude-vvs/.claude.json — verified on both machines.
    expect(metadataCandidates('/home/almir/.claude-vvs')[0]).toBe(
      '/home/almir/.claude-vvs/.claude.json'
    );
  });

  it('also looks at the sibling — the HOME layout pooled accounts use', () => {
    // A pool account has home=/x and credentials at /x/.claude, but its
    // .claude.json sits at /x/.claude.json, NOT inside. Looking only inside
    // leaves every pooled account with no email and no plan badge — silently,
    // since both readers swallow a miss.
    expect(metadataCandidates('/home/herder/accounts/work/.claude')).toContain(
      '/home/herder/accounts/work/.claude.json'
    );
  });

  it('offers each location once', () => {
    const candidates = metadataCandidates('/home/almir/.claude-vvs');
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});

describe('accountEmail across both layouts', () => {
  it('finds the account when the metadata is a sibling of the config dir', async () => {
    const { accountEmail } = await import('./client.js');
    const home = await mkdtemp(path.join(tmpdir(), 'usage-meta-'));
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'pooled@example.test' } })
    );

    expect(await accountEmail(path.join(home, '.claude'))).toBe('pooled@example.test');
  });
});
