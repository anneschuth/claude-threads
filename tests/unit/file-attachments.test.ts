/**
 * Unit tests for file attachment handling
 *
 * Tests file type detection, content processing, size limits,
 * gzip decompression, and skipped file feedback.
 */

import { describe, it, expect, mock } from 'bun:test';
import { gzipSync } from 'zlib';
import yazl from 'yazl';
import {
  // Constants
  MAX_PDF_SIZE,
  MAX_TEXT_FILE_SIZE,
  MAX_DECOMPRESSED_SIZE,
  MAX_ZIP_SIZE,
  MAX_ZIP_FILES,
  SUPPORTED_IMAGE_TYPES,
  SUPPORTED_TEXT_TYPES,
  TEXT_FILE_EXTENSIONS,

  // File type detection
  isImageFile,
  isPdfFile,
  isTextFile,
  isGzipFile,
  isZipFile,
  categorizeFile,

  // File processing
  processImageFile,
  processPdfFile,
  processTextFile,
  processGzipFile,
  processZipFile,
  formatTextFileContent,
  detectDecompressedContentType,
  getUnsupportedFileSuggestion,

  // Main functions
  buildMessageContent,
  processFiles,
} from '../../src/operations/streaming/handler.js';
import type { PlatformFile, PlatformClient } from '../../src/platform/index.js';

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockFile(overrides: Partial<PlatformFile> = {}): PlatformFile {
  return {
    id: 'file-123',
    name: 'test-file.txt',
    size: 1024,
    mimeType: 'text/plain',
    extension: 'txt',
    ...overrides,
  };
}

function createMockPlatform(downloadResult?: Buffer): PlatformClient {
  return {
    downloadFile: downloadResult !== undefined
      ? mock(() => Promise.resolve(downloadResult))
      : mock(() => Promise.resolve(Buffer.from('test content'))),
    // Required PlatformClient methods (unused in these tests)
    connect: mock(() => Promise.resolve()),
    disconnect: mock(() => Promise.resolve()),
    createPost: mock(() => Promise.resolve({ id: 'post-123' })),
    updatePost: mock(() => Promise.resolve()),
    deletePost: mock(() => Promise.resolve()),
    addReaction: mock(() => Promise.resolve()),
    removeReaction: mock(() => Promise.resolve()),
    getPost: mock(() => Promise.resolve(null)),
    getUser: mock(() => Promise.resolve(null)),
    getMe: mock(() => Promise.resolve({ id: 'bot-123', username: 'bot' })),
    sendTyping: mock(() => {}),
    onMessage: mock(() => {}),
    onReaction: mock(() => {}),
    getId: mock(() => 'test-platform'),
    getDisplayName: mock(() => 'Test Platform'),
    getType: mock(() => 'mattermost' as const),
    getFormatter: mock(() => ({ format: (s: string) => s })),
  } as unknown as PlatformClient;
}

/**
 * Helper to create a zip buffer with specified files.
 * @param files - Array of {name, content} objects
 */
async function createZipBuffer(files: Array<{ name: string; content: string | Buffer }>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zipfile = new yazl.ZipFile();

    for (const file of files) {
      const content = typeof file.content === 'string' ? Buffer.from(file.content) : file.content;
      zipfile.addBuffer(content, file.name);
    }

    zipfile.end();

    const chunks: Buffer[] = [];
    zipfile.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zipfile.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zipfile.outputStream.on('error', reject);
  });
}

// =============================================================================
// Constants Tests
// =============================================================================

