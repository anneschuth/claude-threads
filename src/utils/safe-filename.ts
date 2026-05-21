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

/**
 * Resolve a filename that is unique within a single batch of writes.
 *
 * When `name` has already been used (tracked in `used`), append a numeric
 * suffix before the extension until a free name is found: `image.png` becomes
 * `image_1.png`, then `image_2.png`. Names without an extension get the suffix
 * appended directly: `report` becomes `report_1`. A dotfile like `.env` is
 * treated as having no extension, so it becomes `.env_1`.
 *
 * The returned name is added to `used` so the caller can keep calling this in a
 * loop. Used to keep multiple identically-named clipboard pastes (which most
 * platforms name `image.png`) from colliding on disk.
 */
export function dedupeFilename(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }

  // Split off the extension, but treat a leading dot as part of the stem so a
  // dotfile (`.env`) keeps its leading dot rather than being read as ext-only.
  const lastDot = name.lastIndexOf('.');
  const hasExt = lastDot > 0;
  const stem = hasExt ? name.slice(0, lastDot) : name;
  const ext = hasExt ? name.slice(lastDot) : '';

  let counter = 1;
  let candidate = `${stem}_${counter}${ext}`;
  while (used.has(candidate)) {
    counter += 1;
    candidate = `${stem}_${counter}${ext}`;
  }
  used.add(candidate);
  return candidate;
}

/** Format a byte count as a short human-readable string. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
