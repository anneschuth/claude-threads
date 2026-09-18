import { describe, test, expect } from 'bun:test';
import { resolvePresentationMode, resolvePresentationOverhead } from './types.js';

describe('resolvePresentationMode', () => {
  test('defaults to full, so an existing config is untouched', () => {
    expect(resolvePresentationMode(undefined, 'platforms[x].mode')).toBe('full');
    expect(resolvePresentationMode(null, 'platforms[x].mode')).toBe('full');
  });

  test('accepts the named presets', () => {
    expect(resolvePresentationMode('full', 'platforms[x].mode')).toBe('full');
    expect(resolvePresentationMode('assistant', 'platforms[x].mode')).toBe('assistant');
  });

  test('rejects anything else with the field path', () => {
    expect(() => resolvePresentationMode('quiet', 'platforms[slack-a].mode')).toThrow('platforms[slack-a].mode');
    expect(() => resolvePresentationMode(true, 'platforms[slack-a].mode')).toThrow('platforms[slack-a].mode');
  });
});

describe('resolvePresentationOverhead', () => {
  test('no mode and no fields is exactly the pre-preset behaviour', () => {
    // The compatibility guarantee: adding presets must not move anyone's
    // channel. Every field an existing config omits still resolves to `full`.
    expect(resolvePresentationOverhead({}, 'platforms[x]')).toEqual({
      sessionHeader: 'full',
      stickyMessage: 'full',
      lifecycle: 'full',
    });
  });

  test('mode: assistant hides the three human-facing posts', () => {
    // The shape #505 and #590 describe: the reply is the whole thread.
    expect(resolvePresentationOverhead({ mode: 'assistant' }, 'platforms[x]')).toEqual({
      sessionHeader: 'hidden',
      stickyMessage: 'hidden',
      lifecycle: 'hidden',
    });
  });

  test('an explicit field beats the preset it sits in', () => {
    // "Replies only, but I still want the header" has to be expressible, or
    // the preset becomes a trap the moment someone wants one thing back.
    expect(
      resolvePresentationOverhead({ mode: 'assistant', sessionHeader: 'full' }, 'platforms[x]'),
    ).toEqual({
      sessionHeader: 'full',
      stickyMessage: 'hidden',
      lifecycle: 'hidden',
    });
  });

  test('an explicit field beats the default preset too', () => {
    expect(resolvePresentationOverhead({ lifecycle: 'minimal' }, 'platforms[x]')).toEqual({
      sessionHeader: 'full',
      stickyMessage: 'full',
      lifecycle: 'minimal',
    });
  });

  test('mode: full is spelled out identically to omitting it', () => {
    expect(resolvePresentationOverhead({ mode: 'full' }, 'platforms[x]')).toEqual(
      resolvePresentationOverhead({}, 'platforms[x]'),
    );
  });

  test('an invalid field reports its own path, not the mode', () => {
    expect(() =>
      resolvePresentationOverhead({ mode: 'assistant', lifecycle: 'quiet' }, 'platforms[slack-a]'),
    ).toThrow('platforms[slack-a].lifecycle');
  });

  test('an invalid mode reports the mode path', () => {
    expect(() => resolvePresentationOverhead({ mode: 'silent' }, 'platforms[slack-a]')).toThrow(
      'platforms[slack-a].mode',
    );
  });
});
