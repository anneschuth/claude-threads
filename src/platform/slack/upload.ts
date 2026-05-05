import { readFile } from 'fs/promises';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('slack-upload');

const DEFAULT_API_URL = 'https://slack.com/api';

export interface SlackUploadArgs {
  /** Bot token (xoxb-...) */
  botToken: string;
  channelId: string;
  /** Thread parent ts. Required so file lands in the right thread. */
  threadTs: string;
  filePath: string;
  /** Filename to surface in chat. Caller is responsible for sanitization. */
  filename: string;
  /** Optional comment posted alongside the file. */
  caption?: string;
  /** Override base API URL (test/mock injection). Defaults to https://slack.com/api. */
  apiUrl?: string;
}

export interface SlackUploadResult {
  fileId: string;
  /** Slack message ts; may be empty if completeUploadExternal didn't return one. */
  postId: string;
}

interface GetUploadUrlResponse {
  ok: boolean;
  upload_url?: string;
  file_id?: string;
  error?: string;
}

interface CompleteUploadResponse {
  ok: boolean;
  files?: Array<{ id: string; title?: string; permalink?: string }>;
  error?: string;
  // Slack does not always return a message ts here; varies by version.
  ts?: string;
}

/**
 * Upload a file to Slack and post it into a thread.
 *
 * Three-step v2 flow (the legacy `files.upload` endpoint is deprecated):
 *
 *   1. files.getUploadURLExternal?filename=...&length=... → { upload_url, file_id }
 *   2. POST <upload_url> with raw bytes (no bot token — it's presigned)
 *   3. files.completeUploadExternal with { files, channel_id, thread_ts, initial_comment }
 *
 * Returns the file id and (if Slack provides one) the message ts. File posts
 * are not currently re-edited or reacted to, so falling back to the file id
 * as the post id is acceptable for v1.
 */
export async function uploadFileSlack(args: SlackUploadArgs): Promise<SlackUploadResult> {
  const { botToken, channelId, threadTs, filePath, filename, caption } = args;
  const apiUrl = args.apiUrl ?? DEFAULT_API_URL;

  const buffer = await readFile(filePath);

  // Step 1: get a presigned upload URL.
  const params = new URLSearchParams({ filename, length: String(buffer.length) });
  const step1Url = `${apiUrl}/files.getUploadURLExternal?${params.toString()}`;
  log.debug(`GET files.getUploadURLExternal (${buffer.length} bytes, ${filename})`);
  const step1Response = await fetch(step1Url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${botToken}`,
    },
  });
  if (!step1Response.ok) {
    const text = await step1Response.text();
    throw new Error(`Slack getUploadURLExternal failed: ${step1Response.status} ${text}`);
  }
  const step1Data = (await step1Response.json()) as GetUploadUrlResponse;
  if (!step1Data.ok || !step1Data.upload_url || !step1Data.file_id) {
    throw new Error(`Slack getUploadURLExternal error: ${step1Data.error || 'missing upload_url/file_id'}`);
  }
  const uploadUrl = step1Data.upload_url;
  const fileId = step1Data.file_id;

  // Step 2: PUT the raw bytes to the presigned URL. NO bot token here —
  // Slack rejects requests with auth headers on the presigned endpoint.
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
  log.debug(`POST <upload_url>`);
  const step2Response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
    },
    body: arrayBuffer,
  });
  if (!step2Response.ok) {
    const text = await step2Response.text();
    throw new Error(`Slack file bytes upload failed: ${step2Response.status} ${text}`);
  }

  // Step 3: complete and attach to channel/thread.
  const step3Body: Record<string, unknown> = {
    files: [{ id: fileId, title: caption ?? filename }],
    channel_id: channelId,
    thread_ts: threadTs,
  };
  if (caption !== undefined) {
    step3Body.initial_comment = caption;
  }
  log.debug(`POST files.completeUploadExternal (file_id=${fileId}, thread_ts=${threadTs})`);
  const step3Response = await fetch(`${apiUrl}/files.completeUploadExternal`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(step3Body),
  });
  if (!step3Response.ok) {
    const text = await step3Response.text();
    throw new Error(`Slack completeUploadExternal failed: ${step3Response.status} ${text}`);
  }
  const step3Data = (await step3Response.json()) as CompleteUploadResponse;
  if (!step3Data.ok) {
    throw new Error(`Slack completeUploadExternal error: ${step3Data.error || 'unknown'}`);
  }

  return { fileId, postId: step3Data.ts ?? fileId };
}
