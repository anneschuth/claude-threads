import { describe, it, expect } from 'bun:test';
import { statusAnchor, dueForRefresh, STATUS_REFRESH_MS } from './status.js';

describe('statusAnchor', () => {
  it('uses the thread when the session is a real Slack thread', () => {
    expect(statusAnchor('1788329168.925169', '1788329000.111')).toBe('1788329168.925169');
  });

  it('falls back to the last real message in a dynamic channel', () => {
    // In channel-is-a-task mode the session's thread id is synthetic and must
    // never reach Slack. There is no thread to hang a status on, so the status
    // anchors to the last real message the client saw.
    expect(statusAnchor('dcm:C0BU9JM6ASW', '1788329000.111')).toBe('1788329000.111');
  });

  it('has nothing to anchor to before any message has been seen', () => {
    expect(statusAnchor('dcm:C0BU9JM6ASW', null)).toBeUndefined();
    expect(statusAnchor(undefined, null)).toBeUndefined();
  });
});

describe('dueForRefresh', () => {
  const now = 1_000_000;

  it('sends the first time', () => {
    expect(dueForRefresh(undefined, now)).toBe(true);
  });

  it('does not re-send on every tick', () => {
    // startTyping fires every 3s for Mattermost's websocket. Slack's status is
    // an HTTP Tier-3 method, so repeating it at that cadence would burn the
    // rate limit for no gain — the status persists until it is replaced.
    expect(dueForRefresh(now - 3_000, now)).toBe(false);
  });

  it('refreshes once the status has had time to lapse', () => {
    expect(dueForRefresh(now - STATUS_REFRESH_MS - 1, now)).toBe(true);
  });
});
