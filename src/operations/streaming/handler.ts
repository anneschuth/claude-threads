/**
 * Message streaming utilities
 *
 * Handles typing indicators and file attachments (images, PDFs, text files, compressed files).
 * Content flushing is now handled by MessageManager/ContentExecutor.
 */

import { gunzipSync } from 'zlib';
import yauzl from 'yauzl';
import type { PlatformClient, PlatformFile } from '../../platform/index.js';
import type { Session } from '../../session/types.js';
import type { ContentBlock } from '../../claude/cli.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('streaming');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum PDF file size (32MB as per Claude API limit) */
export const MAX_PDF_SIZE = 32 * 1024 * 1024;

/** Maximum text file size (1MB to avoid context overflow) */
export const MAX_TEXT_FILE_SIZE = 1 * 1024 * 1024;

/** Maximum decompressed file size (10MB safety limit) */
export const MAX_DECOMPRESSED_SIZE = 10 * 1024 * 1024;

/** Maximum zip file size (50MB to prevent abuse) */
export const MAX_ZIP_SIZE = 50 * 1024 * 1024;

/** Maximum number of files to extract from a zip (prevent zip bombs) */
export const MAX_ZIP_FILES = 20;

/** Supported image MIME types */
export const SUPPORTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;

/** Supported text file MIME types */
export const SUPPORTED_TEXT_TYPES = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/xml',
  'text/yaml',
  'text/x-yaml',
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
] as const;

