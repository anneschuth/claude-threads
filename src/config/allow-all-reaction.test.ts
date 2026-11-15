import { describe, it, expect, spyOn } from 'bun:test';
import { resolveAllowAllReaction } from './types.js';

describe('resolveAllowAllReaction', () => {
  it('keeps the allow-all reaction when the field is unset or true', () => {
    expect(resolveAllowAllReaction(undefined)).toBe(true);
    expect(resolveAllowAllReaction(null)).toBe(true);
    expect(resolveAllowAllReaction(true)).toBe(true);
  });

  it('removes it for false', () => {
    expect(resolveAllowAllReaction(false)).toBe(false);
  });

  it('removes it for a value it cannot read, and says so', () => {
    // The field takes a permission away. "no", "off" or a quoted "false" is
    // someone trying to do that, so it must not leave allow-all in place.
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveAllowAllReaction('false', 'platforms[x].allowAllReaction')).toBe(false);
      expect(resolveAllowAllReaction('no')).toBe(false);
      expect(resolveAllowAllReaction(0)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(3);
      expect(String(warn.mock.calls[0]?.[0])).toContain('platforms[x].allowAllReaction');
    } finally {
      warn.mockRestore();
    }
  });
});
