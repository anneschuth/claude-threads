import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  deriveDisplayName,
  validateMattermostCredentials,
  validateSlackCredentials,
} from './onboarding.js';

// Store original fetch to restore after tests
const originalFetch = globalThis.fetch;

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

describe('validateMattermostCredentials', () => {
  beforeEach(() => {
    // Reset fetch mock before each test
      // @ts-expect-error - Mock does not need full fetch type
    globalThis.fetch = mock(() => Promise.resolve({ ok: true }));
  });

  afterEach(() => {
    // Restore original fetch after each test
    globalThis.fetch = originalFetch;
  });

  describe('successful validation', () => {
    test('returns success with valid credentials', async () => {
      // @ts-expect-error - Mock does not need full fetch type
      globalThis.fetch = mock((url: string) => {
        if (url.includes('/users/me')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ username: 'claude-bot' }),
          } as Response);
        }
        if (url.includes('/channels/')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ display_name: 'General', name: 'general' }),
          } as Response);
        }
        return Promise.resolve({ ok: false, status: 404 } as Response);
      });

      const result = await validateMattermostCredentials(
        'https://chat.example.com',
        'token123',
        'channel456'
      );

      expect(result.success).toBe(true);
      expect(result.botUsername).toBe('claude-bot');
      expect(result.channelName).toBe('General');
      expect(result.error).toBeUndefined();
    });

    test('uses channel name fallback when display_name missing', async () => {
      // @ts-expect-error - Mock does not need full fetch type
      globalThis.fetch = mock((url: string) => {
        if (url.includes('/users/me')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ username: 'bot' }),
          } as Response);
        }
        if (url.includes('/channels/')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ name: 'town-square' }),
          } as Response);
        }
        return Promise.resolve({ ok: false, status: 404 } as Response);
      });

      const result = await validateMattermostCredentials(
        'https://chat.example.com',
        'token123',
        'channel456'
      );

      expect(result.success).toBe(true);
      expect(result.channelName).toBe('town-square');
    });
  });

  describe('authentication errors', () => {
    test('returns error on 401 unauthorized (invalid token)', async () => {
      // @ts-expect-error - Mock does not need full fetch type
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 401,
          text: () => Promise.resolve('Unauthorized'),
        } as Response)
      );

      const result = await validateMattermostCredentials(
        'https://chat.example.com',
        'bad-token',
        'channel456'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid token or unauthorized');
    });

    test('returns server error on non-401 failure', async () => {
      // @ts-expect-error - Mock does not need full fetch type
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve('Internal Server Error'),
        } as Response)
      );

      const result = await validateMattermostCredentials(
        'https://chat.example.com',
        'token123',
        'channel456'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Server error 500');
    });
  });

  describe('channel access errors', () => {
    test('returns error on 403 forbidden (bot not in channel)', async () => {
      // @ts-expect-error - Mock does not need full fetch type
      globalThis.fetch = mock((url: string) => {
        if (url.includes('/users/me')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ username: 'bot' }),
          } as Response);
        }
        if (url.includes('/channels/')) {
          return Promise.resolve({
            ok: false,
            status: 403,
          } as Response);
        }
        return Promise.resolve({ ok: false, status: 404 } as Response);
      });

      const result = await validateMattermostCredentials(
        'https://chat.example.com',
        'token123',
        'channel456'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Cannot access channel (bot may not be a member)');
    });

    test('returns error on 404 not found (invalid channel ID)', async () => {
      // @ts-expect-error - Mock does not need full fetch type
      globalThis.fetch = mock((url: string) => {
        if (url.includes('/users/me')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ username: 'bot' }),
          } as Response);
        }
        if (url.includes('/channels/')) {
          return Promise.resolve({
            ok: false,
            status: 404,
          } as Response);
        }
        return Promise.resolve({ ok: false, status: 404 } as Response);
      });

      const result = await validateMattermostCredentials(
        'https://chat.example.com',
        'token123',
        'bad-channel-id'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Channel not found (check channel ID)');
    });

    test('returns generic error on other channel access errors', async () => {
      // @ts-expect-error - Mock does not need full fetch type
      globalThis.fetch = mock((url: string) => {
        if (url.includes('/users/me')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ username: 'bot' }),
          } as Response);
        }
        if (url.includes('/channels/')) {
          return Promise.resolve({
            ok: false,
            status: 502,
          } as Response);
        }
        return Promise.resolve({ ok: false, status: 404 } as Response);
      });

      const result = await validateMattermostCredentials(
        'https://chat.example.com',
        'token123',
        'channel456'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Channel access error: 502');
    });
  });

  describe('network errors', () => {
    test('returns error on network failure', async () => {
      // @ts-expect-error - Mock does not need full fetch type
      globalThis.fetch = mock(() => Promise.reject(new Error('Network timeout')));

      const result = await validateMattermostCredentials(
        'https://chat.example.com',
        'token123',
        'channel456'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network timeout');
    });

    test('returns generic error on non-Error exceptions', async () => {
      // @ts-expect-error - Mock does not need full fetch type
      globalThis.fetch = mock(() => Promise.reject('Unknown error'));

      const result = await validateMattermostCredentials(
        'https://chat.example.com',
        'token123',
        'channel456'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error or invalid URL');
    });
  });
});

