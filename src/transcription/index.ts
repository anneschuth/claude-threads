/**
 * Transcription entry point: one factory from config to a Transcriber.
 * Config errors throw here so a bad `transcription:` block fails the boot,
 * not the first voice note.
 */

import { ElevenLabsTranscriber } from './elevenlabs.js';
import type { Transcriber, TranscriptionConfig } from './types.js';

export type { Transcriber, TranscribeInput, Transcript, TranscriptionConfig } from './types.js';
export { isTranscribable } from './types.js';

export function createTranscriber(config: TranscriptionConfig): Transcriber {
  if (config.provider !== 'elevenlabs') {
    throw new Error(`transcription.provider must be "elevenlabs", got "${String(config.provider)}"`);
  }
  // Whitespace counts as missing: a key that is `" "` fails the boot here
  // rather than at the first voice note, which is the whole point of
  // validating in a factory.
  if (typeof config.apiKey !== 'string' || config.apiKey.trim() === '') {
    throw new Error('transcription.apiKey is required');
  }
  return new ElevenLabsTranscriber(config);
}