describe('Constants', () => {
  it('has correct MAX_PDF_SIZE (32MB)', () => {
    expect(MAX_PDF_SIZE).toBe(32 * 1024 * 1024);
  });

  it('has correct MAX_TEXT_FILE_SIZE (1MB)', () => {
    expect(MAX_TEXT_FILE_SIZE).toBe(1 * 1024 * 1024);
  });

  it('has correct MAX_DECOMPRESSED_SIZE (10MB)', () => {
    expect(MAX_DECOMPRESSED_SIZE).toBe(10 * 1024 * 1024);
  });

  it('has correct MAX_ZIP_SIZE (50MB)', () => {
    expect(MAX_ZIP_SIZE).toBe(50 * 1024 * 1024);
  });

  it('has correct MAX_ZIP_FILES (20)', () => {
    expect(MAX_ZIP_FILES).toBe(20);
  });

  it('includes common image types', () => {
    expect(SUPPORTED_IMAGE_TYPES).toContain('image/jpeg');
    expect(SUPPORTED_IMAGE_TYPES).toContain('image/png');
    expect(SUPPORTED_IMAGE_TYPES).toContain('image/gif');
    expect(SUPPORTED_IMAGE_TYPES).toContain('image/webp');
  });

  it('includes common text MIME types', () => {
    expect(SUPPORTED_TEXT_TYPES).toContain('text/plain');
    expect(SUPPORTED_TEXT_TYPES).toContain('text/markdown');
    expect(SUPPORTED_TEXT_TYPES).toContain('application/json');
  });

  it('includes common text file extensions', () => {
    expect(TEXT_FILE_EXTENSIONS).toContain('.txt');
    expect(TEXT_FILE_EXTENSIONS).toContain('.md');
    expect(TEXT_FILE_EXTENSIONS).toContain('.json');
    expect(TEXT_FILE_EXTENSIONS).toContain('.py');
    expect(TEXT_FILE_EXTENSIONS).toContain('.ts');
  });
});

// =============================================================================
// File Type Detection Tests
// =============================================================================

describe('isImageFile', () => {
  it('returns true for supported image MIME types', () => {
    expect(isImageFile(createMockFile({ mimeType: 'image/jpeg', name: 'photo.jpg' }))).toBe(true);
    expect(isImageFile(createMockFile({ mimeType: 'image/png', name: 'image.png' }))).toBe(true);
    expect(isImageFile(createMockFile({ mimeType: 'image/gif', name: 'anim.gif' }))).toBe(true);
    expect(isImageFile(createMockFile({ mimeType: 'image/webp', name: 'photo.webp' }))).toBe(true);
  });

  it('returns false for unsupported image types', () => {
    expect(isImageFile(createMockFile({ mimeType: 'image/bmp', name: 'image.bmp' }))).toBe(false);
    expect(isImageFile(createMockFile({ mimeType: 'image/tiff', name: 'image.tiff' }))).toBe(false);
    expect(isImageFile(createMockFile({ mimeType: 'image/svg+xml', name: 'image.svg' }))).toBe(false);
  });

  it('returns false for non-image types', () => {
    expect(isImageFile(createMockFile({ mimeType: 'text/plain', name: 'file.txt' }))).toBe(false);
    expect(isImageFile(createMockFile({ mimeType: 'application/pdf', name: 'doc.pdf' }))).toBe(false);
  });
});

describe('isPdfFile', () => {
  it('returns true for PDF MIME type', () => {
    expect(isPdfFile(createMockFile({ mimeType: 'application/pdf', name: 'document.pdf' }))).toBe(true);
  });

  it('returns true for .pdf extension even with wrong MIME type', () => {
    expect(isPdfFile(createMockFile({ mimeType: 'application/octet-stream', name: 'document.pdf' }))).toBe(true);
    expect(isPdfFile(createMockFile({ mimeType: 'application/octet-stream', name: 'DOCUMENT.PDF' }))).toBe(true);
  });

  it('returns false for non-PDF files', () => {
    expect(isPdfFile(createMockFile({ mimeType: 'text/plain', name: 'file.txt' }))).toBe(false);
    expect(isPdfFile(createMockFile({ mimeType: 'image/jpeg', name: 'photo.jpg' }))).toBe(false);
  });
});