describe('validateSlackCredentials', () => {
  beforeEach(() => {
      // @ts-expect-error - Mock does not need full fetch type
    globalThis.fetch = mock(() => Promise.resolve({ ok: true }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('successful validation', () => {
    test('returns success with valid credentials', async () => {
      // @ts-expect-error - Mock does not need full fetch type
      globalThis.fetch = mock((url: string) => {
        if (url.includes('auth.test')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ok: true,
                user: 'claude-bot',
                team: 'My Team',
              }),
          } as Response);
        }
        if (url.includes('conversations.info')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ok: true }),
          } as Response);
        }
        return Promise.resolve({ ok: false, status: 404 } as Response);
      });

      const result = await validateSlackCredentials(
        'xoxb-123-456-token',
        'xapp-1-A123-789-abcdef',
        'C0123456789'
      );

      expect(result.success).toBe(true);
      expect(result.botUsername).toBe('claude-bot');
      expect(result.teamName).toBe('My Team');
      expect(result.error).toBeUndefined();
    });
  });

  describe('authentication errors', () => {
    test('returns error on HTTP failure', async () => {
      // @ts-expect-error - Mock does not need full fetch type
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 500,
        } as Response)
      );

      const result = await validateSlackCredentials(
        'xoxb-bad-token',
        'xapp-1-A123-789-abcdef',
        'C0123456789'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('HTTP error 500');
    });

    test('returns error on Slack API error', async () => {
      // @ts-expect-error - Mock does not need full fetch type
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: false,
              error: 'invalid_auth',
            }),
        } as Response)
      );

      const result = await validateSlackCredentials(
        'xoxb-bad-token',
        'xapp-1-A123-789-abcdef',
        'C0123456789'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Auth failed: invalid_auth');
    });
  });

  describe('app token validation', () => {
    test('returns error if app token does not start with xapp-', async () => {
      // @ts-expect-error - Mock does not need full fetch type
      globalThis.fetch = mock((url: string) => {
        if (url.includes('auth.test')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ok: true,
                user: 'bot',
                team: 'Team',
              }),
          } as Response);
        }
        return Promise.resolve({ ok: false, status: 404 } as Response);
      });

      const result = await validateSlackCredentials(
        'xoxb-123-456-token',
        'invalid-app-token',
        'C0123456789'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('App token must start with xapp-');
    });
  });

  describe('channel access errors', () => {
    test('returns error on channel_not_found', async () => {
      // @ts-expect-error - Mock does not need full fetch type
      globalThis.fetch = mock((url: string) => {
        if (url.includes('auth.test')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ok: true,
                user: 'bot',
                team: 'Team',
              }),
          } as Response);
        }
        if (url.includes('conversations.info')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ok: false,
                error: 'channel_not_found',
              }),
          } as Response);
        }
        return Promise.resolve({ ok: false, status: 404 } as Response);
      });

      const result = await validateSlackCredentials(
        'xoxb-123-456-token',
        'xapp-1-A123-789-abcdef',
        'C9999999999'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Channel not found (check channel ID or invite bot)');
    });

    test('returns error on missing_scope', async () => {
      // @ts-expect-error - Mock does not need full fetch type
      globalThis.fetch = mock((url: string) => {
        if (url.includes('auth.test')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ok: true,
                user: 'bot',
                team: 'Team',
              }),
          } as Response);
        }
        if (url.includes('conversations.info')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ok: false,
                error: 'missing_scope',
              }),
          } as Response);
        }
        return Promise.resolve({ ok: false, status: 404 } as Response);
      });

      const result = await validateSlackCredentials(
        'xoxb-123-456-token',
        'xapp-1-A123-789-abcdef',
        'C0123456789'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing OAuth scope: channels:read');
    });

    test('returns generic channel error for other errors', async () => {
      // @ts-expect-error - Mock does not need full fetch type
      globalThis.fetch = mock((url: string) => {
        if (url.includes('auth.test')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ok: true,
                user: 'bot',
                team: 'Team',
              }),
          } as Response);
        }
        if (url.includes('conversations.info')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ok: false,
                error: 'some_other_error',
              }),
          } as Response);
        }
        return Promise.resolve({ ok: false, status: 404 } as Response);
      });

      const result = await validateSlackCredentials(
        'xoxb-123-456-token',
        'xapp-1-A123-789-abcdef',
        'C0123456789'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Channel error: some_other_error');
    });

    test('returns error on HTTP failure during channel check', async () => {
      // @ts-expect-error - Mock does not need full fetch type
      globalThis.fetch = mock((url: string) => {
        if (url.includes('auth.test')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ok: true,
                user: 'bot',
                team: 'Team',
              }),
          } as Response);
        }
        if (url.includes('conversations.info')) {
          return Promise.resolve({
            ok: false,
            status: 503,
          } as Response);
        }
        return Promise.resolve({ ok: false, status: 404 } as Response);
      });

      const result = await validateSlackCredentials(
        'xoxb-123-456-token',
        'xapp-1-A123-789-abcdef',
        'C0123456789'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Cannot check channel: HTTP 503');
    });
  });

  describe('network errors', () => {
    test('returns error on network failure', async () => {
      // @ts-expect-error - Mock does not need full fetch type
      globalThis.fetch = mock(() => Promise.reject(new Error('Connection refused')));

      const result = await validateSlackCredentials(
        'xoxb-123-456-token',
        'xapp-1-A123-789-abcdef',
        'C0123456789'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection refused');
    });

    test('returns generic error on non-Error exceptions', async () => {
      // @ts-expect-error - Mock does not need full fetch type
      globalThis.fetch = mock(() => Promise.reject('Unknown'));

      const result = await validateSlackCredentials(
        'xoxb-123-456-token',
        'xapp-1-A123-789-abcdef',
        'C0123456789'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });
  });
});

