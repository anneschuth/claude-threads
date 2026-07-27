import { describe, it, expect } from 'bun:test';
import { formatUserTurn, sanitizeUsername, shouldAttribute } from './formatter.js';

describe('formatUserTurn', () => {
  it('prefixes a normal message with the sanitized login when enabled', () => {
    expect(formatUserTurn('deploy the app', 'alice.smith', true)).toBe('[@alice.smith]: deploy the app');
  });

  it('returns the message unchanged when attribution is disabled', () => {
    expect(formatUserTurn('deploy the app', 'alice.smith', false)).toBe('deploy the app');
  });

  it('returns the message unchanged when username is undefined', () => {
    expect(formatUserTurn('run tests', undefined, true)).toBe('run tests');
  });

  it('returns the message unchanged when username is empty', () => {
    expect(formatUserTurn('run tests', '', true)).toBe('run tests');
  });

  it('returns the message unchanged for the "unknown" sentinel (case-insensitive)', () => {
    expect(formatUserTurn('run tests', 'unknown', true)).toBe('run tests');
    expect(formatUserTurn('run tests', 'Unknown', true)).toBe('run tests');
  });

  it('returns the message unchanged when the username sanitizes to empty', () => {
    expect(formatUserTurn('run tests', '@@@', true)).toBe('run tests');
  });

  it('strips unsafe characters from the username but not the message body', () => {
    expect(formatUserTurn('use <angle> & [brackets]', 'a l/i>ce', true)).toBe('[@alice]: use <angle> & [brackets]');
  });

  it('keeps a multi-line body intact after the inline prefix', () => {
    expect(formatUserTurn('line one\nline two', 'bob', true)).toBe('[@bob]: line one\nline two');
  });
});

describe('sanitizeUsername', () => {
  it('keeps login-shaped characters', () => {
    expect(sanitizeUsername('user.name_1-2')).toBe('user.name_1-2');
  });

  it('drops spaces and punctuation', () => {
    expect(sanitizeUsername('a b@c!')).toBe('abc');
  });
});

describe('shouldAttribute', () => {
  it('stays silent in a solo session even when the flag is on', () => {
    // The whole point of the multi-user gate: a prefix on a one-person thread
    // names the only person who could have spoken.
    expect(shouldAttribute(true, 1)).toBe(false);
  });

  it('attributes once a session has more than one participant', () => {
    expect(shouldAttribute(true, 2)).toBe(true);
    expect(shouldAttribute(true, 5)).toBe(true);
  });

  it('never attributes when the flag is off, however many participants', () => {
    expect(shouldAttribute(false, 1)).toBe(false);
    expect(shouldAttribute(false, 2)).toBe(false);
    expect(shouldAttribute(false, 99)).toBe(false);
  });

  it('treats a degenerate participant count as solo', () => {
    // Defensive: an empty allowlist should never produce a prefix.
    expect(shouldAttribute(true, 0)).toBe(false);
  });
});
