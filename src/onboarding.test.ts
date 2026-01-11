import { describe, test, expect } from 'bun:test';
import { deriveDisplayName } from './onboarding.js';

describe('deriveDisplayName', () => {
  describe('hyphenated subdomains', () => {
    test('converts hyphenated subdomain to title case', () => {
      expect(deriveDisplayName('https://acme-corp.mattermost.com')).toBe('Acme Corp');
    });

    test('handles multiple hyphens', () => {
      expect(deriveDisplayName('https://chat-server-prod.internal.company.com')).toBe(
        'Chat Server Prod'
      );
    });

    test('handles pre-release subdomain', () => {
      expect(deriveDisplayName('https://pre-release.mattermost.com')).toBe('Pre Release');
    });
  });

  describe('underscored subdomains', () => {
    test('converts underscored subdomain to title case', () => {
      expect(deriveDisplayName('https://my_team_chat.mattermost.cloud')).toBe('My Team Chat');
    });

    test('handles mixed hyphens and underscores', () => {
      expect(deriveDisplayName('https://team_chat-prod.example.com')).toBe('Team Chat Prod');
    });
  });

  describe('single word subdomains', () => {
    test('capitalizes single word subdomain', () => {
      expect(deriveDisplayName('https://digilab.overheid.nl')).toBe('Digilab');
    });

    test('handles lowercase single word', () => {
      expect(deriveDisplayName('https://chat.example.com')).toBe('Chat');
    });

    test('converts uppercase to title case', () => {
      expect(deriveDisplayName('https://MATTERMOST.company.com')).toBe('Mattermost');
    });
  });

  describe('edge cases', () => {
    test('handles bare domain (no subdomain)', () => {
      expect(deriveDisplayName('https://example.com')).toBe('Example');
    });

    test('returns fallback on invalid URL', () => {
      expect(deriveDisplayName('not-a-valid-url')).toBe('Mattermost');
    });

    test('returns fallback on empty string', () => {
      expect(deriveDisplayName('')).toBe('Mattermost');
    });

    test('handles URL with port', () => {
      expect(deriveDisplayName('https://team-chat.example.com:8065')).toBe('Team Chat');
    });

    test('handles URL with path', () => {
      expect(deriveDisplayName('https://acme-corp.mattermost.com/some/path')).toBe('Acme Corp');
    });
  });

  describe('real-world examples', () => {
    test('community.mattermost.com', () => {
      expect(deriveDisplayName('https://community.mattermost.com')).toBe('Community');
    });

    test('demo-server.mattermost.com', () => {
      expect(deriveDisplayName('https://demo-server.mattermost.com')).toBe('Demo Server');
    });

    test('team-chat.cloud.example.com', () => {
      expect(deriveDisplayName('https://team-chat.cloud.example.com')).toBe('Team Chat');
    });
  });
});
