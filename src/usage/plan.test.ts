import { describe, it, expect } from 'bun:test';
import { planLabel } from './plan.js';

describe('planLabel', () => {
  it('reads the multiplier out of the rate-limit tier', () => {
    // Measured on real seats: rateLimitTier is "default_claude_max_20x" and
    // subscriptionType is just "max" — the tier is where the 20x lives, and
    // 20x vs 5x is the whole point of showing it.
    expect(planLabel({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' })).toBe('Max 20×');
    expect(planLabel({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' })).toBe('Max 5×');
  });

  it('handles tiers with no multiplier', () => {
    expect(planLabel({ subscriptionType: 'pro', rateLimitTier: 'default_claude_pro' })).toBe('Pro');
  });

  it('falls back to the subscription type when the tier is unfamiliar', () => {
    // New tiers ship without warning; showing "Team" beats showing nothing,
    // and beats inventing a multiplier we did not read.
    expect(planLabel({ subscriptionType: 'team', rateLimitTier: 'something_new_entirely' })).toBe('Team');
  });

  it('shows an unfamiliar tier verbatim when there is no type to fall back on', () => {
    expect(planLabel({ rateLimitTier: 'enterprise_custom_7x' })).toBe('Enterprise custom 7×');
  });

  it('says nothing rather than guessing when the credential carries neither', () => {
    expect(planLabel({})).toBeUndefined();
  });
});