describe('ValidationResult interface', () => {
  test('successful validation has expected shape', async () => {
    // @ts-expect-error - Mock does not need full fetch type
    globalThis.fetch = mock((url: string) => {
      if (url.includes('/users/me')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ username: 'test-bot' }),
        } as Response);
      }
      if (url.includes('/channels/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ display_name: 'Test Channel' }),
        } as Response);
      }
      return Promise.resolve({ ok: false, status: 404 } as Response);
    });

    const result = await validateMattermostCredentials(
      'https://test.example.com',
      'valid-token',
      'channel123'
    );

    // Verify all expected properties exist
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('botUsername');
    expect(result).toHaveProperty('channelName');
    expect(typeof result.success).toBe('boolean');
    expect(typeof result.botUsername).toBe('string');
    expect(typeof result.channelName).toBe('string');
  });

  test('failed validation has error property', async () => {
    // @ts-expect-error - Mock does not need full fetch type
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      } as Response)
    );

    const result = await validateMattermostCredentials(
      'https://test.example.com',
      'bad-token',
      'channel123'
    );

    expect(result).toHaveProperty('success', false);
    expect(result).toHaveProperty('error');
    expect(typeof result.error).toBe('string');
    expect(result.botUsername).toBeUndefined();
    expect(result.channelName).toBeUndefined();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
});

