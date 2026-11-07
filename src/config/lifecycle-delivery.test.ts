import { describe, test, expect } from 'bun:test';
import { resolveLifecycleDelivery } from './types.js';

describe('resolveLifecycleDelivery', () => {
  test('defaults to post, so an existing config behaves exactly as before', () => {
    expect(resolveLifecycleDelivery(undefined, 'platforms[x].lifecycleDelivery')).toBe('post');
    expect(resolveLifecycleDelivery(null, 'platforms[x].lifecycleDelivery')).toBe('post');
  });

  test('accepts the three delivery styles', () => {
    for (const value of ['post', 'dedup', 'reaction'] as const) {
      expect(resolveLifecycleDelivery(value, 'platforms[x].lifecycleDelivery')).toBe(value);
    }
  });

  test('rejects anything else with the field path', () => {
    expect(() => resolveLifecycleDelivery('silent', 'platforms[slack-a].lifecycleDelivery'))
      .toThrow('platforms[slack-a].lifecycleDelivery');
    expect(() => resolveLifecycleDelivery(true, 'dm[dm-a].lifecycleDelivery')).toThrow('dm[dm-a].lifecycleDelivery');
  });
});
