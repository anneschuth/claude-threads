import { describe, test, expect } from 'bun:test';
import { createTranscriber } from './index.js';
import { isTranscribable } from './types.js';

describe('createTranscriber', () => {
  test('builds an ElevenLabs transcriber from a valid config', () => {
    const transcriber = createTranscriber({ provider: 'elevenlabs', apiKey: 'k' });

    expect(transcriber.provider).toBe('elevenlabs');
  });

  test('rejects an unknown provider at boot', () => {
    const config = { provider: 'whisper', apiKey: 'k' } as unknown as Parameters<typeof createTranscriber>[0];

    expect(() => createTranscriber(config)).toThrow(/transcription\.provider.*whisper/);
  });

  test('rejects a missing api key at boot', () => {
    const config = { provider: 'elevenlabs', apiKey: '' } as Parameters<typeof createTranscriber>[0];

    expect(() => createTranscriber(config)).toThrow(/transcription\.apiKey/);
  });
});

describe('isTranscribable', () => {
  test('accepts any audio MIME type regardless of case', () => {
    expect(isTranscribable('audio/webm')).toBe(true);
    expect(isTranscribable('Audio/MP4')).toBe(true);
    expect(isTranscribable('audio/x-m4a')).toBe(true);
  });

  test('ignores images, video and documents', () => {
    expect(isTranscribable('image/png')).toBe(false);
    expect(isTranscribable('video/webm')).toBe(false);
    expect(isTranscribable('application/pdf')).toBe(false);
  });

  test('accepts an audio extension when the platform reported only a generic MIME type', () => {
    expect(isTranscribable('application/octet-stream', 'note.m4a')).toBe(true);
    expect(isTranscribable('', 'clip.OGG')).toBe(true);
    expect(isTranscribable('application/octet-stream', 'voice.webm')).toBe(true);
  });

  test('a generic MIME type without an audio extension is not transcribed', () => {
    expect(isTranscribable('application/octet-stream', 'archive.zip')).toBe(false);
    expect(isTranscribable('application/octet-stream', 'noext')).toBe(false);
    expect(isTranscribable('application/pdf', 'talk.mp3')).toBe(false);
  });
});