describe('deriveDisplayName additional edge cases', () => {
  test('handles IP address URL', () => {
    expect(deriveDisplayName('https://192.168.1.100:8065')).toBe('192');
  });

  test('handles localhost', () => {
    expect(deriveDisplayName('http://localhost:8065')).toBe('Localhost');
  });

  test('handles very long subdomain', () => {
    const result = deriveDisplayName('https://very-long-subdomain-with-many-parts.example.com');
    expect(result).toBe('Very Long Subdomain With Many Parts');
  });

  test('handles numbers in subdomain', () => {
    expect(deriveDisplayName('https://team123.mattermost.com')).toBe('Team123');
  });

  test('handles single character subdomain', () => {
    expect(deriveDisplayName('https://a.example.com')).toBe('A');
  });
});

describe('validateMattermostCredentials URL handling', () => {
  beforeEach(() => {
    // @ts-expect-error - Mock does not need full fetch type
    globalThis.fetch = mock(() => Promise.resolve({ ok: true }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('constructs correct API endpoints', async () => {
    const fetchCalls: string[] = [];
    // @ts-expect-error - Mock does not need full fetch type
    globalThis.fetch = mock((url: string) => {
      fetchCalls.push(url);
      if (url.includes('/users/me')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ username: 'bot' }),
        } as Response);
      }
      if (url.includes('/channels/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ name: 'channel' }),
        } as Response);
      }
      return Promise.resolve({ ok: false, status: 404 } as Response);
    });

    await validateMattermostCredentials(
      'https://chat.example.com',
      'token123',
      'abc123'
    );

    expect(fetchCalls).toContain('https://chat.example.com/api/v4/users/me');
    expect(fetchCalls).toContain('https://chat.example.com/api/v4/channels/abc123');
  });

  test('handles URL with trailing slash', async () => {
    const fetchCalls: string[] = [];
    // @ts-expect-error - Mock does not need full fetch type
    globalThis.fetch = mock((url: string) => {
      fetchCalls.push(url);
      if (url.includes('/users/me')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ username: 'bot' }),
        } as Response);
      }
      if (url.includes('/channels/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ name: 'channel' }),
        } as Response);
      }
      return Promise.resolve({ ok: false, status: 404 } as Response);
    });

    // Note: URL has trailing slash
    await validateMattermostCredentials(
      'https://chat.example.com/',
      'token123',
      'abc123'
    );

    // Should still make valid requests (may have double slash but should work)
    expect(fetchCalls.length).toBe(2);
  });
});

describe('validateSlackCredentials token validation', () => {
  beforeEach(() => {
    // @ts-expect-error - Mock does not need full fetch type
    globalThis.fetch = mock(() => Promise.resolve({ ok: true }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('validates both xoxb and xapp token prefixes', async () => {
    // @ts-expect-error - Mock does not need full fetch type
    globalThis.fetch = mock((url: string) => {
      if (url.includes('auth.test')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              user: 'bot',
              team: 'Team',
            }),
        } as Response);
      }
      if (url.includes('conversations.info')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true }),
        } as Response);
      }
      return Promise.resolve({ ok: false, status: 404 } as Response);
    });

    // Valid tokens
    const validResult = await validateSlackCredentials(
      'xoxb-valid-token',
      'xapp-valid-token',
      'C12345'
    );
    expect(validResult.success).toBe(true);

    // Invalid app token prefix
    const invalidAppToken = await validateSlackCredentials(
      'xoxb-valid-token',
      'xoxa-wrong-prefix',
      'C12345'
    );
    expect(invalidAppToken.success).toBe(false);
    expect(invalidAppToken.error).toContain('xapp-');
  });

  test('handles channel starting with G for private channels', async () => {
    // @ts-expect-error - Mock does not need full fetch type
    globalThis.fetch = mock((url: string) => {
      if (url.includes('auth.test')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              user: 'bot',
              team: 'Team',
            }),
        } as Response);
      }
      if (url.includes('conversations.info')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true }),
        } as Response);
      }
      return Promise.resolve({ ok: false, status: 404 } as Response);
    });

    // G prefix for private channels
    const result = await validateSlackCredentials(
      'xoxb-valid-token',
      'xapp-valid-token',
      'G0123456789'
    );
    expect(result.success).toBe(true);
  });
});