describe('isTextFile', () => {
  it('returns true for text MIME types', () => {
    expect(isTextFile(createMockFile({ mimeType: 'text/plain', name: 'file.txt' }))).toBe(true);
    expect(isTextFile(createMockFile({ mimeType: 'text/markdown', name: 'doc.md' }))).toBe(true);
    expect(isTextFile(createMockFile({ mimeType: 'application/json', name: 'data.json' }))).toBe(true);
    expect(isTextFile(createMockFile({ mimeType: 'text/csv', name: 'data.csv' }))).toBe(true);
  });

  it('returns true for text file extensions even with generic MIME type', () => {
    expect(isTextFile(createMockFile({ mimeType: 'application/octet-stream', name: 'script.py' }))).toBe(true);
    expect(isTextFile(createMockFile({ mimeType: 'application/octet-stream', name: 'code.ts' }))).toBe(true);
    expect(isTextFile(createMockFile({ mimeType: 'application/octet-stream', name: 'config.yaml' }))).toBe(true);
    expect(isTextFile(createMockFile({ mimeType: 'application/octet-stream', name: 'README.md' }))).toBe(true);
  });

  it('returns true for source code files', () => {
    expect(isTextFile(createMockFile({ mimeType: 'application/octet-stream', name: 'main.go' }))).toBe(true);
    expect(isTextFile(createMockFile({ mimeType: 'application/octet-stream', name: 'app.rs' }))).toBe(true);
    expect(isTextFile(createMockFile({ mimeType: 'application/octet-stream', name: 'Main.java' }))).toBe(true);
  });

  it('returns false for non-text files', () => {
    expect(isTextFile(createMockFile({ mimeType: 'application/pdf', name: 'doc.pdf' }))).toBe(false);
    expect(isTextFile(createMockFile({ mimeType: 'image/png', name: 'image.png' }))).toBe(false);
    expect(isTextFile(createMockFile({ mimeType: 'application/octet-stream', name: 'binary.exe' }))).toBe(false);
  });
});

describe('isGzipFile', () => {
  it('returns true for gzip MIME types', () => {
    expect(isGzipFile(createMockFile({ mimeType: 'application/gzip', name: 'file.gz' }))).toBe(true);
    expect(isGzipFile(createMockFile({ mimeType: 'application/x-gzip', name: 'file.gz' }))).toBe(true);
  });

  it('returns true for .gz extension even with wrong MIME type', () => {
    expect(isGzipFile(createMockFile({ mimeType: 'application/octet-stream', name: 'data.json.gz' }))).toBe(true);
    expect(isGzipFile(createMockFile({ mimeType: 'application/octet-stream', name: 'FILE.GZ' }))).toBe(true);
  });

  it('returns false for non-gzip files', () => {
    expect(isGzipFile(createMockFile({ mimeType: 'text/plain', name: 'file.txt' }))).toBe(false);
    expect(isGzipFile(createMockFile({ mimeType: 'application/zip', name: 'archive.zip' }))).toBe(false);
  });
});

describe('isZipFile', () => {
  it('returns true for zip MIME types', () => {
    expect(isZipFile(createMockFile({ mimeType: 'application/zip', name: 'archive.zip' }))).toBe(true);
    expect(isZipFile(createMockFile({ mimeType: 'application/x-zip-compressed', name: 'archive.zip' }))).toBe(true);
  });

  it('returns true for .zip extension even with wrong MIME type', () => {
    expect(isZipFile(createMockFile({ mimeType: 'application/octet-stream', name: 'data.zip' }))).toBe(true);
    expect(isZipFile(createMockFile({ mimeType: 'application/octet-stream', name: 'FILE.ZIP' }))).toBe(true);
  });

  it('returns false for non-zip files', () => {
    expect(isZipFile(createMockFile({ mimeType: 'text/plain', name: 'file.txt' }))).toBe(false);
    expect(isZipFile(createMockFile({ mimeType: 'application/gzip', name: 'archive.gz' }))).toBe(false);
  });
});

