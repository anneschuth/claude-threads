/**
 * ElevenLabs Scribe speech-to-text.
 *
 * One multipart POST, no SDK: `fetch` + `FormData` are native on Bun and
 * Node 20. Reference: https://elevenlabs.io/docs/api-reference/speech-to-text
 */

import { readFile } from 'fs/promises';
import type { TranscribeInput, Transcriber, TranscriptionConfig } from './types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('transcribe');

const DEFAULT_API_URL = 'https://api.elevenlabs.io/v1';
const DEFAULT_MODEL = 'scribe_v2';
/** A voice note is seconds long; a whole meeting is minutes. Generous either way. */
const REQUEST_TIMEOUT_MS = 120_000;
/**
 * ElevenLabs errors look like `{"detail":{"status":"invalid_api_key","message":"…"}}`.
 * Surface the human message when it is there.
 *
 * ⚠️ Never the raw body. This string is posted into a chat channel, and a
 * vendor error body is not ours to publish: it can carry the request we sent,
 * echoed headers, internal identifiers — the same shape of leak as a token
 * reaching an `execFile` error. An unrecognised body becomes a fixed phrase
 * and nothing else; the HTTP status the caller prepends is the actionable
 * part anyway, and the body is still available to whoever reads the logs.
 */
function describeErrorBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: { status?: unknown } | string };
    const status = typeof parsed.detail === 'object' && typeof parsed.detail?.status === 'string'
      ? parsed.detail.status
      : undefined;
    // The `status` CODE only, never the free-text `message` beside it. The
    // code is an identifier from a fixed vocabulary (`invalid_api_key`,
    // `audio_too_long`) and is the actionable half; the message is prose the
    // vendor composes and can carry the request, a key fragment or an
    // internal id. Rebuilt, not echoed.
    if (status && SAFE_STATUS.test(status)) return status.replace(/_/g, ' ');
  } catch {
    // Not JSON. Nothing is swallowed — the caller still receives an Error
    // carrying the HTTP status; only the body is withheld from the channel.
  }
  return 'the provider returned an error we could not classify';
}

/**
 * A status we are willing to repeat: short, and shaped like an identifier
 * rather than prose. A vendor that starts putting sentences in this field
 * does not get to publish them into a channel by surprise.
 */
const SAFE_STATUS = /^[a-z][a-z0-9_]{0,48}$/;

export class ElevenLabsTranscriber implements Transcriber {
  readonly provider = 'elevenlabs';
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly model: string;
  private readonly languageCode?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: TranscriptionConfig, fetchImpl: typeof fetch = fetch) {
    this.apiKey = config.apiKey;
    this.apiUrl = (config.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
    this.model = config.model ?? DEFAULT_MODEL;
    this.languageCode = config.languageCode;
    this.fetchImpl = fetchImpl;
  }

  async transcribe(input: TranscribeInput): Promise<string> {
    const bytes = await readFile(input.path);
    const form = new FormData();
    form.append('file', new File([bytes], input.name, { type: input.mimeType }));
    form.append('model_id', this.model);
    if (this.languageCode) {
      form.append('language_code', this.languageCode);
    }

    const response = await this.fetchImpl(`${this.apiUrl}/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      // A body that cannot even be read is itself part of the diagnosis.
      const body = await response.text().catch((err: unknown) => `<body unreadable: ${String(err)}>`);
      // The full body goes to the log and NOT to the channel: the operator who
      // has to debug this needs all of it, and the people in the channel need
      // none of it. Without this line the withheld body would be lost, not
      // merely withheld.
      log.debug(`ElevenLabs HTTP ${response.status} body: ${body}`);
      throw new Error(`ElevenLabs HTTP ${response.status}: ${describeErrorBody(body)}`);
    }

    const data = (await response.json()) as { text?: unknown };
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (!text) {
      throw new Error('ElevenLabs returned an empty transcript');
    }
    return text;
  }
}
