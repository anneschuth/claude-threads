import { describe, it, expect } from 'bun:test';
import { formatUserTurn, sanitizeUsername } from './formatter.js';

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
