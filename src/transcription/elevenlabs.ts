/**
 * ElevenLabs Scribe speech-to-text.
 *
 * One multipart POST, no SDK: `fetch` + `FormData` are native on Bun and
 * Node 20. Reference: https://elevenlabs.io/docs/api-reference/speech-to-text
 */

import { readFile } from 'fs/promises';
import type { TranscribeInput, Transcriber, TranscriptionConfig } from './types.js';

const DEFAULT_API_URL = 'https://api.elevenlabs.io/v1';
const DEFAULT_MODEL = 'scribe_v2';
/** A voice note is seconds long; a whole meeting is minutes. Generous either way. */
const REQUEST_TIMEOUT_MS = 120_000;
const ERROR_BODY_EXCERPT = 200;

/**
 * ElevenLabs errors look like `{"detail":{"status":"invalid_api_key","message":"…"}}`.
 * Surface the human message when it is there; otherwise an excerpt of the raw body.
 */
function describeErrorBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: { status?: unknown; message?: unknown } | string };
    if (typeof parsed.detail === 'string') return parsed.detail;
    const status = typeof parsed.detail?.status === 'string' ? parsed.detail.status : undefined;
    const message = typeof parsed.detail?.message === 'string' ? parsed.detail.message : undefined;
    if (status && message) return `${message} (${status})`;
    if (message || status) return (message ?? status) as string;
  } catch {
    // Not JSON — fall through to the raw excerpt. Nothing is swallowed: the
    // caller still receives an Error carrying the status and this excerpt.
  }
  return body.slice(0, ERROR_BODY_EXCERPT);
}

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