/** Text file extensions (fallback when MIME type is generic) */
export const TEXT_FILE_EXTENSIONS = [
  '.txt', '.md', '.markdown', '.json', '.csv', '.xml', '.yaml', '.yml',
  '.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs', '.java',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.swift', '.kt', '.scala',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.sql', '.graphql', '.gql',
  '.toml', '.ini', '.cfg', '.conf', '.env', '.properties',
  '.dockerfile', '.gitignore', '.gitattributes', '.editorconfig',
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of processing a file */
export interface FileProcessingResult {
  /** Content blocks to send to Claude */
  blocks: ContentBlock[];
  /** Files that were skipped with reasons */
  skipped: SkippedFile[];
}

/** Information about a skipped file */
export interface SkippedFile {
  name: string;
  reason: string;
  suggestion?: string;
}

// ---------------------------------------------------------------------------
// File type detection
// ---------------------------------------------------------------------------

/**
 * Check if a file is a supported image type.
 */
export function isImageFile(file: PlatformFile): boolean {
  return (
    file.mimeType.startsWith('image/') &&
    (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(file.mimeType)
  );
}

/**
 * Check if a file is a PDF.
 */
export function isPdfFile(file: PlatformFile): boolean {
  return file.mimeType === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

/**
 * Check if a file is a text-based file.
 */
export function isTextFile(file: PlatformFile): boolean {
  // Check MIME type
  if ((SUPPORTED_TEXT_TYPES as readonly string[]).includes(file.mimeType)) {
    return true;
  }
  // Check extension as fallback (many platforms report generic MIME types)
  const lowerName = file.name.toLowerCase();
  return TEXT_FILE_EXTENSIONS.some(ext => lowerName.endsWith(ext));
}

/**
 * Check if a file is a gzip-compressed file.
 */
export function isGzipFile(file: PlatformFile): boolean {
  return (
    file.mimeType === 'application/gzip' ||
    file.mimeType === 'application/x-gzip' ||
    file.name.toLowerCase().endsWith('.gz')
  );
}

/**
 * Check if a file is a zip archive.
 */
export function isZipFile(file: PlatformFile): boolean {
  return (
    file.mimeType === 'application/zip' ||
    file.mimeType === 'application/x-zip-compressed' ||
    file.name.toLowerCase().endsWith('.zip')
  );
}

/**
 * Categorize a file by type.
 */
export function categorizeFile(file: PlatformFile): 'image' | 'pdf' | 'text' | 'gzip' | 'zip' | 'unsupported' {
  if (isImageFile(file)) return 'image';
  if (isPdfFile(file)) return 'pdf';
  if (isZipFile(file)) return 'zip';
  if (isGzipFile(file)) return 'gzip';
  if (isTextFile(file)) return 'text';
  return 'unsupported';
}

// ---------------------------------------------------------------------------
// File processing
// ---------------------------------------------------------------------------

/**
 * Process an image file into a content block.
 */
export async function processImageFile(
  file: PlatformFile,
  platform: PlatformClient,
  debug: boolean = false
): Promise<{ block?: ContentBlock; skipped?: SkippedFile }> {
  try {
    if (!platform.downloadFile) {
      return {
        skipped: {
          name: file.name,
          reason: 'Platform does not support file downloads',
        },
      };
    }

    const buffer = await platform.downloadFile(file.id);
    const base64 = buffer.toString('base64');

    if (debug) {
      log.debug(`Attached image: ${file.name} (${file.mimeType}, ${Math.round(buffer.length / 1024)}KB)`);
    }

    return {
      block: {
        type: 'image',
        source: {
          type: 'base64',
          media_type: file.mimeType,
          data: base64,
        },
      },
    };
  } catch (err) {
    log.error(`Failed to download image ${file.name}: ${err}`);
    return {
      skipped: {
        name: file.name,
        reason: `Download failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

/**
 * Process a PDF file into a document content block.
 */
export async function processPdfFile(
  file: PlatformFile,
  platform: PlatformClient,
  debug: boolean = false
): Promise<{ block?: ContentBlock; skipped?: SkippedFile }> {
  try {
    if (!platform.downloadFile) {
      return {
        skipped: {
          name: file.name,
          reason: 'Platform does not support file downloads',
        },
      };
    }

    const buffer = await platform.downloadFile(file.id);

    // Check size limit
    if (buffer.length > MAX_PDF_SIZE) {
      return {
        skipped: {
          name: file.name,
          reason: `PDF exceeds ${Math.round(MAX_PDF_SIZE / 1024 / 1024)}MB limit (${Math.round(buffer.length / 1024 / 1024)}MB)`,
          suggestion: 'Try splitting the PDF into smaller parts',
        },
      };
    }

    const base64 = buffer.toString('base64');

    if (debug) {
      log.debug(`Attached PDF: ${file.name} (${Math.round(buffer.length / 1024)}KB)`);
    }

    return {
      block: {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: base64,
        },
        title: file.name,
      },
    };
  } catch (err) {
    log.error(`Failed to process PDF ${file.name}: ${err}`);
    return {
      skipped: {
        name: file.name,
        reason: `Processing failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

/**
 * Process a text file into a text content block with filename header.
 */
export async function processTextFile(
  file: PlatformFile,
  platform: PlatformClient,
  debug: boolean = false
): Promise<{ block?: ContentBlock; skipped?: SkippedFile }> {
  try {
    if (!platform.downloadFile) {
      return {
        skipped: {
          name: file.name,
          reason: 'Platform does not support file downloads',
        },
      };
    }

    const buffer = await platform.downloadFile(file.id);

    // Check size limit
    if (buffer.length > MAX_TEXT_FILE_SIZE) {
      return {
        skipped: {
          name: file.name,
          reason: `File exceeds ${Math.round(MAX_TEXT_FILE_SIZE / 1024)}KB limit (${Math.round(buffer.length / 1024)}KB)`,
          suggestion: 'Try splitting the file or extracting relevant portions',
        },
      };
    }

    const content = buffer.toString('utf-8');

    if (debug) {
      log.debug(`Attached text file: ${file.name} (${Math.round(buffer.length / 1024)}KB)`);
    }

    // Wrap content with filename header
    const wrappedContent = formatTextFileContent(file.name, content);

    return {
      block: {
        type: 'text',
        text: wrappedContent,
      },
    };
  } catch (err) {
    log.error(`Failed to process text file ${file.name}: ${err}`);
    return {
      skipped: {
        name: file.name,
        reason: `Processing failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

/**
 * Format text file content with filename header.
 */
export function formatTextFileContent(filename: string, content: string): string {
  return `📄 **${filename}**:\n\`\`\`\n${content}\n\`\`\``;
}

/**
 * Process a gzip-compressed file.
 * Decompresses and processes based on the underlying content type.
 */
export async function processGzipFile(
  file: PlatformFile,
  platform: PlatformClient,
  debug: boolean = false
): Promise<{ block?: ContentBlock; skipped?: SkippedFile }> {
  try {
    if (!platform.downloadFile) {
      return {
        skipped: {
          name: file.name,
          reason: 'Platform does not support file downloads',
        },
      };
    }

    const compressedBuffer = await platform.downloadFile(file.id);

    // Decompress
    let decompressedBuffer: Buffer;
    try {
      decompressedBuffer = gunzipSync(compressedBuffer);
    } catch (err) {
      return {
        skipped: {
          name: file.name,
          reason: `Decompression failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }

    // Check decompressed size
    if (decompressedBuffer.length > MAX_DECOMPRESSED_SIZE) {
      return {
        skipped: {
          name: file.name,
          reason: `Decompressed size exceeds ${Math.round(MAX_DECOMPRESSED_SIZE / 1024 / 1024)}MB limit (${Math.round(decompressedBuffer.length / 1024 / 1024)}MB)`,
          suggestion: 'Try extracting only the relevant portions',
        },
      };
    }

    // Determine the inner filename (remove .gz extension)
    const innerFilename = file.name.toLowerCase().endsWith('.gz')
      ? file.name.slice(0, -3)
      : file.name;

    // Detect content type from decompressed data
    const contentType = detectDecompressedContentType(decompressedBuffer, innerFilename);

    if (debug) {
      log.debug(`Decompressed ${file.name}: ${Math.round(decompressedBuffer.length / 1024)}KB, detected type: ${contentType}`);
    }

    if (contentType === 'pdf') {
      // Process as PDF
      const base64 = decompressedBuffer.toString('base64');
      return {
        block: {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: base64,
          },
          title: innerFilename,
        },
      };
    } else if (contentType === 'text') {
      // Process as text file
      const content = decompressedBuffer.toString('utf-8');
      const wrappedContent = formatTextFileContent(innerFilename, content);
      return {
        block: {
          type: 'text',
          text: wrappedContent,
        },
      };
    } else {
      return {
        skipped: {
          name: file.name,
          reason: 'Decompressed content type not supported',
          suggestion: 'Only text-based files and PDFs are supported after decompression',
        },
      };
    }
  } catch (err) {
    log.error(`Failed to process gzip file ${file.name}: ${err}`);
    return {
      skipped: {
        name: file.name,
        reason: `Processing failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

/**
 * Extract a single file entry from a zip archive.
 */
async function extractZipEntry(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, readStream) => {
      if (err) {
        reject(err);
        return;
      }
      if (!readStream) {
        reject(new Error('No read stream'));
        return;
      }
      const chunks: Buffer[] = [];
      readStream.on('data', (chunk: Buffer) => chunks.push(chunk));
      readStream.on('end', () => resolve(Buffer.concat(chunks)));
      readStream.on('error', reject);
    });
  });
}

/**
 * Process a zip archive file.
 * Extracts supported files and processes each one.
 */
export async function processZipFile(
  file: PlatformFile,
  platform: PlatformClient,
  debug: boolean = false
): Promise<{ blocks: ContentBlock[]; skipped: SkippedFile[] }> {
  const blocks: ContentBlock[] = [];
  const skipped: SkippedFile[] = [];

  try {
    // Check if platform supports file downloads
    if (!platform.downloadFile) {
      return {
        blocks: [],
        skipped: [{
          name: file.name,
          reason: 'Platform does not support file downloads',
        }],
      };
    }

    // Check file size first
    if (file.size && file.size > MAX_ZIP_SIZE) {
      return {
        blocks: [],
        skipped: [{
          name: file.name,
          reason: `Zip file exceeds ${Math.round(MAX_ZIP_SIZE / 1024 / 1024)}MB limit (${Math.round(file.size / 1024 / 1024)}MB)`,
        }],
      };
    }

    // Download the zip file
    const zipBuffer = await platform.downloadFile(file.id);

    if (debug) {
      log.debug(`Processing zip file ${file.name}: ${Math.round(zipBuffer.length / 1024)}KB`);
    }

    // Open zip file from buffer
    const zipfile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
      yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (err, zf) => {
        if (err) reject(err);
        else if (!zf) reject(new Error('Failed to open zip file'));
        else resolve(zf);
      });
    });

    // Collect all entries first
    const entries: yauzl.Entry[] = [];
    await new Promise<void>((resolve, reject) => {
      zipfile.on('entry', (entry: yauzl.Entry) => {
        // Skip directories
        if (!entry.fileName.endsWith('/')) {
          entries.push(entry);
        }
        zipfile.readEntry();
      });
      zipfile.on('end', resolve);
      zipfile.on('error', reject);
      zipfile.readEntry();
    });

    // Check number of files
    if (entries.length > MAX_ZIP_FILES) {
      zipfile.close();
      return {
        blocks: [],
        skipped: [{
          name: file.name,
          reason: `Zip contains too many files (${entries.length}). Maximum is ${MAX_ZIP_FILES} files.`,
          suggestion: 'Extract and upload the most relevant files individually',
        }],
      };
    }

    if (entries.length === 0) {
      zipfile.close();
      return {
        blocks: [],
        skipped: [{
          name: file.name,
          reason: 'Zip archive is empty',
        }],
      };
    }

    // Re-open to process entries (yauzl is forward-only)
    const zipfile2 = await new Promise<yauzl.ZipFile>((resolve, reject) => {
      yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (err, zf) => {
        if (err) reject(err);
        else if (!zf) reject(new Error('Failed to open zip file'));
        else resolve(zf);
      });
    });

    // Process each entry
    let processedCount = 0;
    await new Promise<void>((resolve, reject) => {
      zipfile2.on('entry', async (entry: yauzl.Entry) => {
        try {
          // Skip directories
          if (entry.fileName.endsWith('/')) {
            zipfile2.readEntry();
            return;
          }

          // Check decompressed size
          if (entry.uncompressedSize > MAX_DECOMPRESSED_SIZE) {
            skipped.push({
              name: entry.fileName,
              reason: `File exceeds ${Math.round(MAX_DECOMPRESSED_SIZE / 1024 / 1024)}MB decompressed size limit`,
            });
            zipfile2.readEntry();
            return;
          }

          // Extract the file
          const buffer = await extractZipEntry(zipfile2, entry);
          const contentType = detectDecompressedContentType(buffer, entry.fileName);

          if (debug) {
            log.debug(`Extracted ${entry.fileName}: ${Math.round(buffer.length / 1024)}KB, type: ${contentType}`);
          }

          if (contentType === 'pdf') {
            const base64 = buffer.toString('base64');
            blocks.push({
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: base64,
              },
            });
            processedCount++;
          } else if (contentType === 'text') {
            const content = buffer.toString('utf-8');
            const wrappedContent = formatTextFileContent(entry.fileName, content);
            blocks.push({
              type: 'text',
              text: wrappedContent,
            });
            processedCount++;
          } else {
            skipped.push({
              name: entry.fileName,
              reason: 'Unsupported file type inside zip',
              suggestion: 'Only text-based files and PDFs are supported',
            });
          }

          zipfile2.readEntry();
        } catch (err) {
          skipped.push({
            name: entry.fileName,
            reason: `Failed to extract: ${err instanceof Error ? err.message : String(err)}`,
          });
          zipfile2.readEntry();
        }
      });
      zipfile2.on('end', resolve);
      zipfile2.on('error', reject);
      zipfile2.readEntry();
    });

    zipfile2.close();

    if (debug) {
      log.debug(`Zip ${file.name}: processed ${processedCount} files, skipped ${skipped.length}`);
    }

    return { blocks, skipped };
  } catch (err) {
    log.error(`Failed to process zip file ${file.name}: ${err}`);
    return {
      blocks: [],
      skipped: [{
        name: file.name,
        reason: `Failed to process zip: ${err instanceof Error ? err.message : String(err)}`,
      }],
    };
  }
}

/**
 * Detect the content type of decompressed data.
 */
export function detectDecompressedContentType(
  buffer: Buffer,
  filename: string
): 'pdf' | 'text' | 'unknown' {
  // Check for PDF magic bytes (%PDF-)
  if (buffer.length >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-') {
    return 'pdf';
  }

  // Check filename extension
  const lowerFilename = filename.toLowerCase();
  if (lowerFilename.endsWith('.pdf')) {
    return 'pdf';
  }

  // Check if it's a text-based file by extension
  if (TEXT_FILE_EXTENSIONS.some(ext => lowerFilename.endsWith(ext))) {
    return 'text';
  }

  // Try to detect JSON (common for profiler traces)
  if (buffer.length > 0) {
    const firstChar = String.fromCharCode(buffer[0]);
    if (firstChar === '{' || firstChar === '[') {
      // Likely JSON
      return 'text';
    }
  }

  // Check if the content is valid UTF-8 text
  try {
    const text = buffer.toString('utf-8');
    // If it contains mostly printable characters, treat as text
    const printableRatio = countPrintableChars(text) / text.length;
    if (printableRatio > 0.9) {
      return 'text';
    }
  } catch {
    // Not valid UTF-8
  }

  return 'unknown';
}

/**
 * Count printable characters in a string.
 */
function countPrintableChars(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Printable ASCII (32-126), tabs, newlines, carriage returns
    if ((code >= 32 && code <= 126) || code === 9 || code === 10 || code === 13) {
      count++;
    }
  }
  return count;
}

/**
 * Get a suggestion for an unsupported file type.
 */
export function getUnsupportedFileSuggestion(file: PlatformFile): string | undefined {
  const ext = file.name.toLowerCase().split('.').pop();
  const mime = file.mimeType.toLowerCase();

  // Word documents
  if (ext === 'doc' || ext === 'docx' || mime.includes('msword') || mime.includes('wordprocessingml')) {
    return 'Convert to PDF for best results';
  }

  // Excel spreadsheets
  if (ext === 'xls' || ext === 'xlsx' || mime.includes('spreadsheet')) {
    return 'Export as CSV for text-based analysis';
  }

  // PowerPoint
  if (ext === 'ppt' || ext === 'pptx' || mime.includes('presentation')) {
    return 'Convert to PDF for best results';
  }

  // Archives (zip is supported, others are not)
  if (ext === 'tar' || ext === 'rar' || ext === '7z') {
    return 'Extract files and upload them individually, or use .zip format';
  }

  // Binary/executable
  if (ext === 'exe' || ext === 'dll' || ext === 'so' || ext === 'dylib') {
    return 'Binary files are not supported';
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Message content building
// ---------------------------------------------------------------------------

/**
 * Build message content for Claude, including files if present.
 * Returns either a string or an array of content blocks.
 *
 * Supports:
 * - Images (JPEG, PNG, GIF, WebP)
 * - PDFs (via document content blocks)
 * - Text files (txt, md, json, csv, xml, yaml, source code)
 * - Gzip-compressed files (decompressed and processed based on content)
 * - Zip archives (extracts and processes supported files inside)
 */
export async function buildMessageContent(
  text: string,
  platform: PlatformClient,
  files?: PlatformFile[],
  debug: boolean = false
): Promise<string | ContentBlock[]> {
  const result = await processFiles(platform, files, debug);

  // If no files were processed, return plain text
  if (result.blocks.length === 0) {
    return text;
  }

  // Add the text message at the end if present
  if (text) {
    result.blocks.push({
      type: 'text',
      text,
    });
  }

  return result.blocks;
}

/**
 * Process all files and return content blocks and skipped files.
 * Exported separately for use by MessageManager for user feedback.
 */
export async function processFiles(
  platform: PlatformClient,
  files?: PlatformFile[],
  debug: boolean = false
): Promise<FileProcessingResult> {
  const blocks: ContentBlock[] = [];
  const skipped: SkippedFile[] = [];

  if (!files || files.length === 0) {
    return { blocks, skipped };
  }

  for (const file of files) {
    const category = categorizeFile(file);

    // Zip files return multiple blocks, handle separately
    if (category === 'zip') {
      const zipResult = await processZipFile(file, platform, debug);
      blocks.push(...zipResult.blocks);
      for (const s of zipResult.skipped) {
        skipped.push(s);
        log.warn(`Skipped file ${s.name}: ${s.reason}`);
      }
      continue;
    }

    let result: { block?: ContentBlock; skipped?: SkippedFile };

    switch (category) {
      case 'image':
        result = await processImageFile(file, platform, debug);
        break;
      case 'pdf':
        result = await processPdfFile(file, platform, debug);
        break;
      case 'text':
        result = await processTextFile(file, platform, debug);
        break;
      case 'gzip':
        result = await processGzipFile(file, platform, debug);
        break;
      case 'unsupported':
      default:
        result = {
          skipped: {
            name: file.name,
            reason: `Unsupported file type: ${file.mimeType}`,
            suggestion: getUnsupportedFileSuggestion(file),
          },
        };
        break;
    }

    if (result.block) {
      blocks.push(result.block);
    }
    if (result.skipped) {
      skipped.push(result.skipped);
      log.warn(`Skipped file ${result.skipped.name}: ${result.skipped.reason}`);
    }
  }

  return { blocks, skipped };
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