describe('categorizeFile', () => {
  it('categorizes images correctly', () => {
    expect(categorizeFile(createMockFile({ mimeType: 'image/jpeg', name: 'photo.jpg' }))).toBe('image');
    expect(categorizeFile(createMockFile({ mimeType: 'image/png', name: 'image.png' }))).toBe('image');
  });

  it('categorizes PDFs correctly', () => {
    expect(categorizeFile(createMockFile({ mimeType: 'application/pdf', name: 'doc.pdf' }))).toBe('pdf');
  });

  it('categorizes gzip files correctly (takes priority over text)', () => {
    // Even if the inner file is text, gzip categorization should take priority
    expect(categorizeFile(createMockFile({ mimeType: 'application/gzip', name: 'data.json.gz' }))).toBe('gzip');
  });

  it('categorizes text files correctly', () => {
    expect(categorizeFile(createMockFile({ mimeType: 'text/plain', name: 'file.txt' }))).toBe('text');
    expect(categorizeFile(createMockFile({ mimeType: 'application/json', name: 'data.json' }))).toBe('text');
  });

  it('categorizes zip files correctly', () => {
    expect(categorizeFile(createMockFile({ mimeType: 'application/zip', name: 'archive.zip' }))).toBe('zip');
    expect(categorizeFile(createMockFile({ mimeType: 'application/x-zip-compressed', name: 'data.zip' }))).toBe('zip');
  });

  it('categorizes unsupported files correctly', () => {
    expect(categorizeFile(createMockFile({ mimeType: 'application/msword', name: 'doc.doc' }))).toBe('unsupported');
    expect(categorizeFile(createMockFile({ mimeType: 'application/x-rar-compressed', name: 'archive.rar' }))).toBe('unsupported');
  });
});

// =============================================================================
// File Processing Tests
// =============================================================================

describe('processImageFile', () => {
  it('processes image file successfully', async () => {
    const imageBuffer = Buffer.from('fake image data');
    const platform = createMockPlatform(imageBuffer);
    const file = createMockFile({ mimeType: 'image/jpeg', name: 'photo.jpg' });

    const result = await processImageFile(file, platform);

    expect(result.block).toBeDefined();
    expect(result.skipped).toBeUndefined();
    expect(result.block?.type).toBe('image');
    if (result.block?.type === 'image') {
      expect(result.block.source.type).toBe('base64');
      expect(result.block.source.media_type).toBe('image/jpeg');
      expect(result.block.source.data).toBe(imageBuffer.toString('base64'));
    }
  });

  it('returns skipped when platform does not support downloads', async () => {
    const platform = { ...createMockPlatform(), downloadFile: undefined } as unknown as PlatformClient;
    const file = createMockFile({ mimeType: 'image/jpeg', name: 'photo.jpg' });

    const result = await processImageFile(file, platform);

    expect(result.block).toBeUndefined();
    expect(result.skipped).toBeDefined();
    expect(result.skipped?.reason).toContain('does not support file downloads');
  });

  it('returns skipped when download fails', async () => {
    const platform = createMockPlatform();
    (platform.downloadFile as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.reject(new Error('Network error'))
    );
    const file = createMockFile({ mimeType: 'image/jpeg', name: 'photo.jpg' });

    const result = await processImageFile(file, platform);

    expect(result.block).toBeUndefined();
    expect(result.skipped).toBeDefined();
    expect(result.skipped?.reason).toContain('Download failed');
  });
});

describe('processPdfFile', () => {
  it('processes PDF file successfully', async () => {
    const pdfBuffer = Buffer.from('%PDF-1.4 fake pdf content');
    const platform = createMockPlatform(pdfBuffer);
    const file = createMockFile({ mimeType: 'application/pdf', name: 'document.pdf' });

    const result = await processPdfFile(file, platform);

    expect(result.block).toBeDefined();
    expect(result.skipped).toBeUndefined();
    expect(result.block?.type).toBe('document');
    if (result.block?.type === 'document') {
      expect(result.block.source.type).toBe('base64');
      expect(result.block.source.media_type).toBe('application/pdf');
      expect(result.block.title).toBe('document.pdf');
    }
  });

  it('returns skipped for PDF exceeding size limit', async () => {
    const largePdfBuffer = Buffer.alloc(MAX_PDF_SIZE + 1, 'x');
    const platform = createMockPlatform(largePdfBuffer);
    const file = createMockFile({ mimeType: 'application/pdf', name: 'large.pdf' });

    const result = await processPdfFile(file, platform);

    expect(result.block).toBeUndefined();
    expect(result.skipped).toBeDefined();
    expect(result.skipped?.reason).toContain('exceeds');
    expect(result.skipped?.reason).toContain('32MB');
    expect(result.skipped?.suggestion).toContain('splitting');
  });
});

