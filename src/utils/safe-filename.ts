import { basename } from 'path';

/**
 * Strip path components and unsafe characters from a user-supplied filename.
 * Prevents `../escape`, absolute-path attacks, and prompt-injection via
 * embedded newlines or control chars in names we render back to Claude or
 * pass on to upload APIs.
 *
 * Falls back to `attachment` if the name reduces to nothing safe.
 */
export function sanitizeFilename(name: string): string {
  const flat = basename(name.replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  const cleaned = flat.replace(/[\x00-\x1F\x7F]/g, '_').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return 'attachment';
  }
  return cleaned;
}

/** Format a byte count as a short human-readable string. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
