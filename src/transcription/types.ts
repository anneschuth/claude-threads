/**
 * Transcription: turn an inbound audio attachment into text before the
 * message reaches Claude. See docs/audio-transcription-spec.md.
 *
 * The provider is a property of the deployment (one vendor key per daemon),
 * so the config lives at the top level and applies to every platform.
 */

/** What a provider receives: a file already saved to the upload dir. */
export interface TranscribeInput {
  /** Absolute path on disk. */
  path: string;
  /** MIME type as reported by the chat platform (e.g. `audio/webm`). */
  mimeType: string;
  /** Original filename, used for the multipart part and in messages. */
  name: string;
}

export interface Transcriber {
  /** Short provider name, shown in the prompt block (e.g. `elevenlabs`). */
  readonly provider: string;
  /** Resolve to the transcript text; reject with a descriptive Error. */
  transcribe(input: TranscribeInput): Promise<string>;
}

/** Top-level `transcription:` block in config.yaml. */
export interface TranscriptionConfig {
  /** Only `elevenlabs` exists today; the field is the seam for others. */
  provider: 'elevenlabs';
  apiKey: string;
  /** Provider model id. ElevenLabs default: `scribe_v2`. */
  model?: string;
  /** ISO-639-3 language code (e.g. `eng`, `hrv`). Omitted = auto-detect. */
  languageCode?: string;
  /** API base URL override (tests). */
  apiUrl?: string;
}

/** A transcript produced for one attachment. */
export interface Transcript {
  /** Original filename of the audio attachment. */
  name: string;
  /** Provider that produced it. */
  provider: string;
  text: string;
}

/** Extensions that are audio even when a platform reports a generic MIME type. */
const AUDIO_EXTENSIONS = new Set(['m4a', 'mp3', 'ogg', 'opus', 'wav', 'aac', 'flac']);
const GENERIC_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/**
 * True for attachments the transcriber should see: any `audio/*` MIME type,
 * or an audio extension when the platform only reported a generic type.
 * `video/*` is deliberately excluded (upstream question, see #519).
 */
export function isTranscribable(mimeType: string, name?: string): boolean {
  const mime = (mimeType ?? '').toLowerCase();
  if (mime.startsWith('audio/')) return true;
  if (!GENERIC_MIME_TYPES.has(mime)) return false;
  const extension = (name ?? '').split('.').pop()?.toLowerCase() ?? '';
  return AUDIO_EXTENSIONS.has(extension);
}