describe('processTextFile', () => {
  it('processes text file successfully', async () => {
    const textContent = 'Hello, world!\nThis is a test file.';
    const textBuffer = Buffer.from(textContent);
    const platform = createMockPlatform(textBuffer);
    const file = createMockFile({ mimeType: 'text/plain', name: 'readme.txt' });

    const result = await processTextFile(file, platform);

    expect(result.block).toBeDefined();
    expect(result.skipped).toBeUndefined();
    expect(result.block?.type).toBe('text');
    if (result.block?.type === 'text') {
      expect(result.block.text).toContain('readme.txt');
      expect(result.block.text).toContain(textContent);
    }
  });

  it('returns skipped for text file exceeding size limit', async () => {
    const largeTextBuffer = Buffer.alloc(MAX_TEXT_FILE_SIZE + 1, 'x');
    const platform = createMockPlatform(largeTextBuffer);
    const file = createMockFile({ mimeType: 'text/plain', name: 'large.txt' });

    const result = await processTextFile(file, platform);

    expect(result.block).toBeUndefined();
    expect(result.skipped).toBeDefined();
    expect(result.skipped?.reason).toContain('exceeds');
    expect(result.skipped?.suggestion).toContain('splitting');
  });
});

describe('formatTextFileContent', () => {
  it('wraps content with filename header and code block', () => {
    const result = formatTextFileContent('config.json', '{"key": "value"}');

    expect(result).toContain('config.json');
    expect(result).toContain('```');
    expect(result).toContain('{"key": "value"}');
  });

  it('includes emoji in header', () => {
    const result = formatTextFileContent('script.py', 'print("hello")');

    expect(result).toContain('📄');
  });
});

// =============================================================================
// Gzip Processing Tests
// =============================================================================

describe('processGzipFile', () => {
  it('decompresses and processes JSON content', async () => {
    const jsonContent = '{"data": "test value", "count": 42}';
    const compressedBuffer = gzipSync(Buffer.from(jsonContent));
    const platform = createMockPlatform(compressedBuffer);
    const file = createMockFile({ mimeType: 'application/gzip', name: 'data.json.gz' });

    const result = await processGzipFile(file, platform);

    expect(result.block).toBeDefined();
    expect(result.skipped).toBeUndefined();
    expect(result.block?.type).toBe('text');
    if (result.block?.type === 'text') {
      expect(result.block.text).toContain('data.json');
      expect(result.block.text).toContain(jsonContent);
    }
  });

  it('decompresses and processes PDF content', async () => {
    const pdfContent = '%PDF-1.4 fake pdf content here';
    const compressedBuffer = gzipSync(Buffer.from(pdfContent));
    const platform = createMockPlatform(compressedBuffer);
    const file = createMockFile({ mimeType: 'application/gzip', name: 'document.pdf.gz' });

    const result = await processGzipFile(file, platform);

    expect(result.block).toBeDefined();
    expect(result.skipped).toBeUndefined();
    expect(result.block?.type).toBe('document');
    if (result.block?.type === 'document') {
      expect(result.block.title).toBe('document.pdf');
    }
  });

  it('returns skipped for invalid gzip data', async () => {
    const invalidGzip = Buffer.from('this is not gzip data');
    const platform = createMockPlatform(invalidGzip);
    const file = createMockFile({ mimeType: 'application/gzip', name: 'invalid.gz' });

    const result = await processGzipFile(file, platform);

    expect(result.block).toBeUndefined();
    expect(result.skipped).toBeDefined();
    expect(result.skipped?.reason).toContain('Decompression failed');
  });

  it('returns skipped for decompressed content exceeding size limit', async () => {
    // Create a large content that compresses well
    const largeContent = 'x'.repeat(MAX_DECOMPRESSED_SIZE + 1);
    const compressedBuffer = gzipSync(Buffer.from(largeContent));
    const platform = createMockPlatform(compressedBuffer);
    const file = createMockFile({ mimeType: 'application/gzip', name: 'large.txt.gz' });

    const result = await processGzipFile(file, platform);

    expect(result.block).toBeUndefined();
    expect(result.skipped).toBeDefined();
    expect(result.skipped?.reason).toContain('Decompressed size exceeds');
  });

  it('returns skipped for unsupported decompressed content type', async () => {
    // Binary content that's not text or PDF
    const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xFF, 0xFE, 0xFD]);
    const compressedBuffer = gzipSync(binaryContent);
    const platform = createMockPlatform(compressedBuffer);
    const file = createMockFile({ mimeType: 'application/gzip', name: 'binary.dat.gz' });

    const result = await processGzipFile(file, platform);

    expect(result.block).toBeUndefined();
    expect(result.skipped).toBeDefined();
    expect(result.skipped?.reason).toContain('not supported');
  });
});

