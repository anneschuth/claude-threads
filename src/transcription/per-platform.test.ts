/**
 * The per-platform `transcription: false` opt-out.
 *
 * The provider and its key are a property of the DEPLOYMENT — one vendor
 * account per daemon — so they live at the top level. Whether a given
 * channel's audio should be sent to that vendor at all is a property of the
 * CHANNEL. These pin the second half.
 */

import { describe, it, expect } from 'bun:test';
import { resolveTranscriptionEnabled } from '../config/types.js';

describe('resolveTranscriptionEnabled', () => {
  it('defaults to enabled, so a configured provider applies everywhere', () => {
    // Opt-out, not opt-in: an operator who configured a provider meant it for
    // their channels, and making every channel re-declare it would mean voice
    // notes silently arriving as unreadable files in most of them.
    expect(resolveTranscriptionEnabled(undefined)).toBe(true);
    expect(resolveTranscriptionEnabled(null)).toBe(true);
  });

  it('opts one platform out with false', () => {
    expect(resolveTranscriptionEnabled(false)).toBe(false);
  });

  it('fails CLOSED on a value it cannot read', () => {
    // Deliberately unlike the other per-platform flags, which fall back to
    // enabled. Those govern whether the bot does something for you; this one
    // governs whether a channel's audio is uploaded to a third party.
    // `transcription: "false"` — a quoted boolean, the likeliest way to get
    // this wrong in YAML — must not be read as consent.
    expect(resolveTranscriptionEnabled('false')).toBe(false);
    expect(resolveTranscriptionEnabled('no')).toBe(false);
    expect(resolveTranscriptionEnabled(0)).toBe(false);
  });
});

describe('createTranscriber validation', () => {
  it('treats a whitespace-only key as missing', async () => {
    // It would otherwise pass the boot check and fail on the first voice
    // note, which is exactly what validating in a factory is meant to avoid.
    const { createTranscriber } = await import('./index.js');

    expect(() => createTranscriber({ provider: 'elevenlabs', apiKey: '   ' })).toThrow(
      'transcription.apiKey is required',
    );
  });
});
