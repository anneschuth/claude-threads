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

  it('shows no badge for an unfamiliar tier rather than inventing a multiplier', () => {
    // "team_premium_20x" is not necessarily 20× of anything we understand, and
    // the raw field would be published into Slack unvalidated. No badge beats
    // a confident wrong one.
    expect(planLabel({ rateLimitTier: 'enterprise_custom_7x' })).toBeUndefined();
    expect(planLabel({ rateLimitTier: 'default_claude_max_20x_trial' })).toBeUndefined();
    expect(planLabel({ rateLimitTier: 'team_premium_20x' })).toBeUndefined();
  });

  it('still prefers the coarse type when the tier is unfamiliar', () => {
    expect(planLabel({ subscriptionType: 'team', rateLimitTier: 'team_premium_20x' })).toBe('Team');
  });

  it('says nothing rather than guessing when the credential carries neither', () => {
    expect(planLabel({})).toBeUndefined();
  });
});