// =============================================================================
// Zip Processing Tests
// =============================================================================

describe('processZipFile', () => {
  it('processes zip with single JSON file', async () => {
    const jsonContent = '{"data": "test value", "count": 42}';
    const zipBuffer = await createZipBuffer([{ name: 'data.json', content: jsonContent }]);
    const platform = createMockPlatform(zipBuffer);
    const file = createMockFile({ mimeType: 'application/zip', name: 'archive.zip' });

    const result = await processZipFile(file, platform);

    expect(result.blocks.length).toBe(1);
    expect(result.skipped.length).toBe(0);
    expect(result.blocks[0]?.type).toBe('text');
    if (result.blocks[0]?.type === 'text') {
      expect(result.blocks[0].text).toContain('data.json');
      expect(result.blocks[0].text).toContain(jsonContent);
    }
  });

  it('processes zip with multiple text files', async () => {
    const zipBuffer = await createZipBuffer([
      { name: 'file1.txt', content: 'Content of file 1' },
      { name: 'file2.md', content: '# Markdown content' },
      { name: 'config.json', content: '{"key": "value"}' },
    ]);
    const platform = createMockPlatform(zipBuffer);
    const file = createMockFile({ mimeType: 'application/zip', name: 'archive.zip' });

    const result = await processZipFile(file, platform);

    expect(result.blocks.length).toBe(3);
    expect(result.skipped.length).toBe(0);
  });

  it('processes zip with PDF file', async () => {
    const pdfContent = '%PDF-1.4 fake pdf content here';
    const zipBuffer = await createZipBuffer([{ name: 'document.pdf', content: pdfContent }]);
    const platform = createMockPlatform(zipBuffer);
    const file = createMockFile({ mimeType: 'application/zip', name: 'archive.zip' });

    const result = await processZipFile(file, platform);

    expect(result.blocks.length).toBe(1);
    expect(result.skipped.length).toBe(0);
    expect(result.blocks[0]?.type).toBe('document');
  });

  it('skips unsupported files inside zip', async () => {
    const zipBuffer = await createZipBuffer([
      { name: 'data.json', content: '{"valid": true}' },
      { name: 'binary.exe', content: Buffer.from([0x00, 0x01, 0x02, 0x03, 0xFF, 0xFE]) },
    ]);
    const platform = createMockPlatform(zipBuffer);
    const file = createMockFile({ mimeType: 'application/zip', name: 'archive.zip' });

    const result = await processZipFile(file, platform);

    expect(result.blocks.length).toBe(1);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]?.name).toBe('binary.exe');
    expect(result.skipped[0]?.reason).toContain('Unsupported file type');
  });

  it('returns error for empty zip', async () => {
    const zipBuffer = await createZipBuffer([]);
    const platform = createMockPlatform(zipBuffer);
    const file = createMockFile({ mimeType: 'application/zip', name: 'empty.zip' });

    const result = await processZipFile(file, platform);

    expect(result.blocks.length).toBe(0);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]?.reason).toContain('empty');
  });

  it('returns error for invalid zip data', async () => {
    const invalidZip = Buffer.from('this is not a valid zip file');
    const platform = createMockPlatform(invalidZip);
    const file = createMockFile({ mimeType: 'application/zip', name: 'invalid.zip' });

    const result = await processZipFile(file, platform);

    expect(result.blocks.length).toBe(0);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]?.reason).toContain('Failed to process zip');
  });

  it('returns error for zip exceeding size limit', async () => {
    // Don't actually create a huge file, just mock the file size
    const platform = createMockPlatform(Buffer.from(''));
    const file = createMockFile({
      mimeType: 'application/zip',
      name: 'huge.zip',
      size: MAX_ZIP_SIZE + 1,
    });

    const result = await processZipFile(file, platform);

    expect(result.blocks.length).toBe(0);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]?.reason).toContain('exceeds');
  });

  it('skips directories inside zip', async () => {
    // yazl doesn't add empty directories by default, but let's verify files in subdirs work
    const zipBuffer = await createZipBuffer([
      { name: 'subdir/file.txt', content: 'File in subdirectory' },
    ]);
    const platform = createMockPlatform(zipBuffer);
    const file = createMockFile({ mimeType: 'application/zip', name: 'archive.zip' });

    const result = await processZipFile(file, platform);

    expect(result.blocks.length).toBe(1);
    expect(result.skipped.length).toBe(0);
    if (result.blocks[0]?.type === 'text') {
      expect(result.blocks[0].text).toContain('subdir/file.txt');
    }
  });
});

