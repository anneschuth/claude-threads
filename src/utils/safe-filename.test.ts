import { describe, test, expect } from 'bun:test';
import { dedupeFilename, sanitizeFilename, formatBytes } from './safe-filename.js';

describe('dedupeFilename', () => {
  test('returns the name unchanged the first time it is seen', () => {
    const used = new Set<string>();
    expect(dedupeFilename('image.png', used)).toBe('image.png');
    expect(used.has('image.png')).toBe(true);
  });

  test('appends a numeric suffix before the extension on collision', () => {
    const used = new Set<string>();
    expect(dedupeFilename('image.png', used)).toBe('image.png');
    expect(dedupeFilename('image.png', used)).toBe('image_1.png');
    expect(dedupeFilename('image.png', used)).toBe('image_2.png');
  });

  test('appends the suffix directly when there is no extension', () => {
    const used = new Set<string>();
    expect(dedupeFilename('report', used)).toBe('report');
    expect(dedupeFilename('report', used)).toBe('report_1');
    expect(dedupeFilename('report', used)).toBe('report_2');
  });

  test('treats a dotfile as having no extension', () => {
    const used = new Set<string>();
    expect(dedupeFilename('.env', used)).toBe('.env');
    expect(dedupeFilename('.env', used)).toBe('.env_1');
  });

  test('handles multi-dot names by splitting on the last dot', () => {
    const used = new Set<string>();
    expect(dedupeFilename('archive.tar.gz', used)).toBe('archive.tar.gz');
    expect(dedupeFilename('archive.tar.gz', used)).toBe('archive.tar_1.gz');
  });

  test('skips over a suffix that is already taken', () => {
    const used = new Set<string>(['image.png', 'image_1.png']);
    expect(dedupeFilename('image.png', used)).toBe('image_2.png');
  });

  test('keeps distinct names independent', () => {
    const used = new Set<string>();
    expect(dedupeFilename('a.png', used)).toBe('a.png');
    expect(dedupeFilename('b.png', used)).toBe('b.png');
    expect(dedupeFilename('a.png', used)).toBe('a_1.png');
  });
});

describe('sanitizeFilename', () => {
  test('strips path components', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
  });

  test('falls back to attachment for empty names', () => {
    expect(sanitizeFilename('')).toBe('attachment');
  });
});

describe('formatBytes', () => {
  test('formats across units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
  });
});
