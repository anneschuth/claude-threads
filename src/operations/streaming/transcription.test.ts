/**
 * buildMessageContent + postTranscriptFeedback with a Transcriber attached.
 * See docs/audio-transcription-spec.md.
 */

import { describe, test, expect, mock } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildMessageContent, postTranscriptFeedback } from './handler.js';
import type { PlatformClient, PlatformFile } from '../../platform/index.js';
import type { Transcriber, TranscribeInput } from '../../transcription/index.js';
import { createMockFormatter } from '../../test-utils/mock-formatter.js';

function createMockPlatform() {
  return {
    downloadFile: mock(async () => Buffer.from('audio-bytes')),
    getFormatter: mock(() => createMockFormatter()),
    createPost: mock(async () => ({ id: 'post-1' })),
  } as unknown as PlatformClient & { createPost: ReturnType<typeof mock> };
}

function voiceNote(overrides: Partial<PlatformFile> = {}): PlatformFile {
  return { id: 'F1', name: 'voice.webm', size: 11, mimeType: 'audio/webm', ...overrides };
}

function fakeTranscriber(result: string | Error): Transcriber & { inputs: TranscribeInput[] } {
  const inputs: TranscribeInput[] = [];
  return {
    provider: 'elevenlabs',
    inputs,
    async transcribe(input) {
      inputs.push(input);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

async function withUploadDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-transcribe-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('buildMessageContent with a transcriber', () => {
  test('an audio attachment yields a transcript block after the file list and before the text', async () => {
    await withUploadDir(async (dir) => {
      const platform = createMockPlatform();
      const transcriber = fakeTranscriber('please rerun the backfill');

      const built = await buildMessageContent('typed text', platform, dir, [voiceNote()], false, transcriber);

      expect(built.content).toMatch(/^\[Attached files from chat[^\n]*\n- .*voice\.webm \(audio\/webm, 11 B\)\n\n\[Transcript of voice\.webm \(elevenlabs\):\]\nplease rerun the backfill\n\ntyped text$/);
      expect(built.transcripts).toEqual([{ name: 'voice.webm', provider: 'elevenlabs', text: 'please rerun the backfill' }]);
      expect(built.skipped).toEqual([]);
    });
  });

  test('the transcriber receives the saved file path, MIME type and original name', async () => {
    await withUploadDir(async (dir) => {
      const platform = createMockPlatform();
      const transcriber = fakeTranscriber('ok');

      await buildMessageContent('', platform, dir, [voiceNote({ name: 'note.m4a', mimeType: 'audio/mp4' })], false, transcriber);

      expect(transcriber.inputs).toHaveLength(1);
      expect(transcriber.inputs[0].name).toBe('note.m4a');
      expect(transcriber.inputs[0].mimeType).toBe('audio/mp4');
      expect(transcriber.inputs[0].path.startsWith(dir)).toBe(true);
      expect(transcriber.inputs[0].path.endsWith('note.m4a')).toBe(true);
    });
  });

  test('a voice note with no typed text still produces a message', async () => {
    await withUploadDir(async (dir) => {
      const platform = createMockPlatform();

      const built = await buildMessageContent('', platform, dir, [voiceNote()], false, fakeTranscriber('just the voice'));

      expect(built.content).toMatch(/\[Transcript of voice\.webm \(elevenlabs\):\]\njust the voice$/);
    });
  });

  test('non-audio attachments are not sent to the transcriber', async () => {
    await withUploadDir(async (dir) => {
      const platform = createMockPlatform();
      const transcriber = fakeTranscriber('should not be called');

      const built = await buildMessageContent('look', platform, dir, [voiceNote({ name: 'shot.png', mimeType: 'image/png' })], false, transcriber);

      expect(transcriber.inputs).toHaveLength(0);
      expect(built.transcripts).toEqual([]);
      expect(built.content).not.toContain('[Transcript');
    });
  });

  test('without a transcriber an audio attachment is listed as a plain file', async () => {
    await withUploadDir(async (dir) => {
      const platform = createMockPlatform();

      const built = await buildMessageContent('hi', platform, dir, [voiceNote()], false);

      expect(built.content).toContain('voice.webm (audio/webm, 11 B)');
      expect(built.content).not.toContain('[Transcript');
      expect(built.transcripts).toEqual([]);
    });
  });

  test('a transcription failure is reported as a skipped-file warning and the file stays in the prompt', async () => {
    await withUploadDir(async (dir) => {
      const platform = createMockPlatform();
      const transcriber = fakeTranscriber(new Error('ElevenLabs HTTP 401: Invalid API key'));

      const built = await buildMessageContent('hi', platform, dir, [voiceNote()], false, transcriber);

      expect(built.content).toContain('voice.webm (audio/webm, 11 B)');
      expect(built.content).not.toContain('[Transcript');
      expect(built.transcripts).toEqual([]);
      expect(built.skipped).toEqual([
        {
          name: 'voice.webm',
          reason: 'Transcription failed: ElevenLabs HTTP 401: Invalid API key',
          suggestion: 'The audio file itself was still handed to Claude',
        },
      ]);
    });
  });

  test('control characters in a transcript are stripped before it reaches the prompt', async () => {
    await withUploadDir(async (dir) => {
      const platform = createMockPlatform();

      const built = await buildMessageContent('', platform, dir, [voiceNote()], false, fakeTranscriber('line one\nline two\x07'));

      expect(built.content).toContain('line one\nline two');
      expect(built.content).not.toContain('\x07');
    });
  });
});

describe('postTranscriptFeedback', () => {
  test('posts one quoted message per transcript, every line quoted', async () => {
    const platform = createMockPlatform();

    await postTranscriptFeedback(platform, 'thread-1', [
      { name: 'voice.webm', provider: 'elevenlabs', text: 'first line\n\nsecond paragraph' },
      { name: 'two.m4a', provider: 'elevenlabs', text: 'other note' },
    ]);

    expect(platform.createPost).toHaveBeenCalledTimes(2);
    expect(platform.createPost.mock.calls[0]).toEqual([
      '🎙️ **Transcript of voice.webm:**\n> first line\n> \n> second paragraph',
      'thread-1',
    ]);
    expect(platform.createPost.mock.calls[1]).toEqual(['🎙️ **Transcript of two.m4a:**\n> other note', 'thread-1']);
  });

  test('posts nothing when there are no transcripts', async () => {
    const platform = createMockPlatform();

    await postTranscriptFeedback(platform, 'thread-1', []);
    await postTranscriptFeedback(platform, 'thread-1', undefined);

    expect(platform.createPost).not.toHaveBeenCalled();
  });
});
