/**
 * Message streaming utilities
 *
 * Handles typing indicators and file attachments. File attachments are written
 * to a per-session directory under os.tmpdir(); Claude is given the absolute
 * path so it can Read or move/copy the file as needed.
 *
 * Content flushing is handled by MessageManager/ContentExecutor.
 */

import { lstat, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import type { PlatformClient, PlatformFile } from '../../platform/index.js';
import type { Session } from '../../session/types.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('streaming');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Sanity ceiling on a single uploaded file. Files above this are skipped to
 * avoid pathological disk usage; everything below is written to disk and the
 * path is handed to Claude.
 */
export const MAX_UPLOAD_SIZE = 100 * 1024 * 1024;

const UPLOAD_ROOT_DIR = 'claude-threads-uploads';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A file we successfully wrote to disk. */
export interface SavedFile {
  /** The original filename as the user uploaded it. */
  originalName: string;
  /** Absolute path on disk where the file was written. */
  absolutePath: string;
  /** Reported MIME type from the platform. */
  mimeType: string;
  /** Size in bytes. */
  size: number;
}

/** A file we couldn't process; surfaced to the user. */
export interface SkippedFile {
  name: string;
  reason: string;
  suggestion?: string;
}

/** Result of building message content for Claude. */
export interface BuiltMessageContent {
  /** Text payload to send to Claude (may include a header listing saved files). */
  content: string;
  /** Files that could not be saved — callers should surface these to the user. */
  skipped: SkippedFile[];
}

// ---------------------------------------------------------------------------
// Per-session upload directory
// ---------------------------------------------------------------------------

/** Reduce an id to a single path-safe segment so it can't escape uploadDir. */
function safeIdSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Returns the per-thread upload directory path. The directory is keyed by the
 * composite (platformId, threadId) so it survives session resume — a resumed
 * session writes new uploads to the same place its previous incarnation did.
 */
export function getSessionUploadDir(platformId: string, threadId: string): string {
  return join(tmpdir(), UPLOAD_ROOT_DIR, `${safeIdSegment(platformId)}-${safeIdSegment(threadId)}`);
}

/**
 * Best-effort removal of the per-thread upload directory and its contents.
 * Called from session cleanup; never throws. Tolerant of partial Session
 * objects (test fixtures, early-failure paths) where ids may be missing.
 */
export async function cleanupSessionUploads(platformId: string, threadId: string): Promise<void> {
  if (!platformId || !threadId) return;
  const dir = getSessionUploadDir(platformId, threadId);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    log.debug(`Upload cleanup for ${platformId}:${threadId} failed (ignored): ${err}`);
  }
}

// ---------------------------------------------------------------------------
// File saving
// ---------------------------------------------------------------------------

/**
 * Strip path components and unsafe characters from a user-supplied filename.
 * Prevents `../escape`, absolute-path attacks, and prompt-injection via
 * embedded newlines or control chars in the name we render back to Claude.
 * Falls back to `attachment` if the name reduces to nothing safe.
 */
function sanitizeFilename(name: string): string {
  // Strip directory separators on both POSIX and Windows shapes.
  const flat = basename(name.replace(/\\/g, '/'));
  // Strip control chars (newlines, tabs, NULs, escape sequences) — these
  // would otherwise be rendered into the prompt as if they were system text.
  // eslint-disable-next-line no-control-regex
  const cleaned = flat.replace(/[\x00-\x1F\x7F]/g, '_').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return 'attachment';
  }
  return cleaned;
}

/** Strip control chars from a value we'll interpolate into Claude's prompt. */
function sanitizeForPrompt(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1F\x7F]/g, '');
}

/** Format a byte count as a short human-readable string. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Download each file and write it to a fresh subdirectory under uploadDir.
 * Each call gets its own subdirectory so two messages uploading the same
 * filename don't collide.
 */