describe('detectDecompressedContentType', () => {
  it('detects PDF by magic bytes', () => {
    const pdfBuffer = Buffer.from('%PDF-1.4 content');
    expect(detectDecompressedContentType(pdfBuffer, 'unknown')).toBe('pdf');
  });

  it('detects PDF by filename extension', () => {
    const buffer = Buffer.from('some content');
    expect(detectDecompressedContentType(buffer, 'document.pdf')).toBe('pdf');
  });

  it('detects text by filename extension', () => {
    const buffer = Buffer.from('some content');
    expect(detectDecompressedContentType(buffer, 'config.json')).toBe('text');
    expect(detectDecompressedContentType(buffer, 'script.py')).toBe('text');
    expect(detectDecompressedContentType(buffer, 'readme.md')).toBe('text');
  });

  it('detects JSON by content', () => {
    const jsonBuffer = Buffer.from('{"key": "value"}');
    expect(detectDecompressedContentType(jsonBuffer, 'unknown')).toBe('text');

    const arrayBuffer = Buffer.from('[1, 2, 3]');
    expect(detectDecompressedContentType(arrayBuffer, 'unknown')).toBe('text');
  });

  it('detects text by printable character ratio', () => {
    const textBuffer = Buffer.from('This is plain text content with only printable characters.\n');
    expect(detectDecompressedContentType(textBuffer, 'unknown')).toBe('text');
  });

  it('returns unknown for binary content', () => {
    const binaryBuffer = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xFF, 0xFE, 0xFD, 0xFC, 0x00, 0x00]);
    expect(detectDecompressedContentType(binaryBuffer, 'unknown')).toBe('unknown');
  });
});

// =============================================================================
// Unsupported File Suggestions Tests
// =============================================================================

describe('getUnsupportedFileSuggestion', () => {
  it('suggests PDF conversion for Word documents', () => {
    expect(getUnsupportedFileSuggestion(createMockFile({ name: 'doc.doc' }))).toContain('PDF');
    expect(getUnsupportedFileSuggestion(createMockFile({ name: 'doc.docx' }))).toContain('PDF');
    expect(getUnsupportedFileSuggestion(createMockFile({
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      name: 'file',
    }))).toContain('PDF');
  });

  it('suggests CSV export for Excel spreadsheets', () => {
    expect(getUnsupportedFileSuggestion(createMockFile({ name: 'data.xls' }))).toContain('CSV');
    expect(getUnsupportedFileSuggestion(createMockFile({ name: 'data.xlsx' }))).toContain('CSV');
  });

  it('suggests PDF conversion for PowerPoint', () => {
    expect(getUnsupportedFileSuggestion(createMockFile({ name: 'slides.ppt' }))).toContain('PDF');
    expect(getUnsupportedFileSuggestion(createMockFile({ name: 'slides.pptx' }))).toContain('PDF');
  });

  it('suggests extraction for unsupported archives (zip is now supported)', () => {
    // Zip is now supported, so no suggestion
    expect(getUnsupportedFileSuggestion(createMockFile({ name: 'archive.zip' }))).toBeUndefined();
    // Other archives still suggest extraction
    expect(getUnsupportedFileSuggestion(createMockFile({ name: 'archive.tar' }))).toContain('Extract');
    expect(getUnsupportedFileSuggestion(createMockFile({ name: 'archive.rar' }))).toContain('Extract');
  });

  it('says binary files not supported', () => {
    expect(getUnsupportedFileSuggestion(createMockFile({ name: 'program.exe' }))).toContain('not supported');
    expect(getUnsupportedFileSuggestion(createMockFile({ name: 'library.dll' }))).toContain('not supported');
  });

  it('returns undefined for unknown file types', () => {
    expect(getUnsupportedFileSuggestion(createMockFile({ name: 'unknown.xyz' }))).toBeUndefined();
  });
});

