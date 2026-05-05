import { readFile } from 'fs/promises';
import { createLogger } from '../../utils/logger.js';
import type { MattermostFile, MattermostPost } from './types.js';

const log = createLogger('mm-upload');

export interface MattermostUploadArgs {
  /** Mattermost server base URL, e.g. https://chat.example.com */
  url: string;
  /** Bot token for Authorization: Bearer ... */
  token: string;
  channelId: string;
  /** Root post id for threading. */
  threadId: string;
  /** Absolute path to read bytes from. */
  filePath: string;
  /** Filename to surface in chat. Caller is responsible for sanitization. */
  filename: string;
  /** Optional message body shown alongside the attachment. */
  caption?: string;
}

export interface MattermostUploadResult {
  /** Created post id (the post that references the uploaded file). */
  postId: string;
  /** File id Mattermost assigned to the upload. */
  fileId: string;
  /** Raw post payload, useful for normalizing into a PlatformPost. */
  post: MattermostPost;
}

interface UploadFilesResponse {
  file_infos: MattermostFile[];
  client_ids?: string[];
}

/**
 * Upload a single file to Mattermost and create a thread post that references
 * it. Two-step Mattermost protocol:
 *
 *   1. POST /api/v4/files (multipart/form-data) → file_infos[].id
 *   2. POST /api/v4/posts with {channel_id, message, root_id, file_ids}
 *
 * Errors from either step bubble up with the server's response body included
 * so callers can surface them to Claude verbatim.
 */
export async function uploadFileMattermost(
  args: MattermostUploadArgs,
): Promise<MattermostUploadResult> {
  const { url, token, channelId, threadId, filePath, filename, caption } = args;

  const buffer = await readFile(filePath);

  // Step 1: upload bytes.
  const uploadUrl = `${url}/api/v4/files?channel_id=${encodeURIComponent(channelId)}`;
  // Construct an ArrayBuffer that's exactly the file's bytes; Buffer.buffer
  // can be a larger pool, so slice with byteOffset/length as the FormData
  // pattern in bug-report/handler.ts already does.
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
  const formData = new FormData();
  formData.append('files', new Blob([arrayBuffer]), filename);

  log.debug(`POST /files (${buffer.length} bytes, ${filename})`);
  const uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      // Do NOT set Content-Type — fetch must set the multipart boundary.
    },
    body: formData,
  });

  if (!uploadResponse.ok) {
    const text = await uploadResponse.text();
    throw new Error(`Mattermost file upload failed: ${uploadResponse.status} ${text}`);
  }

  const uploadJson = (await uploadResponse.json()) as UploadFilesResponse;
  const fileInfo = uploadJson.file_infos?.[0];
  if (!fileInfo?.id) {
    throw new Error('Mattermost file upload response missing file_infos[0].id');
  }

  // Step 2: create the thread post that references the uploaded file.
  const postUrl = `${url}/api/v4/posts`;
  const postBody = {
    channel_id: channelId,
    message: caption ?? '',
    root_id: threadId,
    file_ids: [fileInfo.id],
  };
  log.debug(`POST /posts (file_ids=[${fileInfo.id}])`);
  const postResponse = await fetch(postUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(postBody),
  });

  if (!postResponse.ok) {
    const text = await postResponse.text();
    throw new Error(`Mattermost post-with-file failed: ${postResponse.status} ${text}`);
  }

  const post = (await postResponse.json()) as MattermostPost;
  return { postId: post.id, fileId: fileInfo.id, post };
}