export async function saveFilesToUploadDir(
  platform: PlatformClient,
  uploadDir: string,
  files: PlatformFile[],
  debug: boolean = false,
): Promise<{ saved: SavedFile[]; skipped: SkippedFile[] }> {
  const saved: SavedFile[] = [];
  const skipped: SkippedFile[] = [];

  if (!platform.downloadFile) {
    for (const file of files) {
      skipped.push({ name: file.name, reason: 'Platform does not support file downloads' });
    }
    return { saved, skipped };
  }

  // Refuse to write into a symlinked upload dir — a local attacker on a
  // shared host could otherwise pre-create the (predictable) per-thread path
  // as a symlink to a sensitive directory and have the bot write attacker-
  // controlled bytes into it. mkdtemp + 'wx' close most of the race window;
  // the lstat check closes the rest.
  await mkdir(uploadDir, { recursive: true, mode: 0o700 });
  const stat = await lstat(uploadDir);
  if (stat.isSymbolicLink()) {
    for (const file of files) {
      skipped.push({ name: file.name, reason: 'Refusing to write under symlinked upload directory' });
    }
    log.error(`Upload dir is a symlink, refusing all writes: ${uploadDir}`);
    return { saved, skipped };
  }

  // mkdtemp gives us an atomically-created leaf with a random suffix —
  // collisions between concurrent messages are impossible.
  const messageDir = await mkdtemp(join(uploadDir, `${Date.now().toString(36)}-`));

  for (const file of files) {
    if (file.size > MAX_UPLOAD_SIZE) {
      skipped.push({
        name: file.name,
        reason: `File too large (${formatBytes(file.size)} > ${formatBytes(MAX_UPLOAD_SIZE)} limit)`,
        suggestion: 'Split the file or share it via an external link',
      });
      continue;
    }

    try {
      const buffer = await platform.downloadFile(file.id);
      const safeName = sanitizeFilename(file.name);
      const absolutePath = join(messageDir, safeName);
      // 'wx' = O_CREAT | O_EXCL: fail rather than follow a pre-existing
      // symlink at the target. Together with the per-message mkdtemp this
      // closes the symlink race even if uploadDir was racy before lstat.
      await writeFile(absolutePath, buffer, { mode: 0o600, flag: 'wx' });
      saved.push({
        originalName: file.name,
        absolutePath,
        mimeType: file.mimeType,
        size: buffer.length,
      });
      if (debug) {
        log.debug(`Saved ${file.name} → ${absolutePath} (${formatBytes(buffer.length)})`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Failed to save uploaded file ${file.name}: ${message}`);
      skipped.push({
        name: file.name,
        reason: `Download failed: ${message}`,
      });
    }
  }

  return { saved, skipped };
}

// ---------------------------------------------------------------------------
// Message content building
// ---------------------------------------------------------------------------

const FILE_LIST_HEADER = '[Attached files from chat — saved to disk, use Read or move/copy as needed:]';

/**
 * Build the content string for a user message, writing any attachments to
 * the per-session upload directory and prepending a list of their absolute
 * paths so Claude can find them.
 *
 * Returns the content plus any files that were skipped, so callers can
 * surface a warning via postSkippedFilesFeedback().
 */
export async function buildMessageContent(
  text: string,
  platform: PlatformClient,
  uploadDir: string,
  files?: PlatformFile[],
  debug: boolean = false,
): Promise<BuiltMessageContent> {
  if (!files || files.length === 0) {
    return { content: text, skipped: [] };
  }

  const { saved, skipped } = await saveFilesToUploadDir(platform, uploadDir, files, debug);

  if (saved.length === 0) {
    return { content: text, skipped };
  }

  const fileLines = saved.map(
    f => `- ${f.absolutePath} (${sanitizeForPrompt(f.mimeType) || 'application/octet-stream'}, ${formatBytes(f.size)})`,
  );
  const header = `${FILE_LIST_HEADER}\n${fileLines.join('\n')}`;
  const content = text.trim().length > 0 ? `${header}\n\n${text}` : header;

  return { content, skipped };
}

/**
 * Post a skipped-files warning to the thread, if any.
 * No-op when skipped is empty, so callers can invoke unconditionally.
 */
export async function postSkippedFilesFeedback(
  platform: PlatformClient,
  threadId: string,
  skipped: SkippedFile[],
): Promise<void> {
  if (skipped.length === 0) return;
  await platform.createPost(formatSkippedFilesFeedback(skipped), threadId);
}

/**
 * Format a user-facing feedback message for skipped files.
 */
export function formatSkippedFilesFeedback(skippedFiles: SkippedFile[]): string {
  const lines = ['⚠️ **Some files could not be processed:**'];
  for (const file of skippedFiles) {
    let line = `- **${file.name}**: ${file.reason}`;
    if (file.suggestion) {
      line += ` _(${file.suggestion})_`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Typing indicators
// ---------------------------------------------------------------------------

/**
 * Start sending typing indicators to the platform.
 * Sends immediately, then every 3 seconds until stopped.
 */
export function startTyping(session: Session): void {
  if (session.timers.typingTimer) return;
  session.platform.sendTyping(session.threadId);
  session.timers.typingTimer = setInterval(() => {
    session.platform.sendTyping(session.threadId);
  }, 3000);
}

/**
 * Stop sending typing indicators.
 */
export function stopTyping(session: Session): void {
  if (session.timers.typingTimer) {
    clearInterval(session.timers.typingTimer);
    session.timers.typingTimer = null;
  }
}
