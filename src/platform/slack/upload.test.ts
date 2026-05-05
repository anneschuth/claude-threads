import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { uploadFileSlack } from './upload.js';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyText?: string;
  bodyBytes?: number;
}

describe('uploadFileSlack', () => {
  const originalFetch = globalThis.fetch;
  let calls: RecordedCall[];
  let tmp: string;
  let filePath: string;
  const FILE_BYTES = Buffer.from([0x49, 0x44, 0x33, 0x04]); // ID3v2 ish, doesn't matter

  beforeEach(async () => {
    calls = [];
    tmp = await mkdtemp(join(tmpdir(), 'slack-upload-test-'));
    filePath = join(tmp, 'voice.mp3');
    await writeFile(filePath, FILE_BYTES);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(tmp, { recursive: true, force: true });
  });

  function mockFetch(handlers: Array<(url: string, init?: RequestInit) => Response>) {
    let idx = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
      const method = init?.method ?? 'GET';
      const headers: Record<string, string> = {};
      if (init?.headers) {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          headers[k] = v;
        }
      }
      let bodyText: string | undefined;
      let bodyBytes: number | undefined;
      if (init?.body && typeof init.body === 'string') {
        bodyText = init.body;
      } else if (init?.body instanceof ArrayBuffer) {
        bodyBytes = init.body.byteLength;
      } else if (init?.body && (init.body as ArrayBufferView).byteLength !== undefined) {
        bodyBytes = (init.body as ArrayBufferView).byteLength;
      }
      calls.push({ url, method, headers, bodyText, bodyBytes });
      if (idx >= handlers.length) throw new Error(`unexpected fetch #${idx + 1}: ${url}`);
      return handlers[idx++](url, init);
    }) as typeof fetch;
  }

  it('runs the v2 three-step flow with thread_ts and initial_comment', async () => {
    mockFetch([
      // 1. getUploadURLExternal
      () =>
        new Response(
          JSON.stringify({ ok: true, upload_url: 'https://files.slack.com/upload/X1', file_id: 'F1' }),
          { status: 200 },
        ),
      // 2. PUT to presigned URL
      () => new Response('OK', { status: 200 }),
      // 3. completeUploadExternal
      () =>
        new Response(
          JSON.stringify({ ok: true, files: [{ id: 'F1', title: 'voice memo' }], ts: '1700000000.000100' }),
          { status: 200 },
        ),
    ]);

    const result = await uploadFileSlack({
      botToken: 'xoxb-test',
      channelId: 'C123',
      threadTs: '1699999999.000000',
      filePath,
      filename: 'voice.mp3',
      caption: 'voice memo',
      apiUrl: 'https://mock.slack/api',
    });

    expect(result.fileId).toBe('F1');
    expect(result.postId).toBe('1700000000.000100');
    expect(calls).toHaveLength(3);

    // Step 1: GET getUploadURLExternal with filename + length, with bot token.
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('files.getUploadURLExternal');
    expect(calls[0].url).toContain('filename=voice.mp3');
    expect(calls[0].url).toContain(`length=${FILE_BYTES.length}`);
    expect(calls[0].headers.Authorization).toBe('Bearer xoxb-test');

    // Step 2: POST raw bytes to upload_url. CRITICAL: no Authorization header.
    expect(calls[1].method).toBe('POST');
    expect(calls[1].url).toBe('https://files.slack.com/upload/X1');
    expect(calls[1].headers.Authorization).toBeUndefined();
    expect(calls[1].headers['Content-Type']).toBe('application/octet-stream');
    expect(calls[1].bodyBytes).toBe(FILE_BYTES.length);

    // Step 3: complete with thread_ts, channel_id, initial_comment, files.
    expect(calls[2].method).toBe('POST');
    expect(calls[2].url).toBe('https://mock.slack/api/files.completeUploadExternal');
    expect(calls[2].headers.Authorization).toBe('Bearer xoxb-test');
    const parsed = JSON.parse(calls[2].bodyText!);
    expect(parsed.channel_id).toBe('C123');
    expect(parsed.thread_ts).toBe('1699999999.000000');
    expect(parsed.initial_comment).toBe('voice memo');
    expect(parsed.files).toEqual([{ id: 'F1', title: 'voice memo' }]);
  });

  it('falls back to fileId when complete returns no ts (and warns)', async () => {
    mockFetch([
      () =>
        new Response(JSON.stringify({ ok: true, upload_url: 'https://files.slack.com/u', file_id: 'F9' }), {
          status: 200,
        }),
      () => new Response('OK', { status: 200 }),
      () => new Response(JSON.stringify({ ok: true, files: [{ id: 'F9' }] }), { status: 200 }),
    ]);

    // Capture the warn so we know operators will see this in logs.
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    try {
      const result = await uploadFileSlack({
        botToken: 'xoxb',
        channelId: 'C',
        threadTs: 'T',
        filePath,
        filename: 'x.bin',
        apiUrl: 'https://mock/api',
      });
      expect(result.postId).toBe('F9');
      // The createLogger('slack-upload').warn() goes through console.warn under
      // bun:test. The exact prefix depends on the logger but the fileId must
      // appear in the warning text so the operator can correlate.
      const matched = warnings.some(w => w.includes('F9') && /no ts|fileId/i.test(w));
      expect(matched).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('does NOT warn when ts is present', async () => {
    mockFetch([
      () =>
        new Response(JSON.stringify({ ok: true, upload_url: 'https://x', file_id: 'F1' }), { status: 200 }),
      () => new Response('OK', { status: 200 }),
      () =>
        new Response(JSON.stringify({ ok: true, files: [{ id: 'F1' }], ts: '1700000000.0001' }), {
          status: 200,
        }),
    ]);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      await uploadFileSlack({
        botToken: 'x',
        channelId: 'C',
        threadTs: 'T',
        filePath,
        filename: 'a.png',
        apiUrl: 'https://mock/api',
      });
      const matched = warnings.some(w => /no ts|fileId/i.test(w));
      expect(matched).toBe(false);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('omits initial_comment when no caption given', async () => {
    mockFetch([
      () =>
        new Response(JSON.stringify({ ok: true, upload_url: 'https://x', file_id: 'F1' }), { status: 200 }),
      () => new Response('OK', { status: 200 }),
      () => new Response(JSON.stringify({ ok: true, files: [{ id: 'F1' }] }), { status: 200 }),
    ]);
    await uploadFileSlack({
      botToken: 'xoxb',
      channelId: 'C',
      threadTs: 'T',
      filePath,
      filename: 'a.png',
      apiUrl: 'https://mock/api',
    });
    const parsed = JSON.parse(calls[2].bodyText!);
    expect(parsed.initial_comment).toBeUndefined();
    expect(parsed.files[0].title).toBe('a.png');
  });

  it('throws on non-ok getUploadURLExternal response', async () => {
    mockFetch([() => new Response(JSON.stringify({ ok: false, error: 'not_authed' }), { status: 200 })]);
    await expect(
      uploadFileSlack({
        botToken: 'bad',
        channelId: 'C',
        threadTs: 'T',
        filePath,
        filename: 'a.png',
        apiUrl: 'https://mock/api',
      }),
    ).rejects.toThrow(/not_authed/);
  });

  it('throws on failed bytes upload', async () => {
    mockFetch([
      () =>
        new Response(JSON.stringify({ ok: true, upload_url: 'https://x', file_id: 'F1' }), { status: 200 }),
      () => new Response('something broke', { status: 500 }),
    ]);
    await expect(
      uploadFileSlack({
        botToken: 'x',
        channelId: 'C',
        threadTs: 'T',
        filePath,
        filename: 'a.png',
        apiUrl: 'https://mock/api',
      }),
    ).rejects.toThrow(/500.*something broke/);
  });

  it('throws on completeUploadExternal error', async () => {
    mockFetch([
      () =>
        new Response(JSON.stringify({ ok: true, upload_url: 'https://x', file_id: 'F1' }), { status: 200 }),
      () => new Response('OK', { status: 200 }),
      () => new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200 }),
    ]);
    await expect(
      uploadFileSlack({
        botToken: 'x',
        channelId: 'C',
        threadTs: 'T',
        filePath,
        filename: 'a.png',
        apiUrl: 'https://mock/api',
      }),
    ).rejects.toThrow(/channel_not_found/);
  });
});
