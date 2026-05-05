import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { uploadFileMattermost } from './upload.js';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  bodyText?: string;
  contentType?: string;
}

describe('uploadFileMattermost', () => {
  const originalFetch = globalThis.fetch;
  let calls: RecordedCall[];
  let tmp: string;
  let filePath: string;

  beforeEach(async () => {
    calls = [];
    tmp = await mkdtemp(join(tmpdir(), 'mm-upload-test-'));
    filePath = join(tmp, 'screenshot.png');
    await writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(tmp, { recursive: true, force: true });
  });

  function mockFetch(responses: Array<() => Response>) {
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
      const contentType = headers['Content-Type'] || headers['content-type'];
      if (init?.body && typeof init.body === 'string') {
        bodyText = init.body;
      }
      calls.push({ url, method, headers, body: init?.body, bodyText, contentType });
      if (idx >= responses.length) throw new Error(`unexpected fetch #${idx + 1}`);
      return responses[idx++]();
    }) as typeof fetch;
  }

  it('uploads bytes to /files then creates a post referencing file_ids', async () => {
    mockFetch([
      () =>
        new Response(JSON.stringify({ file_infos: [{ id: 'FILE123', name: 'screenshot.png', size: 6 }] }), {
          status: 201,
        }),
      () =>
        new Response(
          JSON.stringify({
            id: 'POST456',
            create_at: 1,
            update_at: 1,
            delete_at: 0,
            user_id: 'BOT',
            channel_id: 'CH',
            root_id: 'ROOT',
            message: 'here is the screenshot',
            type: '',
            props: {},
            file_ids: ['FILE123'],
          }),
          { status: 201 },
        ),
    ]);

    const result = await uploadFileMattermost({
      url: 'https://mm.example.com',
      token: 'BOT_TOKEN',
      channelId: 'CH',
      threadId: 'ROOT',
      filePath,
      filename: 'screenshot.png',
      caption: 'here is the screenshot',
    });

    expect(result.fileId).toBe('FILE123');
    expect(result.postId).toBe('POST456');

    expect(calls).toHaveLength(2);

    // Step 1: multipart upload.
    expect(calls[0].url).toBe('https://mm.example.com/api/v4/files?channel_id=CH');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.Authorization).toBe('Bearer BOT_TOKEN');
    // Crucial: do NOT set Content-Type manually — fetch must set the boundary.
    expect(calls[0].headers['Content-Type']).toBeUndefined();
    expect(calls[0].body).toBeInstanceOf(FormData);

    // Step 2: post creation references the file id.
    expect(calls[1].url).toBe('https://mm.example.com/api/v4/posts');
    expect(calls[1].method).toBe('POST');
    expect(calls[1].headers['Content-Type']).toBe('application/json');
    const parsed = JSON.parse(calls[1].bodyText!);
    expect(parsed).toEqual({
      channel_id: 'CH',
      message: 'here is the screenshot',
      root_id: 'ROOT',
      file_ids: ['FILE123'],
    });
  });

  it('omits caption gracefully (empty message) when none given', async () => {
    mockFetch([
      () => new Response(JSON.stringify({ file_infos: [{ id: 'F1' }] }), { status: 201 }),
      () =>
        new Response(
          JSON.stringify({
            id: 'P1',
            create_at: 1,
            update_at: 1,
            delete_at: 0,
            user_id: 'BOT',
            channel_id: 'CH',
            root_id: 'ROOT',
            message: '',
            type: '',
            props: {},
          }),
          { status: 201 },
        ),
    ]);

    await uploadFileMattermost({
      url: 'https://mm.example.com',
      token: 'TOKEN',
      channelId: 'CH',
      threadId: 'ROOT',
      filePath,
      filename: 'a.png',
    });
    const parsed = JSON.parse(calls[1].bodyText!);
    expect(parsed.message).toBe('');
  });

  it('throws with server response when /files fails', async () => {
    mockFetch([() => new Response('file too large', { status: 413 })]);
    await expect(
      uploadFileMattermost({
        url: 'https://mm.example.com',
        token: 'TOKEN',
        channelId: 'CH',
        threadId: 'ROOT',
        filePath,
        filename: 'a.png',
      }),
    ).rejects.toThrow(/413.*file too large/);
  });

  it('throws when /files response is missing file_infos', async () => {
    mockFetch([() => new Response(JSON.stringify({ file_infos: [] }), { status: 201 })]);
    await expect(
      uploadFileMattermost({
        url: 'https://mm.example.com',
        token: 'TOKEN',
        channelId: 'CH',
        threadId: 'ROOT',
        filePath,
        filename: 'a.png',
      }),
    ).rejects.toThrow(/file_infos/);
  });

  it('throws with server response when /posts fails', async () => {
    mockFetch([
      () => new Response(JSON.stringify({ file_infos: [{ id: 'F1' }] }), { status: 201 }),
      () => new Response('forbidden', { status: 403 }),
    ]);
    await expect(
      uploadFileMattermost({
        url: 'https://mm.example.com',
        token: 'TOKEN',
        channelId: 'CH',
        threadId: 'ROOT',
        filePath,
        filename: 'a.png',
      }),
    ).rejects.toThrow(/403.*forbidden/);
  });
});
