import { describe, it, expect } from 'bun:test';
import { getLogo } from './logo.js';

describe('getLogo', () => {
  it('returns ASCII art logo with version', () => {
    const logo = getLogo('1.0.0');

    expect(logo).toContain('claude-threads');
    expect(logo).toContain('v1.0.0');
    expect(logo).toContain('Claude Code');
  });

  it('wraps logo in code block', () => {
    const logo = getLogo('2.0.0');

    expect(logo.startsWith('```')).toBe(true);
    expect(logo.endsWith('```')).toBe(true);
  });

  it('includes version parameter in output', () => {
    const version = '0.39.0';
    const logo = getLogo(version);

    expect(logo).toContain(`v${version}`);
  });

  it('contains decorative sparkle characters', () => {
    const logo = getLogo('1.0.0');

    expect(logo).toContain('✴');
  });
});
