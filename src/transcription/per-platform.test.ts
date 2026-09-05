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

  it('falls back to enabled on a value it cannot read, and says so', () => {
    // Consistent with the other per-platform feature flags: a typo must not
    // silently disable a feature — it warns and keeps the documented default.
    expect(resolveTranscriptionEnabled('no')).toBe(true);
    expect(resolveTranscriptionEnabled(0)).toBe(true);
  });
});
