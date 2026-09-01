import { describe, test, expect } from 'bun:test';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ElevenLabsTranscriber } from './elevenlabs.js';

async function writeAudioFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-el-'));
  const path = join(dir, 'voice.webm');
  await writeFile(path, Buffer.from('not-really-audio'));
  return path;
}

/** A fetch stand-in that records the request and answers with a canned response. */
function fakeFetch(response: { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const text = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
    return new Response(text, { status: response.status, headers: { 'content-type': 'application/json' } });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

describe('ElevenLabsTranscriber', () => {
  test('sends the file and model as multipart with the key header and returns the text', async () => {
    const path = await writeAudioFixture();
    const { fn, calls } = fakeFetch({ status: 200, body: { language_code: 'eng', text: 'hello from the phone' } });
    const transcriber = new ElevenLabsTranscriber({ provider: 'elevenlabs', apiKey: 'xi-test-key' }, fn);

    const text = await transcriber.transcribe({ path, mimeType: 'audio/webm', name: 'voice.webm' });

    expect(text).toBe('hello from the phone');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>)['xi-api-key']).toBe('xi-test-key');
    const form = calls[0].init.body as FormData;
    expect(form.get('model_id')).toBe('scribe_v2');
    expect(form.get('language_code')).toBeNull();
    const part = form.get('file') as File;
    expect(part.name).toBe('voice.webm');
    expect(part.size).toBe('not-really-audio'.length);
  });

  test('passes model and language_code through when configured', async () => {
    const path = await writeAudioFixture();
    const { fn, calls } = fakeFetch({ status: 200, body: { text: 'dobar dan' } });
    const transcriber = new ElevenLabsTranscriber(
      { provider: 'elevenlabs', apiKey: 'k', model: 'scribe_v1', languageCode: 'hrv', apiUrl: 'https://example.test/v1' },
      fn,
    );

    await transcriber.transcribe({ path, mimeType: 'audio/mp4', name: 'note.m4a' });

    expect(calls[0].url).toBe('https://example.test/v1/speech-to-text');
    const form = calls[0].init.body as FormData;
    expect(form.get('model_id')).toBe('scribe_v1');
    expect(form.get('language_code')).toBe('hrv');
  });

  test('rejects with status and body excerpt on a non-2xx response', async () => {
    const path = await writeAudioFixture();
    const { fn } = fakeFetch({ status: 401, body: { detail: { status: 'invalid_api_key', message: 'Invalid API key' } } });
    const transcriber = new ElevenLabsTranscriber({ provider: 'elevenlabs', apiKey: 'bad' }, fn);

    const attempt = transcriber.transcribe({ path, mimeType: 'audio/webm', name: 'voice.webm' });

    await expect(attempt).rejects.toThrow('ElevenLabs HTTP 401: Invalid API key (invalid_api_key)');
  });

  test('falls back to a raw body excerpt when the error is not JSON', async () => {
    const path = await writeAudioFixture();
    const { fn } = fakeFetch({ status: 502, body: '<html>Bad Gateway</html>' });
    const transcriber = new ElevenLabsTranscriber({ provider: 'elevenlabs', apiKey: 'k' }, fn);

    const attempt = transcriber.transcribe({ path, mimeType: 'audio/webm', name: 'voice.webm' });

    await expect(attempt).rejects.toThrow('ElevenLabs HTTP 502: <html>Bad Gateway</html>');
  });

  test('rejects when the response carries no text', async () => {
    const path = await writeAudioFixture();
    const { fn } = fakeFetch({ status: 200, body: { language_code: 'eng', text: '   ' } });
    const transcriber = new ElevenLabsTranscriber({ provider: 'elevenlabs', apiKey: 'k' }, fn);

    const attempt = transcriber.transcribe({ path, mimeType: 'audio/webm', name: 'voice.webm' });

    await expect(attempt).rejects.toThrow(/empty transcript/);
  });

  test('reports itself as the elevenlabs provider', () => {
    const transcriber = new ElevenLabsTranscriber({ provider: 'elevenlabs', apiKey: 'k' }, fakeFetch({ status: 200, body: {} }).fn);

    expect(transcriber.provider).toBe('elevenlabs');
  });
});
