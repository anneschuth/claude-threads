import { describe, it, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { accountPlan, metadataCandidates } from './profiles.js';

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
    const { accountEmail } = await import('./profiles.js');
    const home = await mkdtemp(path.join(tmpdir(), 'usage-meta-'));
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'pooled@example.test' } })
    );

    expect(await accountEmail(path.join(home, '.claude'))).toBe('pooled@example.test');
  });
});

describe('accountPlan (from .claude.json, never from credentials)', () => {
  async function seatWith(oauthAccount: Record<string, unknown>): Promise<string> {
    const home = await mkdtemp(path.join(tmpdir(), 'seat-'));
    const configDir = path.join(home, '.claude');
    await mkdir(configDir, { recursive: true });
    // The HOME layout: .claude.json is a SIBLING of .claude/.
    await writeFile(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount }));
    return configDir;
  }

  it('reads the multiplier tier the profile metadata already carries', async () => {
    // Measured on a real seat: organizationRateLimitTier is where the
    // multiplier lives. Reading it here is why nothing in !usage has to open
    // .credentials.json or the macOS Keychain.
    const configDir = await seatWith({
      organizationType: 'claude_max',
      organizationRateLimitTier: 'default_claude_max_20x',
    });

    expect(await accountPlan(configDir)).toBe('Max 20×');
  });

  it("prefers the seat's own tier over the organization's", async () => {
    // A seat inside an org can sit on a different tier from the org, and the
    // seat's tier is the one its windows are actually sized by.
    const configDir = await seatWith({
      organizationType: 'claude_max',
      organizationRateLimitTier: 'default_claude_max_20x',
      userRateLimitTier: 'default_claude_max_5x',
    });

    expect(await accountPlan(configDir)).toBe('Max 5×');
  });

  it('falls back to the coarse plan when the tier is unfamiliar', async () => {
    // Never invent a multiplier: "team_premium_20x" is not necessarily 20×.
    const configDir = await seatWith({
      organizationType: 'claude_pro',
      organizationRateLimitTier: 'something_new_we_have_not_seen',
    });

    expect(await accountPlan(configDir)).toBe('Pro');
  });

  it('has no badge at all for a seat whose metadata says nothing', async () => {
    const configDir = await seatWith({ emailAddress: 'a@b.test' });

    expect(await accountPlan(configDir)).toBeUndefined();
  });
});