// =============================================================================
// processFiles Tests
// =============================================================================

describe('processFiles', () => {
  it('returns empty result for no files', async () => {
    const platform = createMockPlatform();
    const result = await processFiles(platform, undefined);

    expect(result.blocks).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it('returns empty result for empty files array', async () => {
    const platform = createMockPlatform();
    const result = await processFiles(platform, []);

    expect(result.blocks).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it('processes mixed file types', async () => {
    const platform = createMockPlatform();
    const files = [
      createMockFile({ id: '1', mimeType: 'image/jpeg', name: 'photo.jpg' }),
      createMockFile({ id: '2', mimeType: 'application/pdf', name: 'doc.pdf' }),
      createMockFile({ id: '3', mimeType: 'text/plain', name: 'readme.txt' }),
    ];

    const result = await processFiles(platform, files);

    expect(result.blocks).toHaveLength(3);
    expect(result.skipped).toHaveLength(0);
    expect(result.blocks.map(b => b.type)).toContain('image');
    expect(result.blocks.map(b => b.type)).toContain('document');
    expect(result.blocks.map(b => b.type)).toContain('text');
  });

  it('tracks skipped unsupported files', async () => {
    const platform = createMockPlatform();
    const files = [
      createMockFile({ id: '1', mimeType: 'text/plain', name: 'valid.txt' }),
      createMockFile({ id: '2', mimeType: 'application/msword', name: 'unsupported.doc' }),
    ];

    const result = await processFiles(platform, files);

    expect(result.blocks).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].name).toBe('unsupported.doc');
    expect(result.skipped[0].suggestion).toContain('PDF');
  });
});

// =============================================================================
// buildMessageContent Tests
// =============================================================================

describe('buildMessageContent', () => {
  it('returns plain text when no files provided', async () => {
    const platform = createMockPlatform();
    const result = await buildMessageContent('Hello, world!', platform, undefined);

    expect(result).toBe('Hello, world!');
  });

  it('returns plain text when files array is empty', async () => {
    const platform = createMockPlatform();
    const result = await buildMessageContent('Hello, world!', platform, []);

    expect(result).toBe('Hello, world!');
  });

  it('returns content blocks when files are provided', async () => {
    const platform = createMockPlatform();
    const files = [createMockFile({ mimeType: 'image/jpeg', name: 'photo.jpg' })];

    const result = await buildMessageContent('Check this image', platform, files);

    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result).toHaveLength(2); // image + text
      expect(result[0].type).toBe('image');
      expect(result[1].type).toBe('text');
      if (result[1].type === 'text') {
        expect(result[1].text).toBe('Check this image');
      }
    }
  });

  it('includes text block at end of content blocks', async () => {
    const platform = createMockPlatform();
    const files = [
      createMockFile({ id: '1', mimeType: 'image/jpeg', name: 'photo1.jpg' }),
      createMockFile({ id: '2', mimeType: 'image/png', name: 'photo2.png' }),
    ];

    const result = await buildMessageContent('Two images!', platform, files);

    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result).toHaveLength(3); // 2 images + text
      expect(result[result.length - 1].type).toBe('text');
    }
  });

  it('returns content blocks even without text message', async () => {
    const platform = createMockPlatform();
    const files = [createMockFile({ mimeType: 'image/jpeg', name: 'photo.jpg' })];

    const result = await buildMessageContent('', platform, files);

    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result).toHaveLength(1); // just the image
      expect(result[0].type).toBe('image');
    }
  });

  it('returns plain text when all files are skipped', async () => {
    const platform = createMockPlatform();
    const files = [createMockFile({ mimeType: 'application/msword', name: 'doc.doc' })];

    const result = await buildMessageContent('Message with unsupported file', platform, files);

    // When all files are skipped, we get plain text back
    expect(result).toBe('Message with unsupported file');
  });
});
