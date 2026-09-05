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

  test('repeats the status CODE and not the prose beside it', async () => {
    // The code is an identifier from a fixed vocabulary and is the actionable
    // half. The `message` is prose the vendor composes — it can carry the
    // request we sent, a key fragment, or an internal id — so it never
    // reaches the channel, only the log.
    const path = await writeAudioFixture();
    const { fn } = fakeFetch({
      status: 401,
      body: { detail: { status: 'invalid_api_key', message: 'Invalid API key sk-live-abc123 for org 42' } },
    });
    const transcriber = new ElevenLabsTranscriber({ provider: 'elevenlabs', apiKey: 'bad' }, fn);

    const attempt = transcriber.transcribe({ path, mimeType: 'audio/webm', name: 'voice.webm' });

    await expect(attempt).rejects.toThrow('ElevenLabs HTTP 401: invalid api key');
    await expect(attempt).rejects.not.toThrow(/sk-live-abc123|org 42/);
  });

  test('will not repeat a status that stopped looking like an identifier', async () => {
    // A vendor that starts putting sentences in this field does not get to
    // publish them into a channel by surprise.
    const path = await writeAudioFixture();
    const { fn } = fakeFetch({
      status: 400,
      body: { detail: { status: 'Your request to https://internal.vendor/x failed, token=abc' } },
    });
    const transcriber = new ElevenLabsTranscriber({ provider: 'elevenlabs', apiKey: 'k' }, fn);

    const attempt = transcriber.transcribe({ path, mimeType: 'audio/webm', name: 'voice.webm' });

    await expect(attempt).rejects.toThrow('could not classify');
    await expect(attempt).rejects.not.toThrow(/internal\.vendor|token=abc/);
  });

  test('withholds an unrecognised error body instead of publishing it', async () => {
    // This message is posted into a chat channel. A vendor error body is not
    // ours to publish — it can carry the request we sent, echoed headers, or
    // internal identifiers. The status is the actionable part; the body goes
    // to the log.
    const path = await writeAudioFixture();
    const { fn } = fakeFetch({
      status: 502,
      body: '<html>Bad Gateway</html> request_id=abc123 x-api-key=leaked',
    });
    const transcriber = new ElevenLabsTranscriber({ provider: 'elevenlabs', apiKey: 'k' }, fn);

    const attempt = transcriber.transcribe({ path, mimeType: 'audio/webm', name: 'voice.webm' });

    await expect(attempt).rejects.toThrow('ElevenLabs HTTP 502');
    await expect(attempt).rejects.not.toThrow(/leaked|request_id|Bad Gateway/);
  });

  test('a hostile detail cannot flood a channel', async () => {
    const path = await writeAudioFixture();
    const { fn } = fakeFetch({
      status: 400,
      body: { detail: { status: 'bad_request', message: 'x'.repeat(5000) } },
    });
    const transcriber = new ElevenLabsTranscriber({ provider: 'elevenlabs', apiKey: 'k' }, fn);

    const attempt = transcriber
      .transcribe({ path, mimeType: 'audio/webm', name: 'voice.webm' })
      .catch((err: Error) => err.message);

    expect((await attempt).length).toBeLessThan(100);
  });

  test('rejects when the response carries no text', async () => {
    const path = await writeAudioFixture();
    const { fn } = fakeFetch({ status: 200, body: { language_code: 'eng', text: '   ' } });
    const transcriber = new ElevenLabsTranscriber({ provider: 'elevenlabs', apiKey: 'k' }, fn);

    const attempt = transcriber.transcribe({ path, mimeType: 'audio/webm', name: 'voice.webm' });

    await expect(attempt).rejects.toThrow(/empty transcript/);
  });

  test('still reports the status when the error body itself cannot be read', async () => {
    const path = await writeAudioFixture();
    const unreadable = (async () => ({
      ok: false,
      status: 500,
      text: async () => { throw new Error('socket hang up'); },
    })) as unknown as typeof fetch;
    const transcriber = new ElevenLabsTranscriber({ provider: 'elevenlabs', apiKey: 'k' }, unreadable);

    const attempt = transcriber.transcribe({ path, mimeType: 'audio/webm', name: 'voice.webm' });

    // The status still reaches the channel; the unreadable-body detail does
    // not, for the same reason a readable one does not.
    await expect(attempt).rejects.toThrow('ElevenLabs HTTP 500');
    await expect(attempt).rejects.not.toThrow(/socket hang up/);
  });

  test('reports itself as the elevenlabs provider', () => {
    const transcriber = new ElevenLabsTranscriber({ provider: 'elevenlabs', apiKey: 'k' }, fakeFetch({ status: 200, body: {} }).fn);

    expect(transcriber.provider).toBe('elevenlabs');
  });
});
