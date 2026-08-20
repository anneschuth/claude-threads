import { describe, it, expect } from 'bun:test';
import { dmPlatformId, deriveDmPlatformConfig } from './dm-discovery.js';
import type { MattermostPlatformConfig } from '../config/types.js';

const parent: MattermostPlatformConfig = {
  id: 'mattermost-main',
  type: 'mattermost',
  displayName: 'Main',
  url: 'https://mm.test',
  token: 'tok',
  channelId: 'main-channel',
  botName: 'bot',
  allowedUsers: ['alice', 'bob'],
  directMessages: true,
};

describe('dm platform ids', () => {
  it('derives a deterministic id from parent and channel', () => {
    expect(dmPlatformId('mattermost-main', 'abc123')).toBe('mattermost-main--dm-abc123');
  });
});

describe('deriveDmPlatformConfig', () => {
  it('clones the parent scoped to the DM partner in direct channel mode', () => {
    const cfg = deriveDmPlatformConfig(parent, 'dmchan', ['alice']);

    expect(cfg.id).toBe('mattermost-main--dm-dmchan');
    expect(cfg.channelId).toBe('dmchan');
    expect(cfg.directChannelMode).toBe(true);
    expect(cfg.stickyMessage).toBe('hidden');
    expect(cfg.allowedUsers).toEqual(['alice']);   // partner only, not the parent list
    expect(cfg.directMessages).toBe(false);        // no recursive discovery
    expect(cfg.token).toBe('tok');                 // credentials inherited
  });
});
